// Gateway runtime: builds the filtered upstream tool surface and enforces policy
// on every tools/call. Both the router (gateway_call_tool) and exposed aliases
// funnel through enforce() — list filtering alone is never the control (ADR-003).
import type { DB } from "../storage/db";
import type { GatewayConfig } from "../config/load-config";
import type { TargetAdapter } from "../catalog/target-adapter";
import { PolicyEngine, type PolicyRewrite } from "../policy/engine";
import { TargetCallPreflightBlocked, TargetSessionManager } from "../targets/session-manager";
import { listTargets, getTarget } from "../targets/registry";
import {
  getLatestObservation,
  getSnapshotTools,
  getSnapshotToolsFull,
  snapshotCallable,
} from "../catalog/snapshot";
import { recordEvent } from "../audit/audit-log";
import {
  computeBinding,
  createApproval,
  consumeApprovalWithId,
  attachRequestedEvent,
  type ApprovalBinding,
} from "../approval/approval-store";
import type { SnapshotToolRow } from "../catalog/snapshot";
import type { ObservationRow } from "../catalog/snapshot";
import type { TargetSpecRow } from "../targets/registry";
import { CHANGED_PENDING } from "../catalog/diff";
import { applyToolResultOutputPolicy, DEFAULT_OUTPUT_POLICY } from "../output/output-policy";
import { canonicalJson, hmac } from "../policy/canonical";
import {
  ADMIN_TOOL_NAMES,
  OPERATOR_GATEWAY_TOOL_NAMES,
  gatewayToolsForMode,
  handleToolCall,
  type McpTool,
  type ToolContentBlock,
  type ToolResult,
} from "./tools";

interface ExposedAlias {
  exposedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  targetId: string;
  targetName: string;
  targetTool: string;
  effect: "allow" | "limited_alias" | "rewrite";
  ruleId: string;
  rewrite?: PolicyRewrite;
}

export class GatewayRuntime {
  constructor(
    private db: DB,
    private cfg: GatewayConfig,
    private engine: PolicyEngine,
    private sessions: TargetSessionManager,
    private adapter: TargetAdapter,
    private policyVersion: string,
  ) {}

