// Upstream Gateway tool surface + call dispatch.
//
// ADR-016 (V2 finding): tool names use `[a-z0-9_]` only — NO dots. After a client
// namespaces MCP tools as `mcp__<server>__<tool>`, a dot would violate the
// Anthropic API tool-name constraint `^[a-zA-Z0-9_-]{1,128}$`. Admin tools use the
	// `gateway_*` grammar; target aliases (later phases) use `<target_slug>__<tool_slug>`.
import type { DB } from "../storage/db";
import type { GatewayConfig } from "../config/load-config";
import { listTargets, getTarget } from "../targets/registry";
import type { TargetAdapter } from "../catalog/target-adapter";
import {
  observeTarget,
  getLatestObservation,
  getSnapshotTools,
  snapshotCallable,
} from "../catalog/snapshot";
import { applyChangeReview, diffObservations, previousCompleteObservation } from "../catalog/diff";
import { getEventForRead, recordEvent } from "../audit/audit-log";
import {
  explainPlayMcpRisk,
  preflightPlayMcp,
  searchPlayMcp,
} from "../assessment/preflight-service";
import {
  formatAssessmentText,
  formatRiskExplanationText,
  formatSearchText,
} from "../assessment/preflight-presenter";

export interface ToolCtx {
  db: DB;
  cfg: GatewayConfig;
  /** Downstream adapter used to (re)observe targets. Required for rescan. */
  adapter?: TargetAdapter;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  content: ToolContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export const GATEWAY_TOOLS: McpTool[] = [
  {
    name: "gateway_health",
    description: "Gateway liveness and identity/status snapshot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "gateway_search_playmcp",
    description: "Search PlayMCP inventory candidates before connecting a target MCP.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Maximum candidates to return (default 5, max 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "gateway_preflight_mcp",
    description: "Return static pre-use decision aid, risk labels, Gateway policy recommendation, and next action for a PlayMCP MCP.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        includeCandidates: { type: "boolean" },
        homepageOrPackageUrl: { type: "string" },
        declaredTools: { type: "array", items: { type: "string" } },
        reasonForUse: { type: "string" },
      },
    },
  },
  {
    name: "gateway_explain_mcp_risk",
    description: "Explain MCP risk labels and decision rationale in plain language.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        id: { type: "string" },
        labels: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
  {
    name: "gateway_list_targets",
    description: "List registered target MCP servers (tenant-scoped).",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", description: "Filter by status (default: active)" } },
    },
  },
  {
    name: "gateway_inspect_target",
    description: "Return the latest capability snapshot for a target (tools, completeness, callability).",
    inputSchema: {
      type: "object",
      properties: { targetId: { type: "string" } },
      required: ["targetId"],
    },
  },
  {
    name: "gateway_rescan_target",
    description: "Re-observe a target's tools/list (all pages) and store a fresh snapshot.",
    inputSchema: {
      type: "object",
      properties: { targetId: { type: "string" } },
      required: ["targetId"],
    },
  },
  {
    name: "gateway_call_tool",
    description: "Policy-evaluated router: call a target tool by real name (allow/approval/deny enforced at call time).",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["targetId", "tool"],
    },
  },
  {
    name: "gateway_list_exposed_tools",
    description: "List the current policy-filtered target aliases exposed upstream.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "gateway_request_approval",
    description: "Create a pending approval bound to the exact call (args/policy/snapshot/schema/rewrite hash) with a short TTL.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object" },
        reason: { type: "string" },
      },
      required: ["targetId", "tool"],
    },
  },
  {
    name: "gateway_diff_target",
    description: "Diff two target snapshots (added/removed/schema-changed tools). Defaults to previous-complete vs latest.",
    inputSchema: {
      type: "object",
      properties: { targetId: { type: "string" }, fromObservationId: { type: "string" }, toObservationId: { type: "string" } },
      required: ["targetId"],
    },
  },
  {
    name: "gateway_get_audit_event",
    description: "Read minimal, tenant-scoped, redacted metadata for one audit event (records an audit_event_read event).",
    inputSchema: {
      type: "object",
      properties: { auditEventId: { type: "string" }, purpose: { type: "string" } },
      required: ["auditEventId"],
    },
  },
];

export const CLIENT_GATEWAY_TOOL_NAMES = new Set([
  "gateway_health",
  "gateway_search_playmcp",
  "gateway_preflight_mcp",
  "gateway_explain_mcp_risk",
  "gateway_call_tool",
  "gateway_list_exposed_tools",
  "gateway_request_approval",
]);

export const OPERATOR_GATEWAY_TOOL_NAMES = new Set([
  "gateway_list_targets",
  "gateway_inspect_target",
  "gateway_rescan_target",
  "gateway_diff_target",
  "gateway_get_audit_event",
]);

