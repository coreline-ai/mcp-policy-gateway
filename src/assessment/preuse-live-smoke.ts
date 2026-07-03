import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { openDb } from "../storage/db";
import { migrate } from "../storage/migrate";
import { registerTarget } from "../targets/registry";
import { StdioTargetAdapter } from "../catalog/stdio-adapter";
import { TargetSessionManager } from "../targets/session-manager";
import { GatewayRuntime } from "../upstream/gateway";
import { PolicyEngine, type PolicyDoc } from "../policy/engine";
import { storePolicyContent } from "../policy/policy-store";
import { grantApproval } from "../approval/approval-store";
import type { GatewayConfig } from "../config/load-config";
import type { ToolResult } from "../upstream/tools";

export interface PreUseLiveSmokeResult {
  status: "PASS" | "FAIL";
  targetName: string;
  targetKind: "stdio";
  targetId: string;
  observationId: string;
  completeness: string;
  toolCount: number;
  exposedTools: string[];
  hiddenToolDirectCallBlocked: boolean;
  deniedForwardingCount: number;
  approvalRequiredBeforeGrant: boolean;
  approvedCallForwardedOnce: boolean;
  approvalReplayBlocked: boolean;
  diffChecked: boolean;
  auditReadRedacted: boolean;
  notes: string[];
}

interface TargetLogEntry {
  tool: string;
  arguments: Record<string, unknown>;
}

export async function runPreUseLiveSmoke(opts: { rootDir?: string; cleanup?: boolean } = {}): Promise<PreUseLiveSmokeResult> {
  const rootDir = opts.rootDir ?? process.cwd();
  const cleanup = opts.cleanup ?? true;
  const tsxBin = path.join(rootDir, "node_modules", ".bin", "tsx");
  const targetScript = path.join(rootDir, "sample-targets", "risky-actions-mcp", "index.ts");
  const policyPath = path.join(rootDir, "examples", "policies", "local-dev.yaml");
  const dbPath = path.join(os.tmpdir(), `pg-preuse-smoke-${process.pid}-${Date.now()}.sqlite`);
  const logPath = path.join(os.tmpdir(), `pg-preuse-smoke-${process.pid}-${Date.now()}.jsonl`);
  const cleanupFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, logPath];

  for (const file of cleanupFiles) fs.rmSync(file, { force: true });
  fs.writeFileSync(logPath, "");

  const cfg: GatewayConfig = {
    tenantId: "default-tenant",
    clientId: "preuse-smoke",
    actorId: "operator",
    dbPath,
    hmacSecret: "preuse-smoke-secret",
    executableAllowlist: [tsxBin],
    toolSurfaceMode: "operator",
    stdioEnvKeys: ["PATH"],
    egress: { allowedSchemes: ["https"], allowPrivate: false },
  };
  const policy = parseYaml(fs.readFileSync(policyPath, "utf8")) as PolicyDoc;

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

  try {
    const targetId = registerTarget(db, cfg, {
      name: "Risky Actions",
      kind: "stdio",
      command: { kind: "stdio", command: tsxBin, args: [targetScript], cwd: rootDir },
    });

    const rescan = parseTextResult<{ observationId: string; completeness: string; toolCount: number }>(
      await runtime.dispatch("gateway_rescan_target", { targetId }),
    );
    const exposedTools = runtime.listTools().map((tool) => tool.name);

    await runtime.dispatch("risky_actions__actions_list_runs", {});
    const beforeDenied = targetLog(logPath).filter((entry) => entry.tool === "actions.delete_all").length;
    const denied = await runtime.dispatch("gateway_call_tool", {
      targetId,
      tool: "actions.delete_all",
      arguments: { confirm: true },
    });
    const afterDenied = targetLog(logPath).filter((entry) => entry.tool === "actions.delete_all").length;

    const approvalRequired = parseTextResult<{ decision: string; approvalId: string; auditEventId: string }>(
      await runtime.dispatch("gateway_call_tool", {
        targetId,
        tool: "actions.apply_profile",
        arguments: { profileId: "day", dryRun: false },
      }),
    );
    grantApproval(db, cfg.tenantId, approvalRequired.approvalId);
    const granted = await runtime.dispatch("gateway_call_tool", {
      targetId,
      tool: "actions.apply_profile",
      arguments: { profileId: "day", dryRun: false },
    });
    const realApplies = targetLog(logPath).filter((entry) => entry.tool === "actions.apply_profile" && entry.arguments.dryRun === false);
    const replay = parseTextResult<{ decision: string }>(
      await runtime.dispatch("gateway_call_tool", {
        targetId,
        tool: "actions.apply_profile",
        arguments: { profileId: "day", dryRun: false },
      }),
    );
    const diff = parseTextResult<{ added: unknown[]; removed: unknown[]; changed: unknown[] }>(
      await runtime.dispatch("gateway_diff_target", { targetId }),
    );
    const audit = parseTextResult<{ redacted: boolean; rawArgumentsStored: boolean }>(
      await runtime.dispatch("gateway_get_audit_event", { auditEventId: approvalRequired.auditEventId, purpose: "preuse-smoke" }),
    );

    const hiddenToolDirectCallBlocked = denied.isError === true;
    const deniedForwardingCount = afterDenied - beforeDenied;
    const approvalRequiredBeforeGrant = approvalRequired.decision === "approval_required";
    const approvedCallForwardedOnce = granted.isError !== true && realApplies.length === 1;
    const approvalReplayBlocked = replay.decision === "approval_required";
    const diffChecked = Array.isArray(diff.added) && Array.isArray(diff.removed) && Array.isArray(diff.changed);
    const auditReadRedacted = audit.redacted === true && audit.rawArgumentsStored === false;
    const status = [
      rescan.completeness === "complete",
      rescan.toolCount === 4,
      exposedTools.includes("risky_actions__actions_list_runs"),
      exposedTools.includes("risky_actions__preview_profile"),
      !exposedTools.some((name) => name.includes("delete_all")),
      hiddenToolDirectCallBlocked,
      deniedForwardingCount === 0,
      approvalRequiredBeforeGrant,
      approvedCallForwardedOnce,
      approvalReplayBlocked,
      diffChecked,
      auditReadRedacted,
    ].every(Boolean)
      ? "PASS"
      : "FAIL";

    return {
      status,
      targetName: "Risky Actions",
      targetKind: "stdio",
      targetId,
      observationId: rescan.observationId,
      completeness: rescan.completeness,
      toolCount: rescan.toolCount,
      exposedTools,
      hiddenToolDirectCallBlocked,
      deniedForwardingCount,
      approvalRequiredBeforeGrant,
      approvedCallForwardedOnce,
      approvalReplayBlocked,
      diffChecked,
      auditReadRedacted,
      notes: [
        "Local stdio MCP target registered behind Gateway.",
        "No remote PlayMCP tools/call was executed.",
        "Denied destructive call did not reach the target log.",
      ],
    };
  } finally {
    await sessions.closeAll();
    if (cleanup) {
      for (const file of cleanupFiles) fs.rmSync(file, { force: true });
    }
  }
}

function parseTextResult<T>(result: ToolResult): T {
  const text = result.content[0]?.text;
  if (typeof text !== "string") throw new Error("Expected a text tool result");
  return JSON.parse(text) as T;
}

function targetLog(logPath: string): TargetLogEntry[] {
  return fs.readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TargetLogEntry);
}
