import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { openDb, type DB } from "../src/storage/db";
import { migrate } from "../src/storage/migrate";
import { registerTarget } from "../src/targets/registry";
import { TargetSessionManager } from "../src/targets/session-manager";
import { observeTarget } from "../src/catalog/snapshot";
import { PolicyEngine, PolicyValidationError, type PolicyDoc } from "../src/policy/engine";
import { storePolicyContent } from "../src/policy/policy-store";
import { GatewayRuntime } from "../src/upstream/gateway";
import { StdioTargetAdapter } from "../src/catalog/stdio-adapter";
import type { GatewayConfig } from "../src/config/load-config";
import type {
  TargetAdapter,
  TargetSession,
  ToolPage,
  TargetCallResult,
  TargetSpawnSpec,
} from "../src/catalog/target-adapter";

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

const POLICY = parseYaml(fs.readFileSync(path.join(ROOT, "examples/policies/local-dev.yaml"), "utf8")) as PolicyDoc;

const RISKY_TOOLS: ToolPage = {
  tools: [
    { name: "actions.list_runs" },
    {
      name: "actions.apply_profile",
      inputSchema: { type: "object", properties: { profileId: { type: "string" }, dryRun: { type: "boolean" } }, required: ["profileId"] },
    },
    { name: "actions.delete_all" },
  ],
};

class FakeAdapter implements TargetAdapter {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  constructor(private pages: ToolPage[], private opts: { failAtPage?: number; listChangedOnOpen?: boolean } = {}) {}
  async open(_spec: TargetSpawnSpec, onListChanged?: () => void): Promise<TargetSession> {
    if (this.opts.listChangedOnOpen) onListChanged?.();
    return { info: { name: "fake" } };
  }
  async listToolsPage(_s: TargetSession, cursor?: string): Promise<ToolPage> {
    const i = cursor ? Number(cursor) : 0;
    if (this.opts.failAtPage === i) throw new Error("page fail");
    const p = this.pages[i];
    if (!p) throw new Error("no page");
    return p;
  }
  async callTool(_s: TargetSession, name: string, args: Record<string, unknown>): Promise<TargetCallResult> {
    this.calls.push({ name, args });
    return { content: [{ type: "text", text: `called ${name}` }] };
  }
  async close(): Promise<void> {}
}

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});

