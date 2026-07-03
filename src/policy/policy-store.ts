// Policy version store (ADR-014).
// Derives a deterministic tenant-scoped version hash over canonical policy
// content and persists the exact content so any audit event can reproduce the
// decision it was evaluated under.
import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import type { DB } from "../storage/db";
import { canonicalJson, hmac } from "./canonical";
import { validatePolicyDoc, PolicyValidationError } from "./engine";

export { PolicyValidationError };

export interface LoadedPolicy {
  version: string;
  content: unknown;
}

export function storePolicyContent(
  db: DB,
  cfg: { tenantId: string; hmacSecret: string; actorId?: string },
  content: unknown,
): string {
  validatePolicyDoc(content);
  const canonical = canonicalJson(content);
  const version = hmac(cfg.hmacSecret, `${cfg.tenantId}\n${canonical}`);
  const now = new Date().toISOString();
  db.prepare(
    `insert into mcp_policies (version, tenant_id, content_hash, normalized_policy, author_actor_id, activated_at, created_at)
     values (@version, @tenant, @hash, @norm, @actor, @now, @now)
     on conflict(version) do nothing`,
  ).run({ version, tenant: cfg.tenantId, hash: version, norm: canonical, actor: cfg.actorId ?? null, now });
  return version;
}

export function loadAndStorePolicy(
  db: DB,
  cfg: { tenantId: string; hmacSecret: string; actorId?: string },
  policyPath: string,
): LoadedPolicy {
  const content = parseYaml(fs.readFileSync(policyPath, "utf8")) as unknown;
  const version = storePolicyContent(db, cfg, content);
  return { version, content };
}
