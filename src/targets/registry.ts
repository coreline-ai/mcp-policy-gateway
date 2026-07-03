// Target registry.
// ADR-012: writing to the registry is a privileged config/operator action, not
// runtime user input — registering a stdio target is an execution boundary, so
// the executable must pass the configured allowlist (when one is set).
import crypto from "node:crypto";
import type { DB } from "../storage/db";
import type { TargetSpawnSpec } from "../catalog/target-adapter";
import { validateUrlShape, EgressBlockedError, type EgressPolicy, DEFAULT_EGRESS } from "./egress-guard";
import { recordEvent } from "../audit/audit-log";

export interface TargetRow {
  id: string;
  name: string;
  kind: string;
  status: string;
}

export interface RegisterTargetInput {
  name: string;
  kind: string;
  /** stdio spawn spec. Must not contain secret literals in args — refs only. */
  command?: TargetSpawnSpec;
  endpointUrl?: string;
}

export interface RegistryConfig {
  tenantId: string;
  actorId?: string;
  clientId?: string;
  policyVersion?: string;
  executableAllowlist?: string[];
  allowUnlistedExecutables?: boolean;
  egress?: EgressPolicy;
}

export class TargetRegistrationError extends Error {}

const HTTP_KINDS = new Set(["http", "streamable-http"]);

export function registerTarget(db: DB, cfg: RegistryConfig, input: RegisterTargetInput): string {
  const reject = (message: string): never => {
    auditRegistration(db, cfg, "target_registration_rejected", undefined, input, message);
    throw new TargetRegistrationError(message);
  };
  if (input.kind === "stdio") {
    if (input.endpointUrl) {
      reject("stdio target must not include an endpointUrl");
    }
    if (!input.command?.command) {
      reject("stdio target requires a command spec");
    }
    const commandSpec = input.command as TargetSpawnSpec & { command: string };
    if (hasHttpSpecFields(commandSpec)) {
      reject("stdio target must not include http spec fields");
    }
    if (hasEnvValues(commandSpec)) {
      reject("stdio target env injection is not supported in the MVP; use an env profile/secret store reference in a later scope");
    }
    try {
      rejectSecretBearingSpec(commandSpec);
    } catch (e) {
      reject(e instanceof TargetRegistrationError ? e.message : String(e));
    }
    const allowlist = cfg.executableAllowlist ?? [];
    if (allowlist.length > 0 && !allowlist.includes(commandSpec.command)) {
      reject(`executable not in allowlist: ${commandSpec.command}`);
    }
    if (allowlist.length === 0) {
      if (cfg.allowUnlistedExecutables !== true) {
        reject("executable allowlist empty in fail-closed mode");
      }
      console.error("[registry] WARNING: executable allowlist empty; allowing any stdio command (dev mode).");
    }
  } else if (HTTP_KINDS.has(input.kind)) {
    // ADR-006 / T10: validate endpoint shape (scheme + literal private IP) at registration.
    // Full DNS-resolution SSRF check runs again at connect/request time.
    if (!input.endpointUrl) reject("http target requires an endpointUrl");
    const endpointUrl = input.endpointUrl as string;
    if (input.command) {
      reject("http target must not include a stdio command spec");
    }
    try {
      validateUrlShape(endpointUrl, cfg.egress ?? DEFAULT_EGRESS);
    } catch (e) {
      if (e instanceof EgressBlockedError) reject(`endpoint rejected: ${e.message}`);
      reject(`invalid endpointUrl: ${String(e)}`);
    }
  } else {
    reject(`unsupported target kind: ${input.kind}`);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `insert into mcp_targets (id, tenant_id, name, target_kind, registration_source, command, endpoint_url, status, created_at, updated_at)
     values (@id, @tenant, @name, @kind, 'privileged_config', @command, @endpoint, 'active', @now, @now)`,
  ).run({
    id,
    tenant: cfg.tenantId,
    name: input.name,
    kind: input.kind,
    command: input.command !== undefined ? JSON.stringify(input.command) : null,
    endpoint: input.endpointUrl ?? null,
    now,
  });
  auditRegistration(db, cfg, "target_registered", id, input);
  return id;
}