describe("policy engine", () => {
  it("default deny hides tools and blocks calls when no rule matches", () => {
    const e = new PolicyEngine({ default: "deny", rules: [] });
    expect(e.evaluateCall("X", "anything").type).toBe("block");
    const list = e.evaluateList("X", [{ name: "a" }]);
    expect(list[0]!.kind).toBe("hidden");
  });

  it("exposes readonly (allow) and preview (limited_alias); hides delete; gates direct apply", () => {
    const e = new PolicyEngine(POLICY);
    const list = e.evaluateList("Risky Actions", RISKY_TOOLS.tools);
    const byTool = Object.fromEntries(list.map((d) => [d.targetTool, d]));

    expect(byTool["actions.list_runs"]!.kind).toBe("expose");
    const apply = byTool["actions.apply_profile"]!;
    expect(apply.kind).toBe("expose");
    if (apply.kind === "expose") {
      expect(apply.effect).toBe("limited_alias");
      expect(apply.exposedName).toBe("risky_actions__preview_profile");
      expect(apply.inject).toEqual({ dryRun: true });
    }
    expect(byTool["actions.delete_all"]!.kind).toBe("hidden");

    // direct real-name calls: readonly allowed, apply gated, delete denied
    expect(e.evaluateCall("Risky Actions", "actions.list_runs").type).toBe("allow");
    expect(e.evaluateCall("Risky Actions", "actions.apply_profile").type).toBe("approval_required");
    expect(e.evaluateCall("Risky Actions", "actions.delete_all").type).toBe("block");
  });

  it("exposed names are API-safe (no dots) and use the __ grammar", () => {
    const e = new PolicyEngine(POLICY);
    for (const d of e.evaluateList("Risky Actions", RISKY_TOOLS.tools)) {
      if (d.kind === "expose") expect(d.exposedName).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("honors match.any catch-all block rules even when default is allow", () => {
    const e = new PolicyEngine({
      default: "allow",
      rules: [{ id: "emergency-stop", match: { any: true }, effect: "block" }],
    });
    expect(e.evaluateCall("Risky Actions", "actions.list_runs")).toMatchObject({ type: "block", ruleId: "emergency-stop" });
    expect(e.evaluateList("Risky Actions", [{ name: "actions.list_runs" }])[0]).toMatchObject({ kind: "hidden" });
  });

  it("prioritizes explicit block and approval rules over a broad allow", () => {
    const e = new PolicyEngine({
      default: "deny",
      rules: [
        { id: "allow-all", match: { any: true }, effect: "allow" },
        { id: "approve-apply", match: { target: "Risky Actions", tool: "actions.apply_profile" }, effect: "approval_required" },
        { id: "deny-delete", match: { target: "Risky Actions", tool: "actions.delete_all" }, effect: "block" },
      ],
    });
    expect(e.evaluateCall("Risky Actions", "actions.apply_profile")).toMatchObject({ type: "approval_required", ruleId: "approve-apply" });
    expect(e.evaluateCall("Risky Actions", "actions.delete_all")).toMatchObject({ type: "block", ruleId: "deny-delete" });
  });

  it("default-deny example policy hides and blocks every target tool", () => {
    const defaultDeny = parseYaml(fs.readFileSync(path.join(ROOT, "examples/policies/default-deny.yaml"), "utf8")) as PolicyDoc;
    const e = new PolicyEngine(defaultDeny);
    expect(e.evaluateCall("Risky Actions", "actions.list_runs")).toMatchObject({ type: "block", ruleId: "deny-unknown" });
    expect(e.evaluateList("Risky Actions", RISKY_TOOLS.tools).every((d) => d.kind === "hidden")).toBe(true);
  });

  it("rejects unsupported effects and invalid matchers instead of silently ignoring them", () => {
    expect(() =>
      new PolicyEngine({
        default: "deny",
        rules: [{ id: "bad-effect", match: { any: true }, effect: "permit" as "allow" }],
      }),
    ).toThrow(PolicyValidationError);
    expect(() =>
      new PolicyEngine({
        default: "deny",
        rules: [{ id: "empty-match", match: {}, effect: "allow" }],
      }),
    ).toThrow(PolicyValidationError);
    expect(() =>
      new PolicyEngine({
        default: "deny",
        rules: [{ id: "bad-regex", match: { toolNameRegex: "[" }, effect: "allow" }],
      }),
    ).toThrow(PolicyValidationError);
  });

  it("supports a minimal deterministic rewrite decision", () => {
    const e = new PolicyEngine({
      default: "deny",
      rules: [
        {
          id: "force-dry-run",
          match: { target: "Risky Actions", tool: "actions.apply_profile" },
          effect: "rewrite",
          rewrite: { injectArguments: { dryRun: true }, hideArguments: ["dryRun"] },
        },
      ],
    });
    expect(e.evaluateCall("Risky Actions", "actions.apply_profile")).toMatchObject({
      type: "rewrite",
      ruleId: "force-dry-run",
      rewrite: { injectArguments: { dryRun: true }, hideArguments: ["dryRun"] },
    });
    expect(e.evaluateList("Risky Actions", RISKY_TOOLS.tools)[1]).toMatchObject({
      kind: "expose",
      effect: "rewrite",
      targetTool: "actions.apply_profile",
    });
  });
});

function runtimeWith(adapter: FakeAdapter): { runtime: GatewayRuntime; targetId: string } {
  const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
  const version = storePolicyContent(db, cfg, POLICY);
  const sessions = new TargetSessionManager(db, adapter);
  const engine = new PolicyEngine(POLICY);
  return { runtime: new GatewayRuntime(db, cfg, engine, sessions, adapter, version), targetId };
}

describe("filtered tools/list + call-time enforcement", () => {
  it("upstream tools/list exposes only allowed tools + aliases (no hidden real names)", async () => {
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const { runtime, targetId } = runtimeWith(adapter);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);

    const names = runtime.listTools().map((t) => t.name);
    expect(names).toContain("risky_actions__actions_list_runs");
    expect(names).toContain("risky_actions__preview_profile");
    expect(names).toContain("gateway_call_tool");
    expect(names.some((n) => n.includes("apply_profile"))).toBe(false);
    expect(names.some((n) => n.includes("delete"))).toBe(false);
    expect(names.every((n) => !n.includes("."))).toBe(true);
  });

  it("gateway_list_exposed_tools reports the same filtered alias surface", async () => {
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const { runtime, targetId } = runtimeWith(adapter);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);

    const res = await runtime.dispatch("gateway_list_exposed_tools", {});
    const body = JSON.parse(res.content[0]!.text!);
    const exposed = body.exposedTools.map((t: { exposedName: string }) => t.exposedName);
    expect(exposed).toContain("risky_actions__actions_list_runs");
    expect(exposed).toContain("risky_actions__preview_profile");
    expect(exposed.some((n: string) => n.includes("delete"))).toBe(false);
  });

  it("allow alias forwards to the target", async () => {
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const { runtime, targetId } = runtimeWith(adapter);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);

    const res = await runtime.dispatch("risky_actions__actions_list_runs", {});
    expect(res.isError).toBeFalsy();
    expect(adapter.calls.map((c) => c.name)).toContain("actions.list_runs");
  });

  it("limited alias injects dryRun:true for the allowed caller args", async () => {
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const { runtime, targetId } = runtimeWith(adapter);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);

    await runtime.dispatch("risky_actions__preview_profile", { profileId: "night" });
    const applyCalls = adapter.calls.filter((c) => c.name === "actions.apply_profile");
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.args.dryRun).toBe(true);
  });

  it("limited alias blocks caller-supplied controlled or unknown args before forwarding", async () => {
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const { runtime, targetId } = runtimeWith(adapter);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);

    const controlled = await runtime.dispatch("risky_actions__preview_profile", { profileId: "night", dryRun: false });
    const unknown = await runtime.dispatch("risky_actions__preview_profile", { profileId: "night", force: true });

    expect(controlled.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    expect(adapter.calls.filter((c) => c.name === "actions.apply_profile")).toHaveLength(0);
  });

  it("router blocks a hidden destructive tool and does NOT forward it (audit id present)", async () => {
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const { runtime, targetId } = runtimeWith(adapter);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);

    const res = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.delete_all", arguments: { confirm: true } });
    expect(res.isError).toBe(true);
    expect(res._meta!.decision).toBe("block");
    expect(res._meta!.auditEventId).toBeTruthy();
    expect(adapter.calls.some((c) => c.name === "actions.delete_all")).toBe(false);
  });

  it("router gates a direct mutation call (approval_required), not forwarded", async () => {
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const { runtime, targetId } = runtimeWith(adapter);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);

    const res = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.apply_profile", arguments: { profileId: "x", dryRun: false } });
    expect(res.isError).toBe(true);
    expect(res._meta!.decision).toBe("approval_required");
    expect(adapter.calls.some((c) => c.name === "actions.apply_profile")).toBe(false);
  });

  it("incomplete snapshot => call fail-closed, not forwarded", async () => {
    const adapter = new FakeAdapter([{ tools: RISKY_TOOLS.tools, nextCursor: "1" }], { failAtPage: 1 });
    const { runtime, targetId } = runtimeWith(adapter);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter); // incomplete

    const res = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.list_runs", arguments: {} });
    expect(res.isError).toBe(true);
    expect(adapter.calls.some((c) => c.name === "actions.list_runs")).toBe(false);
  });

  it("tools/list_changed during session open is rechecked before forwarding", async () => {
    const adapter = new FakeAdapter([RISKY_TOOLS], { listChangedOnOpen: true });
    const { runtime, targetId } = runtimeWith(adapter);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);

    const res = await runtime.dispatch("risky_actions__actions_list_runs", {});
    expect(res.isError).toBe(true);
    expect(res._meta!.decision).toBe("block");
    expect(adapter.calls.some((c) => c.name === "actions.list_runs")).toBe(false);
  });

  it("router applies deterministic rewrite arguments before forwarding", async () => {
    const policy: PolicyDoc = {
      default: "deny",
      rules: [
        {
          id: "force-dry-run",
          match: { target: "Risky Actions", tool: "actions.apply_profile" },
          effect: "rewrite",
          rewrite: { injectArguments: { dryRun: true }, hideArguments: ["dryRun"] },
        },
      ],
    };
    const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);
    const version = storePolicyContent(db, cfg, policy);
    const runtime = new GatewayRuntime(db, cfg, new PolicyEngine(policy), new TargetSessionManager(db, adapter), adapter, version);

    const res = await runtime.dispatch("gateway_call_tool", {
      targetId,
      tool: "actions.apply_profile",
      arguments: { profileId: "night" },
    });

    expect(res.isError).toBeFalsy();
    expect(res._meta!.decision).toBe("rewrite");
    expect(adapter.calls).toEqual([{ name: "actions.apply_profile", args: { profileId: "night", dryRun: true } }]);
  });

  it("rewrite blocks controlled and unknown caller args before forwarding", async () => {
    const policy: PolicyDoc = {
      default: "deny",
      rules: [
        {
          id: "force-dry-run",
          match: { target: "Risky Actions", tool: "actions.apply_profile" },
          effect: "rewrite",
          rewrite: { injectArguments: { dryRun: true }, hideArguments: ["dryRun"] },
        },
      ],
    };
    const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);
    const version = storePolicyContent(db, cfg, policy);
    const runtime = new GatewayRuntime(db, cfg, new PolicyEngine(policy), new TargetSessionManager(db, adapter), adapter, version);

    const controlled = await runtime.dispatch("gateway_call_tool", {
      targetId,
      tool: "actions.apply_profile",
      arguments: { profileId: "night", dryRun: false },
    });
    const unknown = await runtime.dispatch("gateway_call_tool", {
      targetId,
      tool: "actions.apply_profile",
      arguments: { profileId: "night", force: true },
    });

    expect(controlled.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    expect(adapter.calls).toHaveLength(0);
  });

  it("client surface hides and blocks operator tools while operator mode exposes them", async () => {
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const { runtime, targetId } = runtimeWith(adapter);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);

    const clientRuntime = new GatewayRuntime(
      db,
      { ...cfg, toolSurfaceMode: "client" },
      new PolicyEngine(POLICY),
      new TargetSessionManager(db, adapter),
      adapter,
      storePolicyContent(db, cfg, POLICY),
    );
    expect(clientRuntime.listTools().map((t) => t.name)).not.toContain("gateway_rescan_target");
    expect(runtime.listTools().map((t) => t.name)).toContain("gateway_rescan_target");

    const blocked = await clientRuntime.dispatch("gateway_rescan_target", { targetId });
    expect(blocked.isError).toBe(true);
    expect(blocked._meta!.decision).toBe("block");
  });
});

