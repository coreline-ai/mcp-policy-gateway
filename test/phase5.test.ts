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
import { diffObservations, applyChangeReview, clearChangeReview } from "../src/catalog/diff";
import { StdioTargetAdapter } from "../src/catalog/stdio-adapter";
import { PolicyEngine, type PolicyDoc } from "../src/policy/engine";
import { storePolicyContent } from "../src/policy/policy-store";
import { GatewayRuntime } from "../src/upstream/gateway";
import { handleToolCall, type ToolCtx } from "../src/upstream/tools";
import { applyOutputPolicy, applyToolResultOutputPolicy } from "../src/output/output-policy";
import type { GatewayConfig } from "../src/config/load-config";
import type { TargetAdapter, TargetSession, ToolPage, TargetCallResult } from "../src/catalog/target-adapter";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const cfg: GatewayConfig = {
  tenantId: "t1", clientId: "c1", actorId: "a1", dbPath: ":memory:", hmacSecret: "test-secret", executableAllowlist: ["fake", TSX_BIN],
  toolSurfaceMode: "operator",
  stdioEnvKeys: ["PATH"],
  egress: { allowedSchemes: ["https"], allowPrivate: false },
};
const POLICY = parseYaml(fs.readFileSync(path.join(ROOT, "examples/policies/local-dev.yaml"), "utf8")) as PolicyDoc;
const SECRET = "sk-ABCDEFGHIJKLMNOP1234";

const applySchemaA = { type: "object", properties: { profileId: { type: "string" }, dryRun: { type: "boolean" } } };
const applySchemaB = { type: "object", properties: { profileId: { type: "string" }, dryRun: { type: "boolean" }, force: { type: "boolean" } } };
const toolsWith = (applySchema: unknown, outputSchema: unknown = null): ToolPage => ({
  tools: [
    { name: "actions.list_runs" },
    { name: "actions.apply_profile", inputSchema: applySchema, outputSchema },
    { name: "actions.delete_all" },
  ],
});

class FakeAdapter implements TargetAdapter {
  calls: string[] = [];
  constructor(private page: ToolPage, private responses: Record<string, TargetCallResult> = {}) {}
  async open(): Promise<TargetSession> { return { info: { name: "fake" } }; }
  async listToolsPage(): Promise<ToolPage> { return this.page; }
  async callTool(_s: TargetSession, name: string): Promise<TargetCallResult> {
    this.calls.push(name);
    return this.responses[name] ?? { content: [{ type: "text", text: `called ${name}` }] };
  }
  async close(): Promise<void> {}
}

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});

describe("output policy (best-effort, ADR-010/D23)", () => {
  it("redacts known secret patterns in text", () => {
    const r = applyOutputPolicy([{ type: "text", text: `here is ${SECRET} ok` }]);
    expect(r.status).toBe("redacted");
    const text = (r.blocks[0] as { text: string }).text;
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[REDACTED]");
  });
  it("blocks disallowed resource_link schemes and embedded resources", () => {
    expect(applyOutputPolicy([{ type: "resource_link", uri: "http://evil.example/x" }]).status).toBe("blocked");
    expect(applyOutputPolicy([{ type: "resource", resource: { uri: "x", text: "y" } }]).status).toBe("blocked");
    expect(applyOutputPolicy([{ type: "resource_link", uri: "https://ok.example/x" }]).status).toBe("passed");
  });
  it("enforces resource_link host/path allowlists when configured", () => {
    const cfg = { allowedResourceSchemes: ["https"], allowedResourceHosts: ["ok.example"], allowedResourcePaths: ["/safe"], blockEmbeddedResources: true };
    expect(applyOutputPolicy([{ type: "resource_link", uri: "https://ok.example/safe/1" }], cfg).status).toBe("passed");
    expect(applyOutputPolicy([{ type: "resource_link", uri: "https://evil.example/safe/1" }], cfg).status).toBe("blocked");
    expect(applyOutputPolicy([{ type: "resource_link", uri: "https://ok.example/private/1" }], cfg).status).toBe("blocked");
  });
  it("redacts structuredContent and blocks structured resource-like URLs", () => {
    const redacted = applyToolResultOutputPolicy({ content: [], structuredContent: { token: SECRET } });
    expect(redacted.status).toBe("redacted");
    expect(JSON.stringify(redacted.result?.structuredContent)).not.toContain(SECRET);

    const blocked = applyToolResultOutputPolicy({ content: [], structuredContent: { url: "http://evil.example/leak" } });
    expect(blocked.status).toBe("blocked");
  });
  it("passes clean text unchanged", () => {
    expect(applyOutputPolicy([{ type: "text", text: "nothing secret here" }]).status).toBe("passed");
  });
});

