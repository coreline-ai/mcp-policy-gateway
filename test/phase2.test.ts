import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/storage/db";
import { migrate } from "../src/storage/migrate";
import { registerTarget, TargetRegistrationError } from "../src/targets/registry";
import { normalizeTools, observationHash } from "../src/catalog/normalize";
import {
  observeTarget,
  getLatestObservation,
  markListChanged,
  snapshotCallable,
} from "../src/catalog/snapshot";
import { StdioTargetAdapter } from "../src/catalog/stdio-adapter";
import { handleToolCall, type ToolCtx } from "../src/upstream/tools";
import type { GatewayConfig } from "../src/config/load-config";
import type { TargetAdapter, TargetSession, ToolPage } from "../src/catalog/target-adapter";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const cfg: GatewayConfig = {
  tenantId: "t1",
  clientId: "c1",
  actorId: "a1",
  dbPath: ":memory:",
  hmacSecret: "test-secret",
  executableAllowlist: ["fake", TSX_BIN],
  toolSurfaceMode: "operator",
  stdioEnvKeys: ["PATH"],
  egress: { allowedSchemes: ["https"], allowPrivate: false },
};

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});

/** Register a fake stdio target and return its id + spec (FK-valid for observations). */
function mkTarget(): { id: string; spec: { command: string } } {
  const id = registerTarget(db, cfg, { name: "fake", kind: "stdio", command: { command: "fake" } });
  return { id, spec: { command: "fake" } };
}

// A fake adapter that replays a fixed list of pages; can fail at a given page index.
class FakeAdapter implements TargetAdapter {
  constructor(private pages: ToolPage[], private failAtPage?: number) {}
  async open(): Promise<TargetSession> {
    return { info: { name: "fake", version: "0" } };
  }
  async listToolsPage(_s: TargetSession, cursor?: string): Promise<ToolPage> {
    const idx = cursor ? Number(cursor) : 0;
    if (this.failAtPage === idx) throw new Error(`page ${idx} failed`);
    const page = this.pages[idx];
    if (!page) throw new Error(`no page ${idx}`);
    return page;
  }
  async callTool(): Promise<{ content: unknown }> {
    return { content: [] };
  }
  async close(): Promise<void> {}
}

describe("normalization + hashing", () => {
  it("is order-independent and default-stable", () => {
    const a = normalizeTools([
      { name: "b.get", description: "g" },
      { name: "a.list", inputSchema: { type: "object" } },
    ]);
    const b = normalizeTools([
      { name: "a.list", inputSchema: { type: "object" } },
      { name: "b.get", description: "g" },
    ]);
    expect(observationHash("s", "t1", a)).toBe(observationHash("s", "t1", b));
  });

  it("changes when a tool's schema changes", () => {
    const a = normalizeTools([{ name: "x", inputSchema: { type: "object" } }]);
    const b = normalizeTools([{ name: "x", inputSchema: { type: "string" } }]);
    expect(observationHash("s", "t1", a)).not.toBe(observationHash("s", "t1", b));
  });
});

describe("observeTarget pagination", () => {
  it("collects all pages -> complete", async () => {
    const target = mkTarget();
    const adapter = new FakeAdapter([
      { tools: [{ name: "a" }], nextCursor: "1" },
      { tools: [{ name: "b" }] },
    ]);
    const res = await observeTarget(db, cfg, target, adapter);
    expect(res.completeness).toBe("complete");
    expect(res.toolCount).toBe(2);
    expect(snapshotCallable(getLatestObservation(db, target.id))).toBe(true);
  });

  it("mid-collection failure -> incomplete + not callable (fail-closed)", async () => {
    const target = mkTarget();
    const adapter = new FakeAdapter(
      [{ tools: [{ name: "a" }], nextCursor: "1" }],
      1, // page 1 throws
    );
    const res = await observeTarget(db, cfg, target, adapter);
    expect(res.completeness).toBe("incomplete");
    expect(res.toolCount).toBe(1); // page 0 tools were still collected
    expect(snapshotCallable(getLatestObservation(db, target.id))).toBe(false);
  });

  it("same observed tools -> same normalized_hash across observations", async () => {
    const target = mkTarget();
    const h1 = (await observeTarget(db, cfg, target, new FakeAdapter([{ tools: [{ name: "a" }, { name: "b" }] }]))).normalizedHash;
    const h2 = (await observeTarget(db, cfg, target, new FakeAdapter([{ tools: [{ name: "b" }, { name: "a" }] }]))).normalizedHash;
    expect(h1).toBe(h2);
  });
});

describe("snapshotCallable / list_changed", () => {
  it("fail-closed on missing, incomplete, and stale snapshots", async () => {
    expect(snapshotCallable(undefined)).toBe(false);
    const target = mkTarget();
    await observeTarget(db, cfg, target, new FakeAdapter([{ tools: [{ name: "a" }] }]));
    expect(snapshotCallable(getLatestObservation(db, target.id))).toBe(true);
    markListChanged(db, target.id);
    expect(snapshotCallable(getLatestObservation(db, target.id))).toBe(false);
  });
});

describe("registry executable allowlist (ADR-012)", () => {
  it("rejects a stdio command not in a non-empty allowlist", () => {
    expect(() =>
      registerTarget(
        db,
        { tenantId: "t1", executableAllowlist: ["/usr/bin/node"] },
        { name: "bad", kind: "stdio", command: { command: "curl" } },
      ),
    ).toThrow(TargetRegistrationError);
  });

  it("allows an allowlisted command", () => {
    const id = registerTarget(
      db,
      { tenantId: "t1", executableAllowlist: ["/usr/bin/node"] },
      { name: "ok", kind: "stdio", command: { command: "/usr/bin/node" } },
    );
    expect(id).toBeTruthy();
  });
});

describe("integration: real stdio target (safe-notes-mcp)", () => {
  it("rescan collects a complete snapshot; inspect surfaces the tools", async () => {
    const sample = path.join(ROOT, "sample-targets", "safe-notes-mcp", "index.ts");
    const targetId = registerTarget(db, cfg, {
      name: "Safe Notes",
      kind: "stdio",
      command: { command: TSX_BIN, args: [sample], cwd: ROOT },
    });

    const ctx: ToolCtx = { db, cfg, adapter: new StdioTargetAdapter() };

    const rescan = await handleToolCall("gateway_rescan_target", { targetId }, ctx);
    const rbody = JSON.parse(rescan.content[0]!.text!);
    expect(rbody.completeness).toBe("complete");
    expect(rbody.toolCount).toBe(3);

    const inspect = await handleToolCall("gateway_inspect_target", { targetId }, ctx);
    const ibody = JSON.parse(inspect.content[0]!.text!);
    expect(ibody.callable).toBe(true);
    const names = ibody.tools.map((t: { targetTool: string }) => t.targetTool);
    expect(names).toContain("notes.list");
    expect(names).toContain("notes.get");
    expect(names).toContain("notes.search");
  }, 30000);
});
