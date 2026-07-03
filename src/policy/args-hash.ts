// RFC 8785 (JSON Canonicalization Scheme) for the approval argumentsHash (ADR-013).
//
// For JSON values this is: recursive serialization with object keys sorted by
// UTF-16 code unit, ECMAScript Number->String for numbers (what JSON.stringify
// already emits), and JSON string escaping. `null` and a missing key are
// distinct; `undefined` values are omitted (JSON has no undefined).
import { hmac } from "./canonical";

export function jcsCanonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") {
    if (!Number.isFinite(v as number)) throw new Error("JCS: non-finite number not allowed");
    return JSON.stringify(v); // shortest round-trip == RFC 8785 number rule
  }
  if (t === "boolean") return (v as boolean) ? "true" : "false";
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(serialize).join(",") + "]";
  if (t === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort(); // UTF-16 code-unit order
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + serialize(o[k])).join(",") + "}";
  }
  throw new Error(`JCS: unsupported type ${t}`);
}

/** Tenant-scoped HMAC over the canonicalized POST-REWRITE effective arguments. */
export function argumentsHash(secret: string, tenant: string, effectiveArgs: unknown): string {
  return hmac(secret, `${tenant}\n${jcsCanonicalize(effectiveArgs ?? {})}`);
}

/** Hash of the alias/rewrite definition (inject + hidden args); {} for a direct call. */
export function rewriteHash(secret: string, tenant: string, rewrite: unknown): string {
  return hmac(secret, `${tenant}\n${jcsCanonicalize(rewrite ?? {})}`);
}