describe("integration: real stdio target + enforcement (denied call never forwarded)", () => {
  it("allow forwards, alias forces dryRun, destructive router call is blocked at the process boundary", async () => {
    const sample = path.join(ROOT, "sample-targets", "risky-actions-mcp", "index.ts");
    const logPath = path.join(os.tmpdir(), `pg-p3-${crypto.randomUUID()}.jsonl`);
    fs.writeFileSync(logPath, "");

    let sessions: TargetSessionManager | undefined;
    try {
      const targetId = registerTarget(db, cfg, {
        name: "Risky Actions",
        kind: "stdio",
        command: { command: TSX_BIN, args: [sample], cwd: ROOT },
      });
      const version = storePolicyContent(db, cfg, POLICY);
      const adapter = new StdioTargetAdapter({ extraEnv: { TARGET_CALL_LOG: logPath } });
      sessions = new TargetSessionManager(db, adapter);
      const runtime = new GatewayRuntime(db, cfg, new PolicyEngine(POLICY), sessions, adapter, version);

      await observeTarget(db, cfg, { id: targetId, spec: { command: TSX_BIN, args: [sample], cwd: ROOT } }, adapter);

      await runtime.dispatch("risky_actions__actions_list_runs", {});
      await runtime.dispatch("risky_actions__preview_profile", { profileId: "night" });
      const blocked = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.delete_all", arguments: { confirm: true } });
      expect(blocked.isError).toBe(true);

      await sessions.closeAll();

      const log = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { tool: string; arguments: { dryRun?: boolean } });

      const tools = log.map((e) => e.tool);
      expect(tools).toContain("actions.list_runs");
      const apply = log.find((e) => e.tool === "actions.apply_profile");
      expect(apply?.arguments.dryRun).toBe(true); // alias forced dryRun:true at the target
      expect(tools).not.toContain("actions.delete_all"); // denied call never reached the target
    } finally {
      await sessions?.closeAll();
      fs.rmSync(logPath, { force: true });
    }
  }, 30000);
});
