// MVP acceptance demo (in-process, real stdio target).
// Walks the full gateway flow end to end and prints each step. Run:
//   npm run demo:mvp
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { openDb } from "../src/storage/db";
import { migrate } from "../src/storage/migrate";
import { registerTarget } from "../src/targets/registry";
import { TargetSessionManager } from "../src/targets/session-manager";
import { PolicyEngine, type PolicyDoc } from "../src/policy/engine";
import { storePolicyContent } from "../src/policy/policy-store";
import { grantApproval } from "../src/approval/approval-store";
import { StdioTargetAdapter } from "../src/catalog/stdio-adapter";
import { GatewayRuntime } from "../src/upstream/gateway";
import type { ToolResult } from "../src/upstream/tools";
import type { GatewayConfig } from "../src/config/load-config";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(ROOT, "node_modules", ".bin", "tsx");
const risky = path.join(ROOT, "sample-targets", "risky-actions-mcp", "index.ts");

const dbPath = path.join(os.tmpdir(), `pg-demo-${process.pid}.sqlite`);
const logPath = path.join(os.tmpdir(), `pg-demo-${process.pid}.jsonl`);
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, logPath]) fs.rmSync(f, { force: true });
fs.writeFileSync(logPath, "");

const cfg: GatewayConfig = {
  tenantId: "default-tenant", clientId: "demo", actorId: "operator",
  dbPath, hmacSecret: "demo-secret", executableAllowlist: [tsxBin],
  toolSurfaceMode: "operator",
  stdioEnvKeys: ["PATH"],
  egress: { allowedSchemes: ["https"], allowPrivate: false },
};
const policy = parseYaml(fs.readFileSync(path.join(ROOT, "examples/policies/local-dev.yaml"), "utf8")) as PolicyDoc;

const step = (n: number, s: string) => console.log(`\n[${n}] ${s}`);
const textBody = (r: ToolResult) => {
  const text = r.content[0]?.text;
  if (typeof text !== "string") throw new Error("Expected a text tool result body");
  return text;
};
const body = <T>(r: ToolResult) => JSON.parse(textBody(r)) as T;
const targetLog = () => fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { tool: string; arguments: { dryRun?: boolean } });
let ok = true;
const assert = (label: string, cond: boolean) => { console.log(`      ${cond ? "✓" : "✗"} ${label}`); if (!cond) ok = false; };

const db = openDb(dbPath);
migrate(db);
const version = storePolicyContent(db, cfg, policy);
const adapter = new StdioTargetAdapter({ extraEnv: { TARGET_CALL_LOG: logPath } });
const sessions = new TargetSessionManager(db, adapter, {
  tenantId: cfg.tenantId,
  actorId: cfg.actorId,
  clientId: cfg.clientId,
  policyVersion: version,
});
const runtime = new GatewayRuntime(db, cfg, new PolicyEngine(policy), sessions, adapter, version);

step(1, "Register the risky-actions target (privileged config)");
const targetId = registerTarget(db, cfg, {
  name: "Risky Actions", kind: "stdio",
  command: { command: tsxBin, args: [risky], cwd: ROOT },
});
console.log(`      targetId = ${targetId}`);

step(2, "Observe target tools/list (all pages) and store a complete snapshot");
const rescan = body<{ completeness: string; toolCount: number }>(await runtime.dispatch("gateway_rescan_target", { targetId }));
console.log(`      completeness=${rescan.completeness} toolCount=${rescan.toolCount}`);
assert("snapshot complete", rescan.completeness === "complete");

step(3, "Filtered upstream tools/list (only allowed tools + aliases; hidden real names)");
const names = runtime.listTools().map((t) => t.name);
console.log("      " + names.join(", "));
assert("preview alias exposed", names.includes("risky_actions__preview_profile"));
assert("apply_profile real name hidden", !names.some((n) => n.includes("apply_profile")));
assert("delete_all hidden", !names.some((n) => n.includes("delete")));
assert("no dotted names", names.every((n) => !n.includes(".")));

step(4, "Hidden destructive tool called directly via router -> blocked (not forwarded)");
const del = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.delete_all", arguments: { confirm: true } });
assert("delete_all blocked", del.isError === true);
assert("delete_all never reached target", !targetLog().some((e) => e.tool === "actions.delete_all"));

step(5, "Allowed read tool returns a secret -> output policy redacts it");
const cfgRes = await runtime.dispatch("risky_actions__actions_get_config", {});
const cfgText = textBody(cfgRes);
console.log(`      returned: ${cfgText}`);
assert("secret redacted", !cfgText.includes("sk-DEMOKEY") && cfgText.includes("[REDACTED]"));

step(6, "Limited alias injects dryRun:true while accepting only exposed args");
await runtime.dispatch("risky_actions__preview_profile", { profileId: "night" });
const applied = targetLog().find((e) => e.tool === "actions.apply_profile");
assert("target received dryRun:true", applied?.arguments.dryRun === true);

step(7, "Direct mutation (router) -> approval required, not forwarded");
const r1 = body<{ decision: string; approvalId: string; auditEventId: string }>(await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.apply_profile", arguments: { profileId: "day", dryRun: false } }));
assert("approval_required", r1.decision === "approval_required");
console.log(`      approvalId = ${r1.approvalId}`);

step(8, "Operator grants the approval, then the exact call executes once");
grantApproval(db, cfg.tenantId, r1.approvalId);
const r2 = await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.apply_profile", arguments: { profileId: "day", dryRun: false } });
assert("granted call forwarded", r2.isError !== true);
const realApplies = targetLog().filter((e) => e.tool === "actions.apply_profile" && e.arguments.dryRun === false);
assert("executed exactly once with real args", realApplies.length === 1);

step(9, "Replay the same call -> blocked again (atomic one-time consume)");
const r3 = body<{ decision: string }>(await runtime.dispatch("gateway_call_tool", { targetId, tool: "actions.apply_profile", arguments: { profileId: "day", dryRun: false } }));
assert("replay approval_required", r3.decision === "approval_required");

step(10, "Diff the target snapshot (rescan) and read a redacted audit event");
const diff = body<{ added: unknown[]; removed: unknown[]; changed: unknown[] }>(await runtime.dispatch("gateway_diff_target", { targetId }));
console.log(`      diff: added=${diff.added.length} removed=${diff.removed.length} changed=${diff.changed.length}`);
const audit = body<{ eventType: string; decision: string; rawArgumentsStored: boolean; redacted: boolean }>(await runtime.dispatch("gateway_get_audit_event", { auditEventId: r1.auditEventId, purpose: "demo" }));
console.log(`      audit event: type=${audit.eventType} decision=${audit.decision} rawArgumentsStored=${audit.rawArgumentsStored}`);
assert("audit read is redacted, no raw args", audit.redacted === true && audit.rawArgumentsStored === false);

await sessions.closeAll();
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, logPath]) fs.rmSync(f, { force: true });
console.log(`\n${ok ? "DEMO OK — all steps passed" : "DEMO FAILED"}`);
process.exit(ok ? 0 : 1);
