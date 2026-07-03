// Policy engine (ADR-003 default deny).
//
// Two resolution paths, deliberately different (matches the handoff model):
//   - LIST (exposure): what appears in upstream tools/list. block hides; a
//     limited_alias exposes the alias; allow exposes the tool; approval/default
//     stay hidden.
//   - CALL (router, real tool name): block > approval > allow > default-deny.
//     limited_alias rules do NOT grant a direct real-name call — the alias is the
//     only sanctioned limited path, reached via the alias name (override), not here.

export interface PolicyMatch {
  target?: string;
  tool?: string;
  toolNameRegex?: string;
  any?: boolean;
}

export type PolicyEffect = "allow" | "limited_alias" | "approval_required" | "block" | "rewrite";

export interface PolicyExposeAs {
  name: string;
  injectArguments?: Record<string, unknown>;
  hideArguments?: string[];
}

export interface PolicyRewrite {
  injectArguments?: Record<string, unknown>;
  hideArguments?: string[];
}

export interface PolicyRule {
  id: string;
  match: PolicyMatch;
  effect: PolicyEffect;
  exposeAs?: PolicyExposeAs;
  rewrite?: PolicyRewrite;
}

export interface PolicyDoc {
  version?: number;
  default?: "deny" | "allow";
  classifiers?: Record<string, string>;
  targets?: Record<string, unknown>;
  rules?: PolicyRule[];
}

export type ExposureDecision =
  | {
      kind: "expose";
      exposedName: string;
      targetTool: string;
      effect: "allow" | "limited_alias" | "rewrite";
      inject?: Record<string, unknown>;
      hideArguments?: string[];
      ruleId: string;
    }
  | { kind: "hidden"; targetTool: string; ruleId: string };

export type CallDecision =
  | { type: "allow"; ruleId: string }
  | { type: "rewrite"; ruleId: string; rewrite: PolicyRewrite }
  | { type: "approval_required"; ruleId: string; reason: string }
  | { type: "block"; ruleId: string; reason: string };

export class PolicyValidationError extends Error {}

const ALLOWED_EFFECTS = new Set(["allow", "limited_alias", "approval_required", "block", "rewrite"]);

export function slug(s: string): string {
  return s.toLowerCase().replace(/[.\-\s]+/g, "_").replace(/[^a-z0-9_]/g, "_");
}

export function defaultAlias(targetName: string, toolName: string): string {
  return `${slug(targetName)}__${slug(toolName)}`;
}

export class PolicyEngine {
  private rules: PolicyRule[];
  private defaultEffect: "allow" | "block";

  constructor(private policy: PolicyDoc) {
    validatePolicyDoc(policy);
    this.rules = policy.rules ?? [];
    this.defaultEffect = (policy.default ?? "deny") === "allow" ? "allow" : "block";
  }

  private matches(m: PolicyMatch, targetName: string, toolName: string): boolean {
    if (m.any) return true;
    if (m.target === undefined && m.tool === undefined && m.toolNameRegex === undefined) return false;
    if (m.target !== undefined && m.target !== targetName) return false;
    if (m.tool !== undefined && m.tool !== toolName) return false;
    if (m.toolNameRegex !== undefined && !new RegExp(m.toolNameRegex).test(toolName)) return false;
    return true;
  }

  private matched(targetName: string, toolName: string): PolicyRule[] {
    return this.rules.filter((r) => this.matches(r.match, targetName, toolName));
  }

  /** Router / direct real-name call. limited_alias rules are ignored here. */
  evaluateCall(targetName: string, toolName: string): CallDecision {
    const m = this.matched(targetName, toolName);
    const block = m.find((r) => r.effect === "block");
    if (block) return { type: "block", ruleId: block.id, reason: "explicit deny" };
    const appr = m.find((r) => r.effect === "approval_required");
    if (appr) return { type: "approval_required", ruleId: appr.id, reason: "approval required" };
    const rewrite = m.find((r) => r.effect === "rewrite");
    if (rewrite) return { type: "rewrite", ruleId: rewrite.id, rewrite: rewriteSpec(rewrite) };
    const allow = m.find((r) => r.effect === "allow");
    if (allow) return { type: "allow", ruleId: allow.id };
    if (this.defaultEffect === "allow") return { type: "allow", ruleId: "default-allow" };
    return { type: "block", ruleId: "default-deny", reason: "default deny" };
  }