  /** Admin tools + policy-filtered target aliases. */
  listTools(): McpTool[] {
    const aliases = [...this.exposedSurface().values()].map((a) => ({
      name: a.exposedName,
      description: a.description,
      inputSchema: a.inputSchema,
    }));
    return [...gatewayToolsForMode(this.cfg.toolSurfaceMode), ...aliases];
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === "gateway_request_approval") {
      return this.requestApproval(args);
    }
    if (name === "gateway_list_exposed_tools") {
      const exposedTools = [...this.exposedSurface().values()].map((a) => ({
        exposedName: a.exposedName,
        targetId: a.targetId,
        targetName: a.targetName,
        targetTool: a.targetTool,
        effect: a.effect,
      }));
      return { content: [{ type: "text", text: JSON.stringify({ exposedTools }) }], _meta: { count: exposedTools.length } };
    }
    if (ADMIN_TOOL_NAMES.has(name)) {
      if (OPERATOR_GATEWAY_TOOL_NAMES.has(name) && this.cfg.toolSurfaceMode !== "operator") {
        return this.block(`operator tool not enabled in client surface: ${name}`);
      }
      return handleToolCall(name, args, { db: this.db, cfg: this.cfg, adapter: this.adapter });
    }
    if (name === "gateway_call_tool") {
      const target = getTarget(this.db, this.cfg, String(args.targetId ?? ""));
      if (!target) return this.block(`unknown target: ${String(args.targetId)}`);
      const callArgs = (args.arguments as Record<string, unknown>) ?? {};
      return this.enforce(target, String(args.tool ?? ""), callArgs); // router: real-name enforcement
    }
    const alias = this.exposedSurface().get(name);
    if (alias) {
      const target = getTarget(this.db, this.cfg, alias.targetId);
      if (!target) return this.block(`unknown target for alias: ${name}`);
        return this.enforce(target, alias.targetTool, args, {
          effect: alias.effect,
          ruleId: alias.ruleId,
          rewrite: alias.rewrite,
          exposedName: alias.exposedName,
        });
    }
    return this.block(`unknown tool: ${name}`);
  }

  private exposedSurface(): Map<string, ExposedAlias> {
    const map = new Map<string, ExposedAlias>();
    for (const t of listTargets(this.db, this.cfg)) {
      const obs = getLatestObservation(this.db, t.id);
      if (!snapshotCallable(obs)) continue; // fail-closed: expose nothing from an incomplete/stale snapshot
      const pending = new Set(
        getSnapshotTools(this.db, obs!.id)
          .filter((r) => r.exposure_status === CHANGED_PENDING)
          .map((r) => r.tool_name),
      );
      const tools = getSnapshotToolsFull(this.db, obs!.id);
      for (const exp of this.engine.evaluateList(t.name, tools)) {
        if (exp.kind !== "expose") continue;
        if (pending.has(exp.targetTool)) continue; // changed/added tool: hidden until re-reviewed
        const tool = tools.find((x) => x.name === exp.targetTool);
        map.set(exp.exposedName, {
          exposedName: exp.exposedName,
          description: `[${exp.effect}] ${t.name} -> ${exp.targetTool}`,
          inputSchema: schemaMinusHidden(tool?.inputSchema, exp.hideArguments),
          targetId: t.id,
          targetName: t.name,
          targetTool: exp.targetTool,
          effect: exp.effect,
          ruleId: exp.ruleId,
          rewrite: { injectArguments: exp.inject, hideArguments: exp.hideArguments },
        });
      }
    }
    return map;
  }

  private async enforce(
    target: TargetSpecRow,
    targetTool: string,
    userArgs: Record<string, unknown>,
    override?: { effect: "allow" | "limited_alias" | "rewrite"; ruleId: string; rewrite?: PolicyRewrite; exposedName?: string },
  ): Promise<ToolResult> {
    // 1. Fail-closed on incomplete/stale snapshot or a tool not in the approved snapshot.
    const obs = getLatestObservation(this.db, target.id);
    const row = obs ? getSnapshotTools(this.db, obs.id).find((r) => r.tool_name === targetTool) : undefined;
    if (!obs || !snapshotCallable(obs) || !row) {
      return this.decisionResult("call_blocked", "block", target, targetTool, override?.exposedName, {
        reason: !row ? "tool not in approved snapshot" : "snapshot incomplete or stale",
        isError: true,
      });
    }
    if (row.exposure_status === CHANGED_PENDING) {
      return this.decisionResult("call_blocked", "block", target, targetTool, override?.exposedName, {
        reason: "tool changed since last review; pending re-review",
        isError: true,
      });
    }

    // 2. Decision. Aliases carry their sanctioned effect; router re-evaluates by real name.
    let effect: "allow" | "limited_alias" | "rewrite";
    let rewrite: PolicyRewrite = {};
    let ruleId: string | undefined;
    if (override) {
      effect = override.effect;
      ruleId = override.ruleId;
      rewrite = override.rewrite ?? {};
    } else {
      const d = this.engine.evaluateCall(target.name, targetTool);
      if (d.type === "block")
        return this.decisionResult("call_blocked", "block", target, targetTool, undefined, { reason: d.reason, ruleId: d.ruleId, isError: true });
      if (d.type === "approval_required") {
        // Consume a matching approved+unconsumed approval (atomic), else return a pending one.
        ruleId = d.ruleId;
        const binding = this.routerBinding(target.id, targetTool, obs, row, userArgs);
        const consumedApprovalId = consumeApprovalWithId(this.db, binding);
        if (consumedApprovalId) {
          recordEvent(this.db, {
            eventType: "approval_consumed",
            tenantId: this.cfg.tenantId,
            policyVersion: this.policyVersion,
            targetId: target.id,
            observationId: obs.id,
            actorId: this.cfg.actorId,
            clientId: this.cfg.clientId,
            targetTool,
            decision: "approval_consumed",
            ruleId,
            argumentsHash: binding.argumentsHash,
            approvalId: consumedApprovalId,
            auditMetadata: { schemaHash: binding.schemaHash, rewriteHash: binding.rewriteHash },
          });
          effect = "allow"; // consumed -> proceed to forward
        } else {
          return this.pendingApproval(target.id, targetTool, binding, ruleId);
        }
      } else {
        effect = d.type;
        ruleId = d.ruleId;
        if (d.type === "rewrite") rewrite = d.rewrite;
      }
    }

    // 3. Forward to the live target session.
    if (!target.spec) {
      return this.decisionResult("call_blocked", "block", target, targetTool, override?.exposedName, {
        reason: "target has no connection spec",
        ruleId,
        isError: true,
      });
    }
    const fullTool = getSnapshotToolsFull(this.db, obs.id).find((tool) => tool.name === targetTool);
    if (effect !== "allow") {
      const argViolation = policyControlledArgViolation(userArgs, rewrite, fullTool?.inputSchema);
      if (argViolation) {
        return this.decisionResult("call_blocked", "block", target, targetTool, override?.exposedName, {
          reason: argViolation,
          ruleId,
          isError: true,
        });
      }
    }
    const effectiveArgs = effect === "allow" ? userArgs : applyRewriteArgs(userArgs, rewrite);
    const binding = this.callBinding(target.id, targetTool, obs, row, effectiveArgs, effect === "allow" ? {} : rewrite);
    let result;
    try {
      result = await this.sessions.callTool({ id: target.id, spec: target.spec }, targetTool, effectiveArgs, () => {
        this.assertSnapshotStillCallable(target.id, targetTool, obs.id);
      });
    } catch (err) {
      if (err instanceof TargetCallPreflightBlocked) {
        return this.decisionResult("call_blocked", "block", target, targetTool, override?.exposedName, {
          reason: err.message,
          ruleId,
          isError: true,
        });
      }
      return this.decisionResult("target_call_failed", "error", target, targetTool, override?.exposedName, {
        reason: `target call failed: ${String(err)}`,
        ruleId,
        isError: true,
      });
    }

    // Output policy: allowed call does not mean unfiltered return (ADR-010).
    const op = applyToolResultOutputPolicy(result, DEFAULT_OUTPUT_POLICY);
    const resultHash = auditHash(this.cfg.hmacSecret, this.cfg.tenantId, op.result ?? result);
    if (op.status === "blocked") {
      return this.decisionResult("output_blocked", "output_blocked", target, targetTool, override?.exposedName, {
        reason: op.blockedReasons.join("; "),
        ruleId,
        isError: true,
        outputPolicyStatus: "blocked",
        observationId: obs.id,
        argumentsHash: binding.argumentsHash,
        resultHash,
        redactionReport: { redactions: op.redactions, blockedReasons: op.blockedReasons },
      });
    }
    const auditEventId = recordEvent(this.db, {
      eventType: op.status === "redacted" ? "output_redacted" : "call_succeeded",
      tenantId: this.cfg.tenantId,
      policyVersion: this.policyVersion,
      targetId: target.id,
      observationId: obs.id,
      actorId: this.cfg.actorId,
      clientId: this.cfg.clientId,
      exposedTool: override?.exposedName,
      targetTool,
      decision: effect,
      ruleId,
      argumentsHash: binding.argumentsHash,
      resultHash,
      outputPolicyStatus: op.status,
      redactionReport: { redactions: op.redactions, blockedReasons: op.blockedReasons },
      auditMetadata: { schemaHash: binding.schemaHash, rewriteHash: binding.rewriteHash },
    });
    return {
      content: toToolContentBlocks(op.blocks),
      structuredContent: op.result?.structuredContent,
      isError: result.isError === true,
      _meta: { decision: effect, auditEventId, targetTool, exposedTool: override?.exposedName, outputPolicy: op.status },
    };
  }

  private decisionResult(
    eventType: string,
    decision: string,
    target: { id: string },
    targetTool: string,
    exposedTool: string | undefined,
    opts: {
      reason?: string;
      ruleId?: string;
      isError?: boolean;
      outputPolicyStatus?: string;
      observationId?: string;
      argumentsHash?: string;
      resultHash?: string;
      redactionReport?: unknown;
    },
  ): ToolResult {
    const auditEventId = recordEvent(this.db, {
      eventType,
      tenantId: this.cfg.tenantId,
      policyVersion: this.policyVersion,
      targetId: target.id,
      observationId: opts.observationId,
      actorId: this.cfg.actorId,
      clientId: this.cfg.clientId,
      exposedTool,
      targetTool,
      decision,
      ruleId: opts.ruleId,
      reason: opts.reason,
      argumentsHash: opts.argumentsHash,
      resultHash: opts.resultHash,
      outputPolicyStatus: opts.outputPolicyStatus,
      redactionReport: opts.redactionReport,
    });
    return {
      isError: opts.isError,
      content: [{ type: "text", text: JSON.stringify({ decision, reason: opts.reason, auditEventId, targetTool }) }],
      _meta: { decision, auditEventId, targetTool, exposedTool },
    };
  }

  /** Explicit approval request tool (gateway_request_approval). */
  private requestApproval(args: Record<string, unknown>): ToolResult {
    const target = getTarget(this.db, this.cfg, String(args.targetId ?? ""));
    if (!target) return this.block(`unknown target: ${String(args.targetId)}`);
    const targetTool = String(args.tool ?? "");
    const obs = getLatestObservation(this.db, target.id);
    const row = obs ? getSnapshotTools(this.db, obs.id).find((r) => r.tool_name === targetTool) : undefined;
    if (!obs || !snapshotCallable(obs) || !row) {
      return this.decisionResult("call_blocked", "block", target, targetTool, undefined, {
        reason: !row ? "tool not in approved snapshot" : "snapshot incomplete or stale",
        isError: true,
      });
    }
    const userArgs = (args.arguments as Record<string, unknown>) ?? {};
    const binding = this.routerBinding(target.id, targetTool, obs, row, userArgs);
    return this.pendingApproval(target.id, targetTool, binding);
  }

  /** Binding for a direct (router) call: no rewrite; effective args = user args. */
  private routerBinding(
    targetId: string,
    targetTool: string,
    obs: ObservationRow,
    row: SnapshotToolRow,
    userArgs: Record<string, unknown>,
  ): ApprovalBinding {
    return computeBinding(this.cfg.hmacSecret, {
      tenantId: this.cfg.tenantId,
      targetId,
      actorId: this.cfg.actorId,
      clientId: this.cfg.clientId,
      targetTool,
      effectiveArgs: userArgs,
      policyVersion: this.policyVersion,
      observationId: obs.id,
      schemaHash: schemaBindingHash(row),
      rewrite: {},
    });
  }

  private callBinding(
    targetId: string,
    targetTool: string,
    obs: ObservationRow,
    row: SnapshotToolRow,
    effectiveArgs: Record<string, unknown>,
    rewrite: unknown,
  ): ApprovalBinding {
    return computeBinding(this.cfg.hmacSecret, {
      tenantId: this.cfg.tenantId,
      targetId,
      actorId: this.cfg.actorId,
      clientId: this.cfg.clientId,
      targetTool,
      effectiveArgs,
      policyVersion: this.policyVersion,
      observationId: obs.id,
      schemaHash: schemaBindingHash(row),
      rewrite,
    });
  }

  private assertSnapshotStillCallable(targetId: string, targetTool: string, originalObservationId: string): void {
    const latest = getLatestObservation(this.db, targetId);
    const latestRow = latest ? getSnapshotTools(this.db, latest.id).find((r) => r.tool_name === targetTool) : undefined;
    if (!latest || !snapshotCallable(latest) || !latestRow) {
      throw new TargetCallPreflightBlocked(!latestRow ? "tool not in approved snapshot before forwarding" : "snapshot incomplete or stale before forwarding");
    }
    if (latest.id !== originalObservationId) {
      throw new TargetCallPreflightBlocked("snapshot changed before forwarding");
    }
    if (latestRow.exposure_status === CHANGED_PENDING) {
      throw new TargetCallPreflightBlocked("tool changed since last review before forwarding");
    }
  }

  private pendingApproval(targetId: string, targetTool: string, binding: ApprovalBinding, ruleId?: string): ToolResult {
    const { approvalId, expiresAt } = createApproval(this.db, binding);
    const auditEventId = recordEvent(this.db, {
      eventType: "approval_required",
      tenantId: this.cfg.tenantId,
      policyVersion: this.policyVersion,
      targetId,
      observationId: binding.observationId,
      actorId: this.cfg.actorId,
      clientId: this.cfg.clientId,
      targetTool,
      decision: "approval_required",
      ruleId,
      reason: "approval required",
      argumentsHash: binding.argumentsHash,
      approvalId,
      auditMetadata: { schemaHash: binding.schemaHash, rewriteHash: binding.rewriteHash },
    });
    attachRequestedEvent(this.db, this.cfg.tenantId, approvalId, auditEventId);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            decision: "approval_required",
            approvalId,
            expiresAt,
            binding: {
              argumentsHash: binding.argumentsHash,
              policyVersion: binding.policyVersion,
              observationId: binding.observationId,
              schemaHash: binding.schemaHash,
              rewriteHash: binding.rewriteHash,
            },
            auditEventId,
            targetTool,
          }),
        },
      ],
      _meta: { decision: "approval_required", auditEventId, approvalId },
    };
  }

  private block(reason: string): ToolResult {
    const auditEventId = recordEvent(this.db, {
      eventType: "call_blocked",
      tenantId: this.cfg.tenantId,
      policyVersion: this.policyVersion,
      decision: "block",
      reason,
    });
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ decision: "block", reason, auditEventId }) }],
      _meta: { decision: "block", auditEventId },
    };
  }
}

