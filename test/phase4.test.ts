import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { openDb, type DB } from "../src/storage/db";
import { migrate } from "../src/storage/migrate";
import { registerTarget } from "../src/targets/registry";
import { TargetSessionManager } from "../src/targets/session-manager";
import { observeTarget } from "../src/catalog/snapshot";
import { PolicyEngine, type PolicyDoc } from "../src/policy/engine";
import { storePolicyContent } from "../src/policy/policy-store";
import { GatewayRuntime } from "../src/upstream/gateway";
import { jcsCanonicalize, argumentsHash } from "../src/policy/args-hash";
import {
  computeBinding,
  createApproval,
  grantApproval,
  rejectApproval,
  consumeApproval,
  type ApprovalBinding,
} from "../src/approval/approval-store";
import type { GatewayConfig } from "../src/config/load-config";
import type { TargetAdapter, TargetSession, ToolPage, TargetCallResult } from "../src/catalog/target-adapter";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg: GatewayConfig = {
  tenantId: "t1",
  clientId: "c1",
  actorId: "a1",
  dbPath: ":memory:",
  hmacSecret: "test-secret",
  executableAllowlist: ["fake"],
  toolSurfaceMode: "operator",
  stdioEnvKeys: ["PATH"],
  egress: { allowedSchemes: ["https"], allowPrivate: false },
};
const POLICY = parseYaml(fs.readFileSync(path.join(ROOT, "examples/policies/local-dev.yaml"), "utf8")) as PolicyDoc;

const RISKY_TOOLS: ToolPage = {
  tools: [
    { name: "actions.list_runs" },
    { name: "actions.apply_profile", inputSchema: { type: "object", properties: { profileId: { type: "string" }, dryRun: { type: "boolean" } } } },
    { name: "actions.delete_all" },
  ],
};

class FakeAdapter implements TargetAdapter {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  constructor(private pages: ToolPage[]) {}
  async open(): Promise<TargetSession> {
    return { info: { name: "fake" } };
  }
  async listToolsPage(_s: TargetSession, cursor?: string): Promise<ToolPage> {
    const p = this.pages[cursor ? Number(cursor) : 0];
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

describe("JCS argument hashing (ADR-013)", () => {
  it("is order-independent over object keys", () => {
    expect(jcsCanonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(argumentsHash("s", "t", { b: 1, a: 2 })).toBe(argumentsHash("s", "t", { a: 2, b: 1 }));
  });
  it("distinguishes null from missing", () => {
    expect(argumentsHash("s", "t", { a: null })).not.toBe(argumentsHash("s", "t", {}));
  });
  it("distinguishes different values", () => {
    expect(argumentsHash("s", "t", { dryRun: false })).not.toBe(argumentsHash("s", "t", { dryRun: true }));
  });
});

describe("approval store lifecycle", () => {
  it("pending is not consumable; grant enables exactly one consume (atomic one-time)", async () => {
    const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const obs = await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);
    const binding = computeBinding(cfg.hmacSecret, {
      tenantId: cfg.tenantId, targetId, targetTool: "actions.apply_profile",
      effectiveArgs: { profileId: "night", dryRun: false }, policyVersion: "pv1",
      observationId: obs.observationId, schemaHash: "sh1", rewrite: {},
    });
    const { approvalId } = createApproval(db, binding);

    expect(consumeApproval(db, binding)).toBe(false); // pending, not yet approved
    expect(grantApproval(db, cfg.tenantId, approvalId)).toBe(true);
    expect(consumeApproval(db, binding)).toBe(true); // first consume wins
    expect(consumeApproval(db, binding)).toBe(false); // replay/second consume blocked
  });

  it("changed arguments do not match a granted approval (replay-with-different-args blocked)", async () => {
    const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const obs = await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);
    const base = {
      tenantId: cfg.tenantId, targetId, targetTool: "actions.apply_profile",
      policyVersion: "pv1", observationId: obs.observationId, schemaHash: "sh1", rewrite: {},
    };
    const granted = computeBinding(cfg.hmacSecret, { ...base, effectiveArgs: { profileId: "night" } });
    const { approvalId } = createApproval(db, granted);
    grantApproval(db, cfg.tenantId, approvalId);

    const other = computeBinding(cfg.hmacSecret, { ...base, effectiveArgs: { profileId: "DAY" } });
    expect(consumeApproval(db, other)).toBe(false);
    expect(consumeApproval(db, granted)).toBe(true);
  });

  it("does not reuse approvals across actor/client boundaries inside the configured tenant", async () => {
    const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const obs = await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);
    const base = {
      tenantId: cfg.tenantId,
      targetId,
      targetTool: "actions.apply_profile",
      effectiveArgs: { profileId: "night" },
      policyVersion: "pv1",
      observationId: obs.observationId,
      schemaHash: "sh1",
      rewrite: {},
    };
    const granted = computeBinding(cfg.hmacSecret, { ...base, actorId: "actor-a", clientId: "client-a" });
    const { approvalId } = createApproval(db, granted);
    grantApproval(db, cfg.tenantId, approvalId);

    expect(consumeApproval(db, computeBinding(cfg.hmacSecret, { ...base, actorId: "actor-b", clientId: "client-a" }))).toBe(false);
    expect(consumeApproval(db, computeBinding(cfg.hmacSecret, { ...base, actorId: "actor-a", clientId: "client-b" }))).toBe(false);
    expect(consumeApproval(db, granted)).toBe(true);
  });

  it("audits operator grant/reject decisions with the approval policy version", async () => {
    const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const obs = await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);
    const binding = computeBinding(cfg.hmacSecret, {
      tenantId: cfg.tenantId, targetId, targetTool: "actions.apply_profile",
      actorId: cfg.actorId, clientId: cfg.clientId,
      effectiveArgs: { profileId: "night" }, policyVersion: "pv1",
      observationId: obs.observationId, schemaHash: "sh1", rewrite: {},
    });
    const { approvalId } = createApproval(db, binding);
    expect(grantApproval(db, cfg.tenantId, approvalId, { actorId: cfg.actorId, clientId: cfg.clientId })).toBe(true);
    const ev = db.prepare("select approval_id, policy_version from mcp_policy_events where event_type='approval_granted'").get() as
      | { approval_id: string; policy_version: string }
      | undefined;
    expect(ev?.approval_id).toBe(approvalId);
    expect(ev?.policy_version).toBe("pv1");

    const { approvalId: rejectedId } = createApproval(db, binding);
    expect(rejectApproval(db, cfg.tenantId, rejectedId, { actorId: cfg.actorId, clientId: cfg.clientId })).toBe(true);
    const rejected = db
      .prepare("select approval_id, policy_version from mcp_policy_events where event_type='approval_rejected'")
      .get() as { approval_id: string; policy_version: string } | undefined;
    expect(rejected?.approval_id).toBe(rejectedId);
    expect(rejected?.policy_version).toBe("pv1");
  });

