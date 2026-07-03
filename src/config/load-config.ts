// Gateway configuration.
//
// ADR-011: In the stdio MVP there is no authenticated upstream caller, so
// tenant/client/actor identity is a single configured principal injected here.
// Per-actor enforcement and audit require an authenticated transport (later).
import path from "node:path";
import type { EgressPolicy } from "../targets/egress-guard";

export interface GatewayConfig {
  tenantId: string;
  clientId: string;
  actorId: string;
  dbPath: string;
  policyPath?: string;
  /** Tenant-scoped secret for HMAC hashing (policy version, args hash). */
  hmacSecret: string;
  /**
   * ADR-012: executables permitted for stdio target registration. Empty = dev
   * mode (allowed with a warning). Non-empty = enforced allowlist.
   */
  executableAllowlist: string[];
  /** Local-dev escape hatch. Must be true to allow an empty executable allowlist. */
  allowUnlistedExecutables?: boolean;
  /** Client mode exposes runtime tools only; operator mode also exposes control-plane tools. */
  toolSurfaceMode: "client" | "operator";
  /** Stdio child processes inherit only these non-secret environment keys. */
  stdioEnvKeys: string[];
  /** SSRF egress policy for HTTP targets (ADR-006 / T10). */
  egress: EgressPolicy;
}

const DEV_HMAC_SECRET = "dev-insecure-hmac-secret-change-me";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const hmacSecret = env.GATEWAY_HMAC_SECRET ?? DEV_HMAC_SECRET;
  if (hmacSecret === DEV_HMAC_SECRET) {
    console.error("[gateway] WARNING: using insecure dev HMAC secret. Set GATEWAY_HMAC_SECRET for real use.");
  }
  return {
    tenantId: env.GATEWAY_TENANT_ID ?? "default-tenant",
    clientId: env.GATEWAY_CLIENT_ID ?? "default-client",
    actorId: env.GATEWAY_ACTOR_ID ?? "default-actor",
    dbPath: env.GATEWAY_DB_PATH ?? path.resolve(".data/gateway.sqlite"),
    policyPath: env.GATEWAY_POLICY_PATH,
    hmacSecret,
    executableAllowlist: (env.GATEWAY_EXEC_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowUnlistedExecutables: env.GATEWAY_ALLOW_UNLISTED_EXECUTABLES === "true" || env.GATEWAY_DEV_MODE === "true",
    toolSurfaceMode: env.GATEWAY_TOOL_SURFACE_MODE === "operator" ? "operator" : "client",
    stdioEnvKeys: (env.GATEWAY_STDIO_ENV_KEYS ?? "PATH,SystemRoot,WINDIR,ComSpec")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    egress: {
      allowedSchemes: (env.GATEWAY_EGRESS_SCHEMES ?? "https")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      allowedHosts: env.GATEWAY_EGRESS_HOSTS
        ? env.GATEWAY_EGRESS_HOSTS.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      allowPrivate: env.GATEWAY_EGRESS_ALLOW_PRIVATE === "true",
    },
  };
}
