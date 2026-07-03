// Tool-set normalization + hashing.
// Normalization makes the snapshot hash order-independent and default-stable so
// "the same observed tools" always yield the same normalized_hash.
import { canonicalJson, hmac } from "../policy/canonical";
import type { RawTool } from "./target-adapter";

export interface NormalizedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

export function normalizeTools(raw: RawTool[]): NormalizedTool[] {
  return [...raw]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? null,
      outputSchema: t.outputSchema ?? null,
    }));
}

function h(secret: string, tenant: string, value: unknown): string {
  return hmac(secret, `${tenant}\n${canonicalJson(value)}`);
}

export interface ToolHashes {
  descriptionHash: string;
  inputSchemaHash: string;
  outputSchemaHash: string;
}

export function toolHashes(secret: string, tenant: string, t: NormalizedTool): ToolHashes {
  return {
    descriptionHash: h(secret, tenant, t.description),
    inputSchemaHash: h(secret, tenant, t.inputSchema),
    outputSchemaHash: h(secret, tenant, t.outputSchema),
  };
}

/** HMAC over the full normalized tool set — the observation's normalized_hash. */
export function observationHash(secret: string, tenant: string, tools: NormalizedTool[]): string {
  return h(secret, tenant, tools);
}
