import crypto from "node:crypto";

/**
 * Deterministic, stable JSON serialization (sorted object keys) used for hashing
 * policy content. NOTE: this is NOT RFC 8785. Per ADR-013, the approval
 * `argumentsHash` (Phase 4) uses full RFC 8785 JSON Canonicalization over the
 * post-rewrite effective arguments; that is a separate, stricter code path.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Tenant-scoped HMAC-SHA-256, prefixed for self-describing storage. */
export function hmac(secret: string, data: string): string {
  return "hmac-sha256:" + crypto.createHmac("sha256", secret).update(data).digest("hex");
}