  it("stale schema hash does not match (schema-change invalidation)", async () => {
    const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const obs = await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);
    const base = {
      tenantId: cfg.tenantId, targetId, targetTool: "actions.apply_profile",
      effectiveArgs: { profileId: "night" }, policyVersion: "pv1", observationId: obs.observationId, rewrite: {},
    };
    const granted = computeBinding(cfg.hmacSecret, { ...base, schemaHash: "OLD" });
    const { approvalId } = createApproval(db, granted);
    grantApproval(db, cfg.tenantId, approvalId);
    const afterSchemaChange = computeBinding(cfg.hmacSecret, { ...base, schemaHash: "NEW" });
    expect(consumeApproval(db, afterSchemaChange)).toBe(false);
  });

  it("expired approval cannot be consumed (TTL)", async () => {
    const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    const obs = await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);
    const binding = computeBinding(cfg.hmacSecret, {
      tenantId: cfg.tenantId, targetId, targetTool: "actions.apply_profile",
      effectiveArgs: { profileId: "night" }, policyVersion: "pv1", observationId: obs.observationId, schemaHash: "sh1", rewrite: {},
    });
    const { approvalId } = createApproval(db, binding);
    grantApproval(db, cfg.tenantId, approvalId);
    db.prepare("update mcp_approvals set expires_at = ? where id = ?").run(new Date(Date.now() - 1000).toISOString(), approvalId);
    expect(consumeApproval(db, binding)).toBe(false);
  });
});

describe("enforcement: approval flow through the runtime", () => {
  async function setup() {
    const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
    const adapter = new FakeAdapter([RISKY_TOOLS]);
    await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);
    const version = storePolicyContent(db, cfg, POLICY);
    const sessions = new TargetSessionManager(db, adapter);
    const runtime = new GatewayRuntime(db, cfg, new PolicyEngine(POLICY), sessions, adapter, version);
    return { runtime, targetId, adapter };
  }

  it("router mutation is blocked until approved, then executes exactly once", async () => {
    const { runtime, targetId, adapter } = await setup();
    const args = { profileId: "night", dryRun: false };

    // 1. First call -> approval_required, not forwarded
    const r1 = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.apply_profile", arguments: args });
    expect(r1._meta!.decision).toBe("approval_required");
    const approvalId = r1._meta!.approvalId as string;
    expect(approvalId).toBeTruthy();
    expect(adapter.calls).toHaveLength(0);

    // 2. Operator grants
    expect(grantApproval(db, cfg.tenantId, approvalId)).toBe(true);

    // 3. Same call -> consumed & forwarded once
    const r2 = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.apply_profile", arguments: args });
    expect(r2.isError).toBeFalsy();
    expect(adapter.calls.filter((c) => c.name === "actions.apply_profile")).toHaveLength(1);

    // 4. Replay same call -> approval_required again (one-time consume)
    const r3 = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.apply_profile", arguments: args });
    expect(r3._meta!.decision).toBe("approval_required");
    expect(adapter.calls.filter((c) => c.name === "actions.apply_profile")).toHaveLength(1);
  });

  it("gateway_request_approval + grant enables the matching call; different args stay blocked", async () => {
    const { runtime, targetId, adapter } = await setup();
    const args = { profileId: "night", dryRun: false };

    const req = await runtime.dispatch("gateway_request_approval", { targetId, tool: "actions.apply_profile", arguments: args });
    const approvalId = req._meta!.approvalId as string;
    expect(approvalId).toBeTruthy();
    grantApproval(db, cfg.tenantId, approvalId);

    // different args -> still approval_required, not forwarded
    const bad = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.apply_profile", arguments: { profileId: "DAY" } });
    expect(bad._meta!.decision).toBe("approval_required");
    expect(adapter.calls).toHaveLength(0);

    // exact args -> forwarded
    const good = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.apply_profile", arguments: args });
    expect(good.isError).toBeFalsy();
    expect(adapter.calls.filter((c) => c.name === "actions.apply_profile")).toHaveLength(1);
  });
});
