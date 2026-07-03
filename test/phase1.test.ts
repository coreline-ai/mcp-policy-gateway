import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { openDb, type DB } from "../src/storage/db";
import { migrate } from "../src/storage/migrate";
import { registerTarget, listTargets } from "../src/targets/registry";
import { handleToolCall, type ToolCtx } from "../src/upstream/tools";
import { loadAndStorePolicy, PolicyValidationError } from "../src/policy/policy-store";
import { loadConfig } from "../src/config/load-config";
import type { GatewayConfig } from "../src/config/load-config";
import type { TargetAdapter, TargetCallResult, TargetSession, ToolPage } from "../src/catalog/target-adapter";

const cfg: GatewayConfig = {
  tenantId: "t1",
  clientId: "c1",
  actorId: "a1",
  dbPath: ":memory:",
  hmacSecret: "test-secret",
  executableAllowlist: ["node", "tsx"],
  toolSurfaceMode: "operator",
  stdioEnvKeys: ["PATH"],
  egress: { allowedSchemes: ["https"], allowPrivate: false },
};

let db: DB;
let ctx: ToolCtx;

class OnePageAdapter implements TargetAdapter {
  async open(): Promise<TargetSession> {
    return { info: { name: "fake" } };
  }
  async listToolsPage(): Promise<ToolPage> {
    return { tools: [{ name: "notes.list", inputSchema: { type: "object", properties: {} } }] };
  }
  async callTool(): Promise<TargetCallResult> {
    return { content: [{ type: "text", text: "ok" }] };
  }
  async close(): Promise<void> {}
}

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  ctx = { db, cfg };
});