async function setup(page: ToolPage, responses: Record<string, TargetCallResult> = {}) {
  const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
  const adapter = new FakeAdapter(page, responses);
  await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, adapter);
  const version = storePolicyContent(db, cfg, POLICY);
  const runtime = new GatewayRuntime(db, cfg, new PolicyEngine(POLICY), new TargetSessionManager(db, adapter), adapter, version);
  return { runtime, targetId, adapter };
}

const HARDENING_POLICY: PolicyDoc = { version: 1, default: "allow", rules: [] };

function hardeningSpec(mode: string) {
  return {
    command: TSX_BIN,
    args: [path.join(ROOT, "sample-targets", "hardening-mcp", "index.ts"), mode],
    cwd: ROOT,
  };
}

async function setupHardeningTarget(mode: string, overrides: Partial<ReturnType<typeof hardeningSpec>> & { callTimeoutMs?: number } = {}) {
  const adapter = new StdioTargetAdapter();
  const spec = { ...hardeningSpec(mode), ...overrides };
  const targetId = registerTarget(db, cfg, { name: `Hardening ${mode}`, kind: "stdio", command: spec });
  await observeTarget(db, cfg, { id: targetId, spec }, adapter);
  const version = storePolicyContent(db, cfg, HARDENING_POLICY);
  const sessions = new TargetSessionManager(db, adapter, {
    tenantId: cfg.tenantId,
    actorId: cfg.actorId,
    clientId: cfg.clientId,
    policyVersion: version,
  });
  const runtime = new GatewayRuntime(db, cfg, new PolicyEngine(HARDENING_POLICY), sessions, adapter, version);
  return { runtime, targetId, sessions };
}

function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

describe("output policy through the runtime", () => {
  it("redacts a secret returned by an allowed tool (audit output_redacted)", async () => {
    const { runtime } = await setup(toolsWith(applySchemaA), {
      "actions.list_runs": { content: [{ type: "text", text: `leaked ${SECRET}` }] },
    });
    const res = await runtime.dispatch("risky_actions__actions_list_runs", {});
    expect(res.content[0]!.text).not.toContain(SECRET);
    expect(res._meta!.outputPolicy).toBe("redacted");
    const evs = db.prepare("select event_type from mcp_policy_events where output_policy_status='redacted'").all();
    expect(evs.length).toBeGreaterThan(0);
  });

  it("blocks a result carrying a disallowed resource_link (target still called, result withheld)", async () => {
    const { runtime, adapter } = await setup(toolsWith(applySchemaA), {
      "actions.list_runs": { content: [{ type: "resource_link", uri: "http://evil.example/leak" }] },
    });
    const res = await runtime.dispatch("risky_actions__actions_list_runs", {});
    expect(res.isError).toBe(true);
    expect(res._meta!.decision).toBe("output_blocked");
    expect(adapter.calls).toContain("actions.list_runs"); // call happened; output was withheld
  });

  it("applies output policy to structuredContent before returning", async () => {
    const { runtime } = await setup(toolsWith(applySchemaA), {
      "actions.list_runs": { content: [{ type: "text", text: "ok" }], structuredContent: { token: SECRET } },
    });
    const res = await runtime.dispatch("risky_actions__actions_list_runs", {});
    expect(res.isError).toBeFalsy();
    expect(res._meta!.outputPolicy).toBe("redacted");
    expect(JSON.stringify(res.structuredContent)).not.toContain(SECRET);
  });

  it("preserves allowed non-text content blocks after output policy", async () => {
    const { runtime } = await setup(toolsWith(applySchemaA), {
      "actions.list_runs": { content: [{ type: "resource_link", uri: "https://ok.example/safe/1", name: "safe report" }] },
    });
    const res = await runtime.dispatch("risky_actions__actions_list_runs", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0]).toEqual({ type: "resource_link", uri: "https://ok.example/safe/1", name: "safe report" });
  });
});