export function gatewayToolsForMode(mode: "client" | "operator"): McpTool[] {
  if (mode === "operator") return GATEWAY_TOOLS;
  return GATEWAY_TOOLS.filter((tool) => CLIENT_GATEWAY_TOOL_NAMES.has(tool.name));
}

/** Admin tools handled directly by handleToolCall (not the enforcement path). */
export const ADMIN_TOOL_NAMES = new Set([
  "gateway_health",
  "gateway_search_playmcp",
  "gateway_preflight_mcp",
  "gateway_explain_mcp_risk",
  "gateway_list_targets",
  "gateway_inspect_target",
  "gateway_rescan_target",
  "gateway_diff_target",
  "gateway_get_audit_event",
]);

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolResult> {
  switch (name) {
    case "gateway_health": {
      const auditEventId = recordAdminEvent(ctx, name, { decision: "ok" });
      return ok({ status: "ok", tenantId: ctx.cfg.tenantId }, auditEventId);
    }

    case "gateway_search_playmcp": {
      const query = String(args.query ?? "");
      const result = searchPlayMcp(query, numberArg(args.limit, 5));
      const auditEventId = recordAdminEvent(ctx, name, {
        decision: "ok",
        auditMetadata: { status: result.status, candidateCount: result.candidates.length },
      });
      return ok(result, auditEventId, formatSearchText(result.query, result.candidates));
    }

    case "gateway_preflight_mcp": {
      const result = preflightPlayMcp({
        query: stringArg(args.query),
        id: stringArg(args.id),
        name: stringArg(args.name),
        includeCandidates: args.includeCandidates === true,
        homepageOrPackageUrl: stringArg(args.homepageOrPackageUrl),
        declaredTools: stringArrayArg(args.declaredTools),
        reasonForUse: stringArg(args.reasonForUse),
      });
      const auditEventId = recordAdminEvent(ctx, name, {
        decision: "ok",
        auditMetadata: { status: result.status, candidateCount: "candidates" in result ? result.candidates?.length ?? 0 : 0 },
      });
      if (result.status === "assessed") return ok(result, auditEventId, formatAssessmentText(result.item));
      return ok(result, auditEventId, formatSearchText(result.query, result.candidates));
    }

    case "gateway_explain_mcp_risk": {
      const result = explainPlayMcpRisk({
        query: stringArg(args.query),
        id: stringArg(args.id),
        labels: stringArrayArg(args.labels),
      });
      const auditEventId = recordAdminEvent(ctx, name, {
        decision: "ok",
        auditMetadata: {
          status: result.status,
          labelCount: result.status === "explained" ? result.labels.length : 0,
        },
      });
      if (result.status === "explained") return ok(result, auditEventId, formatRiskExplanationText(result.explanations));
      return ok(result, auditEventId, formatSearchText(result.query, result.candidates));
    }

    case "gateway_list_targets": {
      const status = typeof args.status === "string" ? args.status : "active";
      const auditEventId = recordAdminEvent(ctx, name, { decision: "ok", auditMetadata: { status } });
      return ok({ targets: listTargets(ctx.db, ctx.cfg, status) }, auditEventId);
    }

    case "gateway_inspect_target": {
      const targetId = String(args.targetId ?? "");
      const target = getTarget(ctx.db, ctx.cfg, targetId);
      if (!target) {
        const auditEventId = recordAdminEvent(ctx, name, { decision: "block", reason: `unknown target: ${targetId}` });
        return block(`unknown target: ${targetId}`, auditEventId);
      }
      const obs = getLatestObservation(ctx.db, targetId);
      if (!obs) {
        const auditEventId = recordAdminEvent(ctx, name, { decision: "ok", targetId, auditMetadata: { observationId: null } });
        return ok({ targetId, observationId: null, callable: false, tools: [] }, auditEventId);
      }
      const tools = getSnapshotTools(ctx.db, obs.id).map((t) => ({
        targetTool: t.tool_name,
        exposureStatus: t.exposure_status,
        schemaHash: t.input_schema_hash,
      }));
      const auditEventId = recordAdminEvent(ctx, name, {
        decision: "ok",
        targetId,
        observationId: obs.id,
        auditMetadata: { callable: snapshotCallable(obs), toolCount: tools.length },
      });
      return ok(
        {
          targetId,
          observationId: obs.id,
          completeness: obs.completeness_status,
          callable: snapshotCallable(obs), // fail-closed if incomplete/stale
          listChangedAt: obs.list_changed_at,
          tools,
        },
        auditEventId,
      );
    }

    case "gateway_rescan_target": {
      if (!ctx.adapter) {
        const auditEventId = recordAdminEvent(ctx, name, { decision: "block", reason: "no target adapter configured" });
        return block("no target adapter configured", auditEventId);
      }
      const targetId = String(args.targetId ?? "");
      const target = getTarget(ctx.db, ctx.cfg, targetId);
      if (!target) {
        const auditEventId = recordAdminEvent(ctx, name, { decision: "block", reason: `unknown target: ${targetId}` });
        return block(`unknown target: ${targetId}`, auditEventId);
      }
      if (!target.spec) {
        const auditEventId = recordAdminEvent(ctx, name, { decision: "block", targetId, reason: `target has no connection spec: ${targetId}` });
        return block(`target has no connection spec: ${targetId}`, auditEventId);
      }
      const res = await observeTarget(
        ctx.db,
        { tenantId: ctx.cfg.tenantId, hmacSecret: ctx.cfg.hmacSecret },
        { id: target.id, spec: target.spec },
        ctx.adapter,
      );
      // Mark added / schema-changed tools pending review (fail-closed until re-reviewed).
      const diff = res.completeness === "complete" ? applyChangeReview(ctx.db, target.id, res.observationId) : { added: [], removed: [], changed: [] };
      const auditEventId = recordAdminEvent(ctx, name, {
        decision: "ok",
        targetId,
        observationId: res.observationId,
        auditMetadata: { completeness: res.completeness, toolCount: res.toolCount, diff },
      });
      return ok(
        {
          targetId,
          observationId: res.observationId,
          completeness: res.completeness,
          toolCount: res.toolCount,
          normalizedHash: res.normalizedHash,
          callable: res.completeness === "complete",
          diff,
        },
        auditEventId,
      );
    }

    case "gateway_diff_target": {
      const targetId = String(args.targetId ?? "");
      const target = getTarget(ctx.db, ctx.cfg, targetId);
      if (!target) {
        const auditEventId = recordAdminEvent(ctx, name, { decision: "block", reason: `unknown target: ${targetId}` });
        return block(`unknown target: ${targetId}`, auditEventId);
      }
      const latest = getLatestObservation(ctx.db, targetId);
      if (!latest) {
        const auditEventId = recordAdminEvent(ctx, name, { decision: "block", targetId, reason: `no observation for target: ${targetId}` });
        return block(`no observation for target: ${targetId}`, auditEventId);
      }
      const to = typeof args.toObservationId === "string" ? args.toObservationId : latest.id;
      const from =
        typeof args.fromObservationId === "string"
          ? args.fromObservationId
          : previousCompleteObservation(ctx.db, targetId, to);
      if (!from) {
        const auditEventId = recordAdminEvent(ctx, name, { decision: "ok", targetId, observationId: to, auditMetadata: { from: null, to } });
        return ok({ targetId, from: null, to, added: [], removed: [], changed: [] }, auditEventId);
      }
      const diff = diffObservations(ctx.db, from, to);
      const auditEventId = recordAdminEvent(ctx, name, { decision: "ok", targetId, observationId: to, auditMetadata: { from, to, ...diff } });
      return ok({ targetId, from, to, ...diff }, auditEventId);
    }

    case "gateway_get_audit_event": {
      const auditEventIdArg = String(args.auditEventId ?? "");
      const view = getEventForRead(ctx.db, ctx.cfg.tenantId, auditEventIdArg); // tenant RBAC
      // Record the read itself (audit_event_read), regardless of hit/miss.
      const auditEventId = recordEvent(ctx.db, {
        eventType: "audit_event_read",
        tenantId: ctx.cfg.tenantId,
        policyVersion: "n/a",
        actorId: ctx.cfg.actorId,
        clientId: ctx.cfg.clientId,
        targetTool: name,
        decision: view ? "ok" : "block",
        reason: typeof args.purpose === "string" ? args.purpose : undefined,
        auditMetadata: { requestedEventId: auditEventIdArg, found: Boolean(view) },
      });
      if (!view) return block(`audit event not found in tenant scope: ${auditEventIdArg}`, auditEventId);
      return ok(view, auditEventId);
    }

    default: {
      const auditEventId = recordAdminEvent(ctx, name, { decision: "block", reason: `unknown tool: ${name}` });
      return block(`unknown tool: ${name}`, auditEventId);
    }
  }
}

function recordAdminEvent(
  ctx: ToolCtx,
  toolName: string,
  opts: { decision: "ok" | "block"; reason?: string; targetId?: string; observationId?: string; auditMetadata?: unknown },
): string {
  return recordEvent(ctx.db, {
    eventType: "admin_tool_called",
    tenantId: ctx.cfg.tenantId,
    policyVersion: "admin",
    targetId: opts.targetId,
    observationId: opts.observationId,
    actorId: ctx.cfg.actorId,
    clientId: ctx.cfg.clientId,
    targetTool: toolName,
    decision: opts.decision,
    reason: opts.reason,
    auditMetadata: opts.auditMetadata,
  });
}

function ok(payload: object, auditEventId: string, text?: string): ToolResult {
  return { content: [{ type: "text", text: text ?? JSON.stringify(payload) }], structuredContent: payload, _meta: { auditEventId } };
}

function block(reason: string, auditEventId: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ decision: "block", reason, auditEventId }) }],
    _meta: { auditEventId },
  };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
