import path from "node:path";
import { DEFAULT_PLAYMCP_INVENTORY_PATH } from "../assessment/inventory-loader";

export type ClientConfigTarget = "claude-desktop" | "codex-cli" | "generic-json";

export interface ClientConfigOptions {
  target: string;
  projectRoot?: string;
  dbPath?: string;
  policyPath?: string;
  inventoryPath?: string;
  tenantId?: string;
  clientId?: string;
  actorId?: string;
  hmacSecretPlaceholder?: string;
}

export interface RenderedClientConfig {
  target: ClientConfigTarget;
  format: "json" | "toml";
  content: string;
  notes: string[];
}

export const SUPPORTED_CLIENT_CONFIG_TARGETS: ClientConfigTarget[] = ["claude-desktop", "codex-cli", "generic-json"];

const DEFAULT_SECRET_PLACEHOLDER = "REPLACE_WITH_LOCAL_HMAC_SECRET";

export function normalizeClientConfigTarget(target: string): ClientConfigTarget {
  switch (target.trim().toLowerCase()) {
    case "claude":
    case "claude-desktop":
      return "claude-desktop";
    case "codex":
    case "codex-cli":
      return "codex-cli";
    case "generic":
    case "generic-json":
    case "desktop":
      return "generic-json";
    default:
      throw new Error(`unsupported client config target: ${target}. supported: ${SUPPORTED_CLIENT_CONFIG_TARGETS.join(", ")}`);
  }
}

export function renderClientConfig(options: ClientConfigOptions): RenderedClientConfig {
  const target = normalizeClientConfigTarget(options.target);
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const command = path.join(projectRoot, "node_modules", ".bin", "tsx");
  const args = [path.join(projectRoot, "src", "index.ts")];
  const env = gatewayEnv(target, projectRoot, options);
  const notes = [
    "Register only mcp-policy-gateway in the MCP client.",
    "Do not add target MCP servers directly to the client if Gateway protection is expected.",
    "Replace the HMAC secret placeholder before real use.",
  ];

  if (target === "codex-cli") {
    return {
      target,
      format: "toml",
      content: renderCodexToml(command, args, env),
      notes,
    };
  }

  const json = {
    mcpServers: {
      "mcp-policy-gateway": {
        command,
        args,
        env,
      },
    },
  };

  return {
    target,
    format: "json",
    content: JSON.stringify(json, null, 2),
    notes,
  };
}

function gatewayEnv(target: ClientConfigTarget, projectRoot: string, options: ClientConfigOptions): Record<string, string> {
  return {
    GATEWAY_DB_PATH: options.dbPath ?? path.join(projectRoot, ".data", "gateway.sqlite"),
    GATEWAY_POLICY_PATH: options.policyPath ?? path.join(projectRoot, "examples", "policies", "default-deny.yaml"),
    GATEWAY_TOOL_SURFACE_MODE: "client",
    GATEWAY_HMAC_SECRET: options.hmacSecretPlaceholder ?? DEFAULT_SECRET_PLACEHOLDER,
    GATEWAY_TENANT_ID: options.tenantId ?? "default-tenant",
    GATEWAY_CLIENT_ID: options.clientId ?? target,
    GATEWAY_ACTOR_ID: options.actorId ?? "local-user",
    PLAYMCP_INVENTORY_CSV: options.inventoryPath ?? DEFAULT_PLAYMCP_INVENTORY_PATH,
  };
}

function renderCodexToml(command: string, args: string[], env: Record<string, string>): string {
  return [
    "[mcp_servers.mcp-policy-gateway]",
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    "",
    "[mcp_servers.mcp-policy-gateway.env]",
    ...Object.entries(env).map(([key, value]) => `${key} = ${tomlString(value)}`),
    "",
  ].join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