  /** Upstream tools/list exposure for a target's observed tools. */
  evaluateList(targetName: string, tools: { name: string }[]): ExposureDecision[] {
    return tools.map((t) => {
      const m = this.matched(targetName, t.name);
      if (m.some((r) => r.effect === "block")) {
        return { kind: "hidden", targetTool: t.name, ruleId: "explicit-deny" };
      }
      const la = m.find((r) => r.effect === "limited_alias");
      if (la) {
        return {
          kind: "expose",
          exposedName: la.exposeAs?.name ? slug(la.exposeAs.name) : defaultAlias(targetName, t.name),
          targetTool: t.name,
          effect: "limited_alias",
          inject: la.exposeAs?.injectArguments,
          hideArguments: la.exposeAs?.hideArguments,
          ruleId: la.id,
        };
      }
      const rw = m.find((r) => r.effect === "rewrite");
      if (rw) {
        const rewrite = rewriteSpec(rw);
        return {
          kind: "expose",
          exposedName: rw.exposeAs?.name ? slug(rw.exposeAs.name) : defaultAlias(targetName, t.name),
          targetTool: t.name,
          effect: "rewrite",
          inject: rewrite.injectArguments,
          hideArguments: rewrite.hideArguments,
          ruleId: rw.id,
        };
      }
      const allow = m.find((r) => r.effect === "allow");
      if (allow) {
        return {
          kind: "expose",
          exposedName: defaultAlias(targetName, t.name),
          targetTool: t.name,
          effect: "allow",
          ruleId: allow.id,
        };
      }
      if (this.defaultEffect === "allow") {
        return { kind: "expose", exposedName: defaultAlias(targetName, t.name), targetTool: t.name, effect: "allow", ruleId: "default-allow" };
      }
      return { kind: "hidden", targetTool: t.name, ruleId: "default-deny" };
    });
  }
}

export function validatePolicyDoc(policy: unknown): asserts policy is PolicyDoc {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new PolicyValidationError("policy must be an object");
  }
  const doc = policy as PolicyDoc;
  if (doc.default !== undefined && doc.default !== "deny" && doc.default !== "allow") {
    throw new PolicyValidationError(`unsupported policy default: ${String(doc.default)}`);
  }
  if (doc.rules === undefined) return;
  if (!Array.isArray(doc.rules)) throw new PolicyValidationError("policy rules must be an array");
  doc.rules.forEach((rule, i) => validateRule(rule, i));
}

function validateRule(rule: unknown, index: number): asserts rule is PolicyRule {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    throw new PolicyValidationError(`rule[${index}] must be an object`);
  }
  const r = rule as PolicyRule & Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new PolicyValidationError(`rule[${index}] requires a non-empty id`);
  }
  if (typeof r.effect !== "string" || !ALLOWED_EFFECTS.has(r.effect)) {
    throw new PolicyValidationError(`rule ${r.id} has unsupported policy effect: ${String(r.effect)}`);
  }
  validateMatch(r.id, r.match);
  if (r.exposeAs !== undefined) validateExposeAs(r.id, r.exposeAs);
  if (r.effect === "rewrite") {
    validateRewrite(r.id, r.rewrite);
    if (r.exposeAs?.injectArguments !== undefined || r.exposeAs?.hideArguments !== undefined) {
      throw new PolicyValidationError(`rule ${r.id} must put rewrite arguments under rewrite, not exposeAs`);
    }
  } else if (r.rewrite !== undefined) {
    throw new PolicyValidationError(`rule ${r.id} must not include rewrite unless effect is rewrite`);
  }
}

