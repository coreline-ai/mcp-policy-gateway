import {
  normalizeClientConfigTarget,
  type ClientConfigTarget,
} from "./client-config";

export const GATEWAY_CLIENT_SERVER_NAME = "mcp-policy-gateway";
export const DEFAULT_ALLOWED_CLIENT_SERVER_NAMES = [GATEWAY_CLIENT_SERVER_NAME] as const;

export type ClientConfigValidationTarget = ClientConfigTarget;
export type ClientConfigProtectionLevel = "validated_local";
export type ClientConfigValidationStatus = "pass" | "fail";
export type ClientConfigValidationViolationCode =
  | "missing_gateway"
  | "direct_target_registered"
  | "parse_error"
  | "unsupported_target";

export interface ClientConfigValidationViolation {
  code: ClientConfigValidationViolationCode;
  message: string;
  serverName?: string;
}

export interface ClientConfigValidationOptions {
  target: string;
  content: string;
  allowedServerNames?: readonly string[];
}

export interface ClientConfigValidationResult {
  status: ClientConfigValidationStatus;
  target: ClientConfigValidationTarget | "unsupported";
  requestedTarget: string;
  serverNames: string[];
  allowedServerNames: string[];
  violations: ClientConfigValidationViolation[];
  warnings: string[];
  protectionLevel: ClientConfigProtectionLevel;
}

interface ExtractedServerNames {
  serverNames: string[];
  warnings: string[];
  violations: ClientConfigValidationViolation[];
}

export function validateClientConfigContent(options: ClientConfigValidationOptions): ClientConfigValidationResult {
  const allowedServerNames = [...(options.allowedServerNames ?? DEFAULT_ALLOWED_CLIENT_SERVER_NAMES)];
  let target: ClientConfigValidationTarget;

  try {
    target = normalizeClientConfigTarget(options.target);
  } catch (err) {
    return {
      status: "fail",
      target: "unsupported",
      requestedTarget: options.target,
      serverNames: [],
      allowedServerNames,
      violations: [
        {
          code: "unsupported_target",
          message: err instanceof Error ? err.message : `unsupported client config target: ${options.target}`,
        },
      ],
      warnings: [],
      protectionLevel: "validated_local",
    };
  }

  const extracted = target === "codex-cli"
    ? extractCodexTomlServerNames(options.content)
    : extractJsonServerNames(options.content);
  const serverNames = uniqueSorted(extracted.serverNames);
  const violations = [...extracted.violations, ...validateServerNames(serverNames, allowedServerNames)];

  return {
    status: violations.length > 0 ? "fail" : "pass",
    target,
    requestedTarget: options.target,
    serverNames,
    allowedServerNames,
    violations,
    warnings: extracted.warnings,
    protectionLevel: "validated_local",
  };
}

function extractJsonServerNames(content: string): ExtractedServerNames {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return parseFailure(`invalid JSON client config: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isRecord(parsed)) return parseFailure("client config root must be a JSON object");
  const mcpServers = parsed.mcpServers;
  if (!isRecord(mcpServers)) return parseFailure("client config must contain an object field named mcpServers");

  return { serverNames: Object.keys(mcpServers), warnings: [], violations: [] };
}

function extractCodexTomlServerNames(content: string): ExtractedServerNames {
  const serverNames: string[] = [];
  const warnings: string[] = [];
  const violations: ClientConfigValidationViolation[] = [];
  const sectionPattern = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = sectionPattern.exec(line);
    if (!match) continue;

    const section = match[1]!.trim();
    if (!section.startsWith("mcp_servers.")) continue;

    const rest = section.slice("mcp_servers.".length);
    const serverName = rest.endsWith(".env") ? rest.slice(0, -".env".length) : rest;
    if (!serverName) {
      warnings.push(`ignored empty mcp_servers section at line ${index + 1}`);
      continue;
    }
    if (serverName.includes('"') || serverName.includes("'")) {
      violations.push({
        code: "parse_error",
        message: `unsupported quoted mcp_servers section at line ${index + 1}`,
      });
      continue;
    }
    serverNames.push(serverName);
  }

  return { serverNames, warnings, violations };
}

function validateServerNames(serverNames: string[], allowedServerNames: string[]): ClientConfigValidationViolation[] {
  const violations: ClientConfigValidationViolation[] = [];
  const present = new Set(serverNames);
  const allowed = new Set(allowedServerNames);

  for (const allowedName of allowedServerNames) {
    if (!present.has(allowedName)) {
      violations.push({
        code: "missing_gateway",
        serverName: allowedName,
        message: `required Gateway MCP server is missing: ${allowedName}`,
      });
    }
  }

  for (const serverName of serverNames) {
    if (!allowed.has(serverName)) {
      violations.push({
        code: "direct_target_registered",
        serverName,
        message: `direct target MCP server is registered outside the Gateway: ${serverName}`,
      });
    }
  }

  return violations;
}

function parseFailure(message: string): ExtractedServerNames {
  return {
    serverNames: [],
    warnings: [],
    violations: [{ code: "parse_error", message }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
