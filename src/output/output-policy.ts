// Output policy (ADR-010, D23). Applied to an ALLOWED tool result before it is
// returned to the client. This is BEST-EFFORT, never a complete DLP guarantee —
// only deterministic cases are enforced:
//   - text: redact well-known secret/token patterns
//   - resource_link: scheme/host allowlist (disallowed => block)
//   - embedded resource: blocked by default
//   - image/audio and other blocks: passed through (fidelity/size limits: later)
import type { TargetCallResult } from "../catalog/target-adapter";

export interface OutputPolicyConfig {
  allowedResourceSchemes: string[];
  allowedResourceHosts?: string[];
  allowedResourcePaths?: string[];
  blockEmbeddedResources: boolean;
}

export const DEFAULT_OUTPUT_POLICY: OutputPolicyConfig = {
  allowedResourceSchemes: ["https"],
  blockEmbeddedResources: true,
};

// Deterministic, high-signal patterns only (D23 — no general PII/secret guarantee).
const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/g, // generic API key
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack token
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, // PEM private key header
];

export interface OutputPolicyResult {
  blocks: unknown[];
  result?: TargetCallResult;
  status: "passed" | "redacted" | "blocked";
  redactions: number;
  blockedReasons: string[];
}

export function applyOutputPolicy(content: unknown, cfg: OutputPolicyConfig = DEFAULT_OUTPUT_POLICY): OutputPolicyResult {
  if (!Array.isArray(content)) {
    return { blocks: content === undefined ? [] : [content], status: "passed", redactions: 0, blockedReasons: [] };
  }
  const out: unknown[] = [];
  const blockedReasons: string[] = [];
  let redactions = 0;

  for (const b of content) {
    if (!b || typeof b !== "object") {
      out.push(b);
      continue;
    }
    const block = b as Record<string, unknown>;
    switch (block.type) {
      case "text": {
        const { text, n } = redactText(String(block.text ?? ""));
        redactions += n;
        out.push({ ...block, text });
        break;
      }
      case "resource_link": {
        const reason = checkResourceLink(block.uri, cfg);
        if (reason) blockedReasons.push(reason);
        else out.push(block);
        break;
      }
      case "resource": {
        if (cfg.blockEmbeddedResources) blockedReasons.push("embedded resource blocked by default");
        else out.push(block);
        break;
      }
      default:
        out.push(block);
    }
  }

  const status = blockedReasons.length > 0 ? "blocked" : redactions > 0 ? "redacted" : "passed";
  return { blocks: status === "blocked" ? [] : out, status, redactions, blockedReasons };
}

/** Apply output policy to the full MCP tool result, including structuredContent. */
export function applyToolResultOutputPolicy(
  result: TargetCallResult,
  cfg: OutputPolicyConfig = DEFAULT_OUTPUT_POLICY,
): OutputPolicyResult {
  const content = applyOutputPolicy(result.content, cfg);
  if (content.status === "blocked") {
    return { ...content, result: { ...result, content: [] } };
  }

  let structuredContent = result.structuredContent;
  let structuredRedactions = 0;
  const blockedReasons: string[] = [...content.blockedReasons];
  if (structuredContent !== undefined) {
    const scrubbed = scrubStructured(structuredContent, cfg, "$.structuredContent");
    structuredContent = scrubbed.value;
    structuredRedactions = scrubbed.redactions;
    blockedReasons.push(...scrubbed.blockedReasons);
  }

  const redactions = content.redactions + structuredRedactions;
  const status = blockedReasons.length > 0 ? "blocked" : redactions > 0 || content.status === "redacted" ? "redacted" : "passed";
  return {
    blocks: status === "blocked" ? [] : content.blocks,
    result: status === "blocked" ? { ...result, content: [] } : { ...result, content: content.blocks, structuredContent },
    status,
    redactions,
    blockedReasons,
  };
}

/** Join text blocks into a single string for the (text-only) upstream result. */
export function joinTextBlocks(blocks: unknown[]): string {
  return blocks
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : JSON.stringify(b)))
    .join("\n");
}

function redactText(s: string): { text: string; n: number } {
  let n = 0;
  let text = s;
  for (const re of PATTERNS) {
    text = text.replace(re, () => {
      n++;
      return "[REDACTED]";
    });
  }
  return { text, n };
}

function checkResourceLink(uri: unknown, cfg: OutputPolicyConfig): string | undefined {
  try {
    const u = new URL(String(uri));
    const scheme = u.protocol.replace(/:$/, "");
    if (!cfg.allowedResourceSchemes.includes(scheme)) return `disallowed resource_link scheme: ${scheme}`;
    if (cfg.allowedResourceHosts && !cfg.allowedResourceHosts.includes(u.host)) return `disallowed resource_link host: ${u.host}`;
    if (cfg.allowedResourcePaths && !cfg.allowedResourcePaths.some((p) => u.pathname.startsWith(p))) {
      return `disallowed resource_link path: ${u.pathname}`;
    }
    return undefined;
  } catch {
    return "invalid resource_link uri";
  }
}

function scrubStructured(
  value: unknown,
  cfg: OutputPolicyConfig,
  path: string,
): { value: unknown; redactions: number; blockedReasons: string[] } {
  if (typeof value === "string") {
    const urlReason = looksLikeUrl(value) ? checkResourceLink(value, cfg) : undefined;
    const { text, n } = redactText(value);
    return { value: text, redactions: n, blockedReasons: urlReason ? [`${path}: ${urlReason}`] : [] };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let redactions = 0;
    const blockedReasons: string[] = [];
    value.forEach((v, i) => {
      const r = scrubStructured(v, cfg, `${path}[${i}]`);
      out.push(r.value);
      redactions += r.redactions;
      blockedReasons.push(...r.blockedReasons);
    });
    return { value: out, redactions, blockedReasons };
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "resource" && cfg.blockEmbeddedResources) {
      return { value: undefined, redactions: 0, blockedReasons: [`${path}: embedded resource blocked by default`] };
    }
    if (obj.type === "resource_link" && "uri" in obj) {
      const reason = checkResourceLink(obj.uri, cfg);
      if (reason) return { value: undefined, redactions: 0, blockedReasons: [`${path}: ${reason}`] };
    }
    const out: Record<string, unknown> = {};
    let redactions = 0;
    const blockedReasons: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const r = scrubStructured(v, cfg, `${path}.${k}`);
      if (r.value !== undefined) out[k] = r.value;
      redactions += r.redactions;
      blockedReasons.push(...r.blockedReasons);
    }
    return { value: out, redactions, blockedReasons };
  }
  return { value, redactions: 0, blockedReasons: [] };
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}