describe("diff + changed-tool default-deny (ADR-008)", () => {
  it("marks a schema-changed tool pending review: no longer exposed or callable", async () => {
    const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
    const a1 = new FakeAdapter(toolsWith(applySchemaA));
    const v1 = await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, a1);
    const a2 = new FakeAdapter(toolsWith(applySchemaB));
    const v2 = await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, a2);

    const diff = diffObservations(db, v1.observationId, v2.observationId);
    expect(diff.changed.map((c) => c.tool)).toContain("actions.apply_profile");
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);

    applyChangeReview(db, targetId, v2.observationId);
    const version = storePolicyContent(db, cfg, POLICY);
    const runtime = new GatewayRuntime(db, cfg, new PolicyEngine(POLICY), new TargetSessionManager(db, a2), a2, version);

    const names = runtime.listTools().map((t) => t.name);
    expect(names).toContain("risky_actions__actions_list_runs"); // unchanged tool still exposed
    expect(names).not.toContain("risky_actions__preview_profile"); // changed tool hidden until review

    const viaRouter = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.apply_profile", arguments: { profileId: "x" } });
    expect(viaRouter.isError).toBe(true);
    expect(a2.calls).not.toContain("actions.apply_profile");

    // operator re-review clears the pending flag -> exposure restored per policy
    expect(clearChangeReview(db, targetId).cleared).toBe(1);
    const runtime2 = new GatewayRuntime(db, cfg, new PolicyEngine(POLICY), new TargetSessionManager(db, a2), a2, version);
    expect(runtime2.listTools().map((t) => t.name)).toContain("risky_actions__preview_profile");
    // router direct apply now hits the policy's approval gate (not the pending-review block)
    const afterReview = await runtime2.dispatch("gateway_call_tool", { targetId, tool: "actions.apply_profile", arguments: { profileId: "x" } });
    expect(afterReview._meta!.decision).toBe("approval_required");
  });

  it("treats output schema changes as pending review too", async () => {
    const targetId = registerTarget(db, cfg, { name: "Risky Actions", kind: "stdio", command: { command: "fake" } });
    const v1 = await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, new FakeAdapter(toolsWith(applySchemaA, { type: "object", properties: { ok: { type: "boolean" } } })));
    const v2 = await observeTarget(db, cfg, { id: targetId, spec: { command: "fake" } }, new FakeAdapter(toolsWith(applySchemaA, { type: "object", properties: { ok: { type: "boolean" }, detail: { type: "string" } } })));

    const diff = diffObservations(db, v1.observationId, v2.observationId);
    expect(diff.changed).toContainEqual({ tool: "actions.apply_profile", change: "output_schema_changed" });

    applyChangeReview(db, targetId, v2.observationId);
    const pending = db.prepare("select exposure_status from mcp_tool_snapshots where observation_id=? and tool_name=?").get(v2.observationId, "actions.apply_profile") as
      | { exposure_status: string }
      | undefined;
    expect(pending?.exposure_status).toBe("changed_pending_review");
  });
});

