// Minimal append-only audit event recorder (ADR-005).
// Phase 3 records the decision outcome per call; redaction hardening and richer
// evidence land in Phase 4. Stores only metadata — never raw arguments/results.
import crypto from "node:crypto";
import type { DB } from "../storage/db";

export interface AuditInput {
  eventType: string;
  tenantId: string;
  policyVersion: string;
  targetId?: string;
  actorId?: string;
  clientId?: string;
  exposedTool?: string;
  targetTool?: string;
  decision?: string;
  ruleId?: string;
  reason?: string;
  observationId?: string;
  argumentsHash?: string;
  resultHash?: string;
  outputPolicyStatus?: string;
  redactionReport?: unknown;
  approvalId?: string;
  auditMetadata?: unknown;
}

/** Insert one audit event; returns its id (used as the caller-visible auditEventId). */
export function recordEvent(db: DB, e: AuditInput): string {
  const id = crypto.randomUUID();
  db.prepare(
    `insert into mcp_policy_events
       (id, event_type, tenant_id, target_id, observation_id, policy_version, actor_id, client_id,
        exposed_tool, target_tool, decision, rule_id, reason, arguments_hash, result_hash, output_policy_status,
        redaction_report, approval_id, audit_metadata)
     values (@id, @et, @tenant, @target, @obs, @pv, @actor, @client,
        @exposed, @tool, @decision, @rule, @reason, @argsHash, @resultHash, @ops,
        @redactionReport, @approval, @metadata)`,
  ).run({
    id,
    et: e.eventType,
    tenant: e.tenantId,
    target: e.targetId ?? null,
    obs: e.observationId ?? null,
    pv: e.policyVersion,
    actor: e.actorId ?? null,
    client: e.clientId ?? null,
    exposed: e.exposedTool ?? null,
    tool: e.targetTool ?? null,
    decision: e.decision ?? null,
    rule: e.ruleId ?? null,
    reason: e.reason ?? null,
    argsHash: e.argumentsHash ?? null,
    resultHash: e.resultHash ?? null,
    ops: e.outputPolicyStatus ?? null,
    redactionReport: e.redactionReport === undefined ? null : JSON.stringify(e.redactionReport),
    approval: e.approvalId ?? null,
    metadata: e.auditMetadata === undefined ? null : JSON.stringify(e.auditMetadata),
  });
  return id;
}

export interface AuditEventReadView {
  auditEventId: string;
  eventType: string;
  targetId: string | null;
  targetTool: string | null;
  exposedTool: string | null;
  decision: string | null;
  ruleId: string | null;
  reason: string | null;
  actorId: string | null;
  clientId: string | null;
  policyVersion: string;
  policyContentAvailable: boolean;
  observationId: string | null;
  argumentsHash: string | null;
  resultHash: string | null;
  approvalId: string | null;
  outputPolicyStatus: string | null;
  redactionReport: unknown | null;
  auditMetadata: unknown | null;
  redacted: true;
  rawArgumentsStored: false;
  rawResultStored: false;
}

/**
 * Read-side, tenant-scoped, minimal-metadata view (ADR / audit read privacy).
 * Never returns raw arguments/results — only hashes were ever stored, and this
 * view omits even those. Returns undefined if the event is absent or out of the
 * caller's tenant scope (RBAC).
 */
export function getEventForRead(db: DB, tenantId: string, auditEventId: string): AuditEventReadView | undefined {
  const row = db
    .prepare(
      `select e.id, e.event_type, e.target_id, e.observation_id, e.target_tool, e.exposed_tool,
              e.decision, e.rule_id, e.reason, e.actor_id, e.client_id, e.policy_version,
              e.arguments_hash, e.result_hash, e.approval_id, e.output_policy_status,
              e.redaction_report, e.audit_metadata, p.version as persisted_policy_version
         from mcp_policy_events e
         left join mcp_policies p on p.version = e.policy_version and p.tenant_id = e.tenant_id
         where e.id = ? and e.tenant_id = ?`,
    )
    .get(auditEventId, tenantId) as
    | {
        id: string;
        event_type: string;
        target_id: string | null;
        target_tool: string | null;
        exposed_tool: string | null;
        decision: string | null;
        rule_id: string | null;
        reason: string | null;
        actor_id: string | null;
        client_id: string | null;
        policy_version: string;
        observation_id: string | null;
        arguments_hash: string | null;
        result_hash: string | null;
        approval_id: string | null;
        output_policy_status: string | null;
        redaction_report: string | null;
        audit_metadata: string | null;
        persisted_policy_version: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    auditEventId: row.id,
    eventType: row.event_type,
    targetId: row.target_id,
    targetTool: row.target_tool,
    exposedTool: row.exposed_tool,
    decision: row.decision,
    ruleId: row.rule_id,
    reason: row.reason,
    actorId: row.actor_id,
    clientId: row.client_id,
    policyVersion: row.policy_version,
    policyContentAvailable: row.persisted_policy_version !== null,
    observationId: row.observation_id,
    argumentsHash: row.arguments_hash,
    resultHash: row.result_hash,
    approvalId: row.approval_id,
    outputPolicyStatus: row.output_policy_status,
    redactionReport: redactForRead(parseJson(row.redaction_report)),
    auditMetadata: redactForRead(parseJson(row.audit_metadata)),
    redacted: true,
    rawArgumentsStored: false,
    rawResultStored: false,
  };
}

function parseJson(raw: string | null): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return "[REDACTED]";
  }
}

function redactForRead(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactForRead);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = secretLikeKey(k) ? "[REDACTED]" : redactForRead(v);
    }
    return out;
  }
  return value;
}

function secretLikeKey(key: string): boolean {
  return /secret|token|password|passwd|api[_-]?key|authorization|bearer|credential/i.test(key);
}

function redactText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9]{16,}/g, "[REDACTED]")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "[REDACTED]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]");
}
