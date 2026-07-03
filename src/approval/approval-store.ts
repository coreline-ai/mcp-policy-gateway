// Approval store (ADR-004).
//
// An approval binds the exact call: tenant/target/tool + argumentsHash (JCS,
// post-rewrite) + policyVersion + observationId + schemaHash + rewriteHash, with
// a short TTL and atomic one-time consume. Any drift in a bound field means the
// call computes a different binding, so a stale approval simply never matches
// (fail-closed). Consume is a single conditional UPDATE — atomic, so replay and
// concurrent reuse both lose the race.
import crypto from "node:crypto";
import type { DB } from "../storage/db";
import { argumentsHash, rewriteHash } from "../policy/args-hash";
import { recordEvent } from "../audit/audit-log";

export const DEFAULT_TTL_SECONDS = 600; // <= 10 min (ADR / security defaults)

export interface ApprovalBinding {
  tenantId: string;
  targetId: string;
  actorId?: string;
  clientId?: string;
  targetTool: string;
  argumentsHash: string;
  policyVersion: string;
  observationId: string;
  schemaHash: string;
  rewriteHash: string;
}

export interface BindingInput {
  tenantId: string;
  targetId: string;
  actorId?: string;
  clientId?: string;
  targetTool: string;
  effectiveArgs: unknown;
  policyVersion: string;
  observationId: string;
  schemaHash: string;
  rewrite?: unknown;
}

export function computeBinding(secret: string, input: BindingInput): ApprovalBinding {
  return {
    tenantId: input.tenantId,
    targetId: input.targetId,
    actorId: input.actorId,
    clientId: input.clientId,
    targetTool: input.targetTool,
    argumentsHash: argumentsHash(secret, input.tenantId, input.effectiveArgs),
    policyVersion: input.policyVersion,
    observationId: input.observationId,
    schemaHash: input.schemaHash,
    rewriteHash: rewriteHash(secret, input.tenantId, input.rewrite ?? {}),
  };
}