describe("audit read privacy (RBAC + redaction)", () => {
  it("returns redacted HMAC-only reproduction metadata to the owning tenant and denies other tenants", async () => {
    const { runtime, targetId } = await setup(toolsWith(applySchemaA));
    const approval = await runtime.dispatch("gateway_call_tool", {
      targetId,
      tool: "actions.apply_profile",
      arguments: { profileId: "night", token: SECRET },
    });
    const auditEventId = approval._meta!.auditEventId as string;

    const ctx: ToolCtx = { db, cfg };
    const read = await handleToolCall("gateway_get_audit_event", { auditEventId, purpose: "debug" }, ctx);
    const view = JSON.parse(read.content[0]!.text!);
    expect(view.redacted).toBe(true);
    expect(view.rawArgumentsStored).toBe(false);
    expect(view.rawResultStored).toBe(false);
    expect(view.decision).toBe("approval_required");
    expect(view.ruleId).toBe("approve-mutations");
    expect(view.reason).toBe("approval required");
    expect(view.actorId).toBe(cfg.actorId);
    expect(view.clientId).toBe(cfg.clientId);
    expect(view.argumentsHash).toMatch(/^hmac-sha256:/);
    expect(view.resultHash).toBeNull();
    expect(view.policyContentAvailable).toBe(true);
    expect(view.auditMetadata.schemaHash).toContain("hmac-sha256:");
    expect(view.auditMetadata.rewriteHash).toMatch(/^hmac-sha256:/);
    expect(JSON.stringify(view)).not.toContain("profileId");
    expect(JSON.stringify(view)).not.toContain(SECRET);
    const policy = db
      .prepare("select normalized_policy from mcp_policies where tenant_id=? and version=?")
      .get(cfg.tenantId, view.policyVersion) as { normalized_policy: string } | undefined;
    expect(policy?.normalized_policy).toContain("approve-mutations");
    // the read itself is audited
    expect((db.prepare("select count(*) c from mcp_policy_events where event_type='audit_event_read'").get() as { c: number }).c).toBeGreaterThan(0);

    // other tenant cannot read it (RBAC)
    const ctx2: ToolCtx = { db, cfg: { ...cfg, tenantId: "t2" } };
    const denied = await handleToolCall("gateway_get_audit_event", { auditEventId }, ctx2);
    expect(denied.isError).toBe(true);
  });
});

describe("credential custody regression (T19)", () => {
  it("never stores raw secret/result content in audit events", async () => {
    const { runtime } = await setup(toolsWith(applySchemaA), {
      "actions.list_runs": { content: [{ type: "text", text: `secret ${SECRET}` }] },
    });
    await runtime.dispatch("risky_actions__actions_list_runs", {});
    const rows = db.prepare("select * from mcp_policy_events").all();
    expect(JSON.stringify(rows)).not.toContain(SECRET); // no raw content persisted anywhere in the audit stream
  });

  it("does not inherit gateway process secrets into stdio targets by default", async () => {
    const previousSecret = process.env.GATEWAY_HMAC_SECRET;
    process.env.GATEWAY_HMAC_SECRET = "super-secret-runtime-value";
    let sessions: TargetSessionManager | undefined;
    try {
      const setup = await setupHardeningTarget("env-check");
      sessions = setup.sessions;
      const res = await setup.runtime.dispatch("gateway_call_tool", {
        targetId: setup.targetId,
        tool: "hardening.env_check",
        arguments: {},
      });
      const payload = JSON.parse(String(res.content[0]!.text));
      expect(payload.hasGatewaySecret).toBe(false);
      expect(payload.hasTargetCallLog).toBe(false);
    } finally {
      if (previousSecret === undefined) delete process.env.GATEWAY_HMAC_SECRET;
      else process.env.GATEWAY_HMAC_SECRET = previousSecret;
      await sessions?.closeAll();
    }
  });
});