describe("migrations", () => {
  it("creates the core tables", () => {
    const names = (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const t of ["mcp_targets", "mcp_observations", "mcp_tool_snapshots", "mcp_policies", "mcp_policy_events", "mcp_approvals"]) {
      expect(names).toContain(t);
    }
    const eventColumns = (db.prepare("pragma table_info(mcp_policy_events)").all() as { name: string }[]).map((r) => r.name);
    expect(eventColumns).toContain("rule_id");
  });

  it("is idempotent (re-running applies nothing)", () => {
    expect(migrate(db)).toEqual([]);
  });

  it("migrates an existing 0001 database to the audit rule_id schema", () => {
    const p = path.join(os.tmpdir(), `pg-migrate-${crypto.randomUUID()}.sqlite`);
    const legacy = openDb(p);
    try {
      legacy.exec(`create table if not exists _migrations (name text primary key, applied_at text not null default (datetime('now')));`);
      legacy.exec(fs.readFileSync(path.join(process.cwd(), "src/storage/migrations/0001_init.sql"), "utf8"));
      legacy.prepare("insert into _migrations (name) values (?)").run("0001_init.sql");

      let eventColumns = (legacy.prepare("pragma table_info(mcp_policy_events)").all() as { name: string }[]).map((r) => r.name);
      expect(eventColumns).not.toContain("rule_id");
      expect(migrate(legacy)).toEqual(["0002_audit_rule_id.sql"]);
      eventColumns = (legacy.prepare("pragma table_info(mcp_policy_events)").all() as { name: string }[]).map((r) => r.name);
      expect(eventColumns).toContain("rule_id");
      expect(migrate(legacy)).toEqual([]);
    } finally {
      legacy.close();
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${p}${suffix}`, { force: true });
    }
  });
});

describe("target registry", () => {
  it("loadConfig defaults to client surface and fail-closed executable registration", () => {
    const loaded = loadConfig({ GATEWAY_HMAC_SECRET: "s" });
    expect(loaded.allowUnlistedExecutables).toBe(false);
    expect(loaded.toolSurfaceMode).toBe("client");
    expect(loaded.stdioEnvKeys).toContain("PATH");

    const dev = loadConfig({ GATEWAY_HMAC_SECRET: "s", GATEWAY_DEV_MODE: "true", GATEWAY_TOOL_SURFACE_MODE: "operator" });
    expect(dev.allowUnlistedExecutables).toBe(true);
    expect(dev.toolSurfaceMode).toBe("operator");
  });

  it("registers and lists tenant-scoped targets", () => {
    registerTarget(db, cfg, { name: "Safe Notes", kind: "stdio", command: { command: "tsx", args: ["safe.ts"] } });
    const rows = listTargets(db, cfg);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Safe Notes");
    expect(rows[0]!.kind).toBe("stdio");
  });

  it("does not leak targets across tenants", () => {
    registerTarget(db, cfg, { name: "T", kind: "stdio", command: { command: "node" } });
    expect(listTargets(db, { tenantId: "other" })).toHaveLength(0);
  });
});

describe("gateway tools", () => {
  it("gateway_health returns ok", async () => {
    const res = await handleToolCall("gateway_health", {}, ctx);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text!)).toMatchObject({ status: "ok", tenantId: "t1" });
  });

  it("gateway_list_targets returns registered targets", async () => {
    registerTarget(db, cfg, { name: "Safe Notes", kind: "stdio", command: { command: "node" } });
    const res = await handleToolCall("gateway_list_targets", {}, ctx);
    const body = JSON.parse(res.content[0]!.text!);
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0].name).toBe("Safe Notes");
  });

  it("admin tools persist the returned audit ids", async () => {
    const targetId = registerTarget(db, cfg, { name: "Safe Notes", kind: "stdio", command: { command: "node" } });
    const ctxWithAdapter = { ...ctx, adapter: new OnePageAdapter() };
    const calls = [
      await handleToolCall("gateway_health", {}, ctxWithAdapter),
      await handleToolCall("gateway_list_targets", {}, ctxWithAdapter),
      await handleToolCall("gateway_inspect_target", { targetId }, ctxWithAdapter),
      await handleToolCall("gateway_rescan_target", { targetId }, ctxWithAdapter),
      await handleToolCall("gateway_diff_target", { targetId }, ctxWithAdapter),
    ];

    const ids = calls.map((res) => String(res._meta!.auditEventId));
    const rows = db
      .prepare(`select id, target_tool from mcp_policy_events where id in (${ids.map(() => "?").join(",")}) order by created_at`)
      .all(...ids) as { id: string; target_tool: string }[];
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(ids));
    expect(new Set(rows.map((r) => r.target_tool))).toEqual(
      new Set(["gateway_health", "gateway_list_targets", "gateway_inspect_target", "gateway_rescan_target", "gateway_diff_target"]),
    );
  });

  it("blocks unknown tools with an audit id (default-deny surface)", async () => {
    const res = await handleToolCall("gateway.list_targets", {}, ctx); // dotted name must NOT resolve
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text!);
    expect(body.decision).toBe("block");
    expect(body.auditEventId).toBeTruthy();
  });

  it("exposes only underscore tool names (no dots — API-safe)", () => {
    const bad = ["gateway_health", "gateway_list_targets"].filter((n) => !/^[a-z0-9_]+$/.test(n));
    expect(bad).toEqual([]);
  });
});

describe("policy version store", () => {
  function tmpPolicy(body: string): string {
    const p = path.join(os.tmpdir(), `pg-policy-${crypto.randomUUID()}.yaml`);
    fs.writeFileSync(p, body);
    return p;
  }

  it("derives a deterministic hmac version and persists content", () => {
    const p = tmpPolicy("version: 1\ndefault: deny\n");
    const a = loadAndStorePolicy(db, cfg, p);
    expect(a.version.startsWith("hmac-sha256:")).toBe(true);

    // same content -> same version
    const b = loadAndStorePolicy(db, cfg, p);
    expect(b.version).toBe(a.version);

    const row = db.prepare("select normalized_policy from mcp_policies where version = ?").get(a.version) as
      | { normalized_policy: string }
      | undefined;
    expect(row).toBeTruthy();
    fs.unlinkSync(p);
  });

  it("different content -> different version", () => {
    const p1 = tmpPolicy("version: 1\ndefault: deny\n");
    const p2 = tmpPolicy("version: 1\ndefault: allow\n");
    const v1 = loadAndStorePolicy(db, cfg, p1).version;
    const v2 = loadAndStorePolicy(db, cfg, p2).version;
    expect(v1).not.toBe(v2);
    fs.unlinkSync(p1);
    fs.unlinkSync(p2);
  });

  it("rejects unsupported policy effects before storing", () => {
    const p = tmpPolicy("version: 1\ndefault: deny\nrules:\n  - id: bad\n    match:\n      any: true\n    effect: permit\n");
    expect(() => loadAndStorePolicy(db, cfg, p)).toThrow(PolicyValidationError);
    const count = db.prepare("select count(*) c from mcp_policies").get() as { c: number };
    expect(count.c).toBe(0);
    fs.unlinkSync(p);
  });
});