function iso(offsetSeconds = 0): string {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

/** Create (or reuse an existing) pending approval for a binding. Returns approvalId + expiry. */
export function createApproval(
  db: DB,
  b: ApprovalBinding,
  opts: { ttlSeconds?: number; requestedEventId?: string } = {},
): { approvalId: string; expiresAt: string; reused: boolean } {
  const existing = db
    .prepare(
      `select id, expires_at from mcp_approvals
        where tenant_id=@tenant and target_id=@target and target_tool=@tool
          and actor_id is @actor and client_id is @client
          and arguments_hash=@ah and policy_version=@pv and observation_id=@obs
          and schema_hash=@sh and rewrite_hash=@rh and status='pending' and expires_at > @now`,
    )
    .get({ ...bindParams(b), now: iso() }) as { id: string; expires_at: string } | undefined;
  if (existing) return { approvalId: existing.id, expiresAt: existing.expires_at, reused: true };

  const approvalId = crypto.randomUUID();
  const expiresAt = iso(opts.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const now = iso();
  db.prepare(
    `insert into mcp_approvals
       (id, tenant_id, target_id, actor_id, client_id, target_tool, arguments_hash,
        policy_version, observation_id, schema_hash, rewrite_hash, status,
        requested_event_id, expires_at, created_at, updated_at)
     values (@id, @tenant, @target, @actor, @client, @tool, @ah,
             @pv, @obs, @sh, @rh, 'pending',
             @reqEvent, @expires, @now, @now)`,
  ).run({
    id: approvalId,
    ...bindParams(b),
    reqEvent: opts.requestedEventId ?? null,
    expires: expiresAt,
    now,
  });
  return { approvalId, expiresAt, reused: false };
}

export interface ApprovalDecisionAudit {
  actorId?: string;
  clientId?: string;
  policyVersion?: string;
}

export function grantApproval(db: DB, tenantId: string, approvalId: string, audit?: ApprovalDecisionAudit): boolean {
  const info = db
    .prepare(
      `update mcp_approvals set status='approved', updated_at=@now
        where id=@id and tenant_id=@tenant and status='pending' and expires_at > @now`,
    )
    .run({ id: approvalId, tenant: tenantId, now: iso() });
  if (info.changes === 1) auditApprovalDecision(db, tenantId, approvalId, "approval_granted", audit);
  return info.changes === 1;
}

export function rejectApproval(db: DB, tenantId: string, approvalId: string, audit?: ApprovalDecisionAudit): boolean {
  const info = db
    .prepare(
      `update mcp_approvals set status='rejected', updated_at=@now
        where id=@id and tenant_id=@tenant and status='pending'`,
    )
    .run({ id: approvalId, tenant: tenantId, now: iso() });
  if (info.changes === 1) auditApprovalDecision(db, tenantId, approvalId, "approval_rejected", audit);
  return info.changes === 1;
}

/**
 * Atomic one-time consume. A single conditional UPDATE: matches an approved,
 * non-expired approval whose entire binding equals the call's binding, and flips
 * it to 'used'. Returns true iff exactly one row was consumed.
 */
export function consumeApproval(db: DB, b: ApprovalBinding): boolean {
  return consumeApprovalWithId(db, b) !== undefined;
}

export function consumeApprovalWithId(db: DB, b: ApprovalBinding): string | undefined {
  const now = iso();
  const row = db
    .prepare(
      `select id from mcp_approvals
        where tenant_id=@tenant and target_id=@target and target_tool=@tool
          and actor_id is @actor and client_id is @client
          and arguments_hash=@ah and policy_version=@pv and observation_id=@obs
          and schema_hash=@sh and rewrite_hash=@rh and status='approved' and expires_at > @now
        order by created_at limit 1`,
    )
    .get({ ...bindParams(b), now }) as { id: string } | undefined;
  if (!row) return undefined;
  const info = db
    .prepare(
      `update mcp_approvals set status='used', consumed_at=@now, updated_at=@now
        where id=@id and tenant_id=@tenant and status='approved' and expires_at > @now`,
    )
    .run({ ...bindParams(b), id: row.id, now });
  return info.changes === 1 ? row.id : undefined;
}

export function attachRequestedEvent(db: DB, tenantId: string, approvalId: string, eventId: string): void {
  db.prepare(
    `update mcp_approvals set requested_event_id=@event, updated_at=@now
      where tenant_id=@tenant and id=@id and requested_event_id is null`,
  ).run({ event: eventId, tenant: tenantId, id: approvalId, now: iso() });
}

function auditApprovalDecision(
  db: DB,
  tenantId: string,
  approvalId: string,
  eventType: "approval_granted" | "approval_rejected",
  audit?: ApprovalDecisionAudit,
): void {
  const row = db
    .prepare(
      `select target_id, target_tool, policy_version from mcp_approvals
        where tenant_id = ? and id = ?`,
    )
    .get(tenantId, approvalId) as { target_id: string; target_tool: string; policy_version: string } | undefined;
  if (!row) return;
  const eventId = recordEvent(db, {
    eventType,
    tenantId,
    policyVersion: audit?.policyVersion ?? row.policy_version ?? "operator",
    targetId: row.target_id,
    actorId: audit?.actorId,
    clientId: audit?.clientId,
    targetTool: row.target_tool,
    decision: eventType,
    approvalId,
  });
  db.prepare(
    `update mcp_approvals set decided_event_id=@event, updated_at=@now
      where tenant_id=@tenant and id=@id`,
  ).run({ event: eventId, tenant: tenantId, id: approvalId, now: iso() });
}

function bindParams(b: ApprovalBinding) {
  return {
    tenant: b.tenantId,
    target: b.targetId,
    actor: b.actorId ?? null,
    client: b.clientId ?? null,
    tool: b.targetTool,
    ah: b.argumentsHash,
    pv: b.policyVersion,
    obs: b.observationId,
    sh: b.schemaHash,
    rh: b.rewriteHash,
  };
}