export function listTargets(db: DB, cfg: { tenantId: string }, status = "active"): TargetRow[] {
  return db
    .prepare(
      `select id, name, target_kind as kind, status
         from mcp_targets
        where tenant_id = ? and status = ?
        order by created_at`,
    )
    .all(cfg.tenantId, status) as TargetRow[];
}

export interface TargetSpecRow {
  id: string;
  name: string;
  kind: string;
  /** Kind-tagged connection spec (stdio command or http url), or null if unset. */
  spec: TargetSpawnSpec | null;
}

/** Load a single tenant-scoped target with its connection spec. */
export function getTarget(db: DB, cfg: { tenantId: string }, targetId: string): TargetSpecRow | undefined {
  const row = db
    .prepare(
      `select id, name, target_kind as kind, command, endpoint_url
         from mcp_targets where tenant_id = ? and id = ?`,
    )
    .get(cfg.tenantId, targetId) as
    | { id: string; name: string; kind: string; command: string | null; endpoint_url: string | null }
    | undefined;
  if (!row) return undefined;

  let spec: TargetSpawnSpec | null = null;
  if (row.kind === "stdio" && row.command && !row.endpoint_url) {
    const parsed = parseStoredSpec(row.command);
    if (parsed && !hasHttpSpecFields(parsed) && !hasEnvValues(parsed) && parsed.command) spec = { kind: "stdio", ...parsed };
  } else if (HTTP_KINDS.has(row.kind) && row.endpoint_url && !row.command) {
    spec = { kind: "http", url: row.endpoint_url };
  }
  return { id: row.id, name: row.name, kind: row.kind, spec };
}

function auditRegistration(
  db: DB,
  cfg: RegistryConfig,
  eventType: "target_registered" | "target_registration_rejected",
  targetId: string | undefined,
  input: RegisterTargetInput,
  reason?: string,
): void {
  recordEvent(db, {
    eventType,
    tenantId: cfg.tenantId,
    policyVersion: cfg.policyVersion ?? "registry",
    targetId,
    actorId: cfg.actorId,
    clientId: cfg.clientId,
    decision: eventType,
    reason,
    auditMetadata: {
      name: input.name,
      kind: input.kind,
      endpointUrl: input.endpointUrl ? redactUrl(input.endpointUrl) : undefined,
      executable: input.command?.command,
      argsCount: input.command?.args?.length ?? 0,
      envKeys: input.command?.env ? Object.keys(input.command.env).sort() : [],
    },
  });
}

function rejectSecretBearingSpec(spec: TargetSpawnSpec): void {
  const values = [
    spec.command,
    ...(spec.args ?? []),
    ...Object.entries(spec.env ?? {}).flatMap(([k, v]) => [k, v]),
    ...Object.entries(spec.headers ?? {}).flatMap(([k, v]) => [k, v]),
  ].filter((v): v is string => typeof v === "string");
  const hit = values.find((v) => looksSecretBearing(v));
  if (hit) throw new TargetRegistrationError(`secret literal not allowed in target registration: ${redactSecretHint(hit)}`);
}

function hasHttpSpecFields(spec: TargetSpawnSpec): boolean {
  return spec.kind === "http" || spec.url !== undefined || spec.headers !== undefined;
}

function hasEnvValues(spec: TargetSpawnSpec): boolean {
  return spec.env !== undefined && Object.keys(spec.env).length > 0;
}

function parseStoredSpec(raw: string): TargetSpawnSpec | undefined {
  try {
    const parsed = JSON.parse(raw) as TargetSpawnSpec;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function looksSecretBearing(value: string): boolean {
  return /(token|secret|password|passwd|api[_-]?key|authorization|bearer)/i.test(value)
    || /sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+\S+/i.test(value);
}

function redactSecretHint(value: string): string {
  return value.length <= 8 ? "[REDACTED]" : `${value.slice(0, 4)}...[REDACTED]`;
}

function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "[invalid-url]";
  }
}