describe("stdio runtime hardening (T23/T26/T27)", () => {
  it("closes malformed and oversized stdout during target open and records transport errors", async () => {
    const adapter = new StdioTargetAdapter();
    const sessions = new TargetSessionManager(db, adapter, { tenantId: cfg.tenantId, actorId: cfg.actorId, clientId: cfg.clientId });
    const malformedId = registerTarget(db, cfg, { name: "Malformed", kind: "stdio", command: hardeningSpec("malformed") });
    const oversizedId = registerTarget(db, cfg, { name: "Oversized", kind: "stdio", command: hardeningSpec("oversized") });

    await expect(withTimeout(sessions.callTool({ id: malformedId, spec: hardeningSpec("malformed") }, "x", {}))).rejects.toThrow();
    await expect(withTimeout(sessions.callTool({ id: oversizedId, spec: hardeningSpec("oversized") }, "x", {}))).rejects.toThrow();
    await sessions.closeAll();

    const events = db
      .prepare("select target_id, event_type, decision, reason from mcp_policy_events where event_type='target_transport_error'")
      .all() as { target_id: string; event_type: string; decision: string; reason: string }[];
    expect(events.map((e) => e.target_id).sort()).toEqual([malformedId, oversizedId].sort());
    expect(events.every((e) => e.decision === "error")).toBe(true);
    expect(events.some((e) => e.reason.includes("JSON"))).toBe(true);
    expect(events.some((e) => e.reason.includes("exceeded"))).toBe(true);
  });

  it("turns a target crash mid-call into an audited target_call_failed result", async () => {
    const { runtime, targetId, sessions } = await setupHardeningTarget("crash-tool");
    const res = await runtime.dispatch("gateway_call_tool", { targetId, tool: "hardening.crash", arguments: {} });
    await sessions.closeAll();

    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text!);
    expect(body.decision).toBe("error");
    const ev = db.prepare("select event_type, decision, reason from mcp_policy_events where event_type='target_call_failed'").get() as
      | { event_type: string; decision: string; reason: string }
      | undefined;
    expect(ev?.decision).toBe("error");
    expect(ev?.reason).toContain("target call failed");
  });

  it("rejects unsupported reverse requests and records an audit event", async () => {
    const { runtime, targetId, sessions } = await setupHardeningTarget("reverse");
    const res = await runtime.dispatch("gateway_call_tool", { targetId, tool: "hardening.reverse", arguments: {} });
    await sessions.closeAll();

    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("reverse blocked");
    const ev = db
      .prepare("select event_type, tenant_id, decision, reason from mcp_policy_events where event_type='unsupported_reverse_capability'")
      .get() as { event_type: string; tenant_id: string; decision: string; reason: string } | undefined;
    expect(ev).toMatchObject({ tenant_id: cfg.tenantId, decision: "block", reason: "sampling/createMessage" });
  });

  it("times out hanging calls, discards the failed session, and reopens on the next call", async () => {
    const { runtime, targetId, sessions } = await setupHardeningTarget("hang-tool", { callTimeoutMs: 50 });
    const first = await runtime.dispatch("gateway_call_tool", { targetId, tool: "hardening.hang", arguments: {} });
    const second = await runtime.dispatch("gateway_call_tool", { targetId, tool: "hardening.hang", arguments: {} });
    await sessions.closeAll();

    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
    const events = db
      .prepare("select event_type, decision, reason from mcp_policy_events where event_type='target_call_failed'")
      .all() as { event_type: string; decision: string; reason: string }[];
    const timeoutEvents = events.filter((e) => e.reason.includes("timed out"));
    expect(timeoutEvents).toHaveLength(2);
    expect(timeoutEvents.every((e) => e.decision === "error")).toBe(true);
  });
});

describe("no-circumvention guardrail (T21)", () => {
  const BAD = /paywall|anti[-\s]?bot|captcha|rate[-\s]?limit\s*bypass|unofficial\s*api|scrape/i;
  it("sample targets and example policies contain no circumvention material", () => {
    const files = [
      "sample-targets/safe-notes-mcp/index.ts",
      "sample-targets/risky-actions-mcp/index.ts",
      "examples/policies/local-dev.yaml",
      "examples/policies/default-deny.yaml",
    ];
    for (const f of files) {
      expect(fs.readFileSync(path.join(ROOT, f), "utf8")).not.toMatch(BAD);
    }
  });
  it("README makes no forbidden absolute-security claims", () => {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    expect(readme).not.toMatch(/prevents all|guarantees? (security|safety)|completely secure|blocks all attacks/i);
  });
});