function validateMatch(ruleId: string, match: unknown): asserts match is PolicyMatch {
  if (!match || typeof match !== "object" || Array.isArray(match)) {
    throw new PolicyValidationError(`rule ${ruleId} requires a match object`);
  }
  const m = match as PolicyMatch & Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (!["target", "tool", "toolNameRegex", "any"].includes(key)) {
      throw new PolicyValidationError(`rule ${ruleId} has unsupported match key: ${key}`);
    }
  }
  if (m.any !== undefined && typeof m.any !== "boolean") {
    throw new PolicyValidationError(`rule ${ruleId} match.any must be boolean`);
  }
  if (m.target !== undefined && typeof m.target !== "string") {
    throw new PolicyValidationError(`rule ${ruleId} match.target must be string`);
  }
  if (m.tool !== undefined && typeof m.tool !== "string") {
    throw new PolicyValidationError(`rule ${ruleId} match.tool must be string`);
  }
  if (m.toolNameRegex !== undefined) {
    if (typeof m.toolNameRegex !== "string") {
      throw new PolicyValidationError(`rule ${ruleId} match.toolNameRegex must be string`);
    }
    try {
      new RegExp(m.toolNameRegex);
    } catch {
      throw new PolicyValidationError(`rule ${ruleId} has invalid toolNameRegex`);
    }
  }
  if (m.any === true && (m.target !== undefined || m.tool !== undefined || m.toolNameRegex !== undefined)) {
    throw new PolicyValidationError(`rule ${ruleId} match.any cannot be combined with specific match fields`);
  }
  if (m.any !== true && m.target === undefined && m.tool === undefined && m.toolNameRegex === undefined) {
    throw new PolicyValidationError(`rule ${ruleId} match must specify any, target, tool, or toolNameRegex`);
  }
}

function validateExposeAs(ruleId: string, exposeAs: unknown): asserts exposeAs is PolicyExposeAs {
  if (!exposeAs || typeof exposeAs !== "object" || Array.isArray(exposeAs)) {
    throw new PolicyValidationError(`rule ${ruleId} exposeAs must be an object`);
  }
  const e = exposeAs as PolicyExposeAs;
  if (e.name !== undefined && typeof e.name !== "string") {
    throw new PolicyValidationError(`rule ${ruleId} exposeAs.name must be string`);
  }
  if (e.injectArguments !== undefined && !isRecord(e.injectArguments)) {
    throw new PolicyValidationError(`rule ${ruleId} exposeAs.injectArguments must be an object`);
  }
  if (e.hideArguments !== undefined && !isStringArray(e.hideArguments)) {
    throw new PolicyValidationError(`rule ${ruleId} exposeAs.hideArguments must be a string array`);
  }
}

function validateRewrite(ruleId: string, rewrite: unknown): asserts rewrite is PolicyRewrite {
  if (!rewrite || typeof rewrite !== "object" || Array.isArray(rewrite)) {
    throw new PolicyValidationError(`rule ${ruleId} with effect rewrite requires a rewrite object`);
  }
  const r = rewrite as PolicyRewrite;
  if (r.injectArguments === undefined && r.hideArguments === undefined) {
    throw new PolicyValidationError(`rule ${ruleId} rewrite must inject or hide at least one argument`);
  }
  if (r.injectArguments !== undefined && !isRecord(r.injectArguments)) {
    throw new PolicyValidationError(`rule ${ruleId} rewrite.injectArguments must be an object`);
  }
  if (r.hideArguments !== undefined && !isStringArray(r.hideArguments)) {
    throw new PolicyValidationError(`rule ${ruleId} rewrite.hideArguments must be a string array`);
  }
}

function rewriteSpec(rule: PolicyRule): PolicyRewrite {
  return {
    injectArguments: rule.rewrite?.injectArguments,
    hideArguments: rule.rewrite?.hideArguments,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