function applyRewriteArgs(userArgs: Record<string, unknown>, rewrite: PolicyRewrite): Record<string, unknown> {
  const out = { ...userArgs };
  for (const key of rewrite.hideArguments ?? []) delete out[key];
  return { ...out, ...(rewrite.injectArguments ?? {}) };
}

function policyControlledArgViolation(
  userArgs: Record<string, unknown>,
  rewrite: PolicyRewrite,
  inputSchema: unknown,
): string | undefined {
  const userKeys = Object.keys(userArgs);
  if (userKeys.length === 0) return undefined;

  const allowed = inputSchemaPropertyKeys(inputSchema);
  if (!allowed) return "policy-controlled call cannot accept caller arguments without an object input schema";

  const controlled = new Set([
    ...(rewrite.hideArguments ?? []),
    ...Object.keys(rewrite.injectArguments ?? {}),
  ]);
  const allowedUserKeys = new Set([...allowed].filter((key) => !controlled.has(key)));
  for (const key of userKeys) {
    if (!allowed.has(key)) return `argument not allowed by target schema for policy-controlled call: ${key}`;
    if (!allowedUserKeys.has(key)) return `argument controlled by policy and must not be supplied by caller: ${key}`;
  }
  return undefined;
}

function inputSchemaPropertyKeys(inputSchema: unknown): Set<string> | undefined {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return undefined;
  const properties = (inputSchema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  return new Set(Object.keys(properties));
}

function toToolContentBlocks(blocks: unknown[]): ToolContentBlock[] {
  return blocks.map((block) => {
    if (block && typeof block === "object" && typeof (block as { type?: unknown }).type === "string") {
      return block as ToolContentBlock;
    }
    return { type: "text", text: block === undefined ? "" : typeof block === "string" ? block : JSON.stringify(block) };
  });
}

function schemaMinusHidden(schema: unknown, hide?: string[]): Record<string, unknown> {
  const base =
    schema && typeof schema === "object"
      ? (structuredClone(schema) as Record<string, unknown>)
      : { type: "object", properties: {} };
  if (hide && base.properties && typeof base.properties === "object") {
    for (const h of hide) delete (base.properties as Record<string, unknown>)[h];
  }
  if (hide && Array.isArray(base.required)) {
    base.required = (base.required as string[]).filter((r) => !hide.includes(r));
  }
  return base;
}

function schemaBindingHash(row: SnapshotToolRow): string {
  return `input:${row.input_schema_hash ?? ""}\noutput:${row.output_schema_hash ?? ""}`;
}

function auditHash(secret: string, tenantId: string, value: unknown): string {
  return hmac(secret, `${tenantId}\n${canonicalJson(value)}`);
}
