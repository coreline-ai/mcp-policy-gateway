// StdioTargetAdapter: the gateway acting as an MCP client to a stdio target.
// The SDK Client performs the initialize handshake and sends the initialized
// notification on connect(). Reverse capabilities (sampling/elicitation/roots)
// are not advertised, so unsupported server->client requests are rejected by the
// SDK — fail-closed per ADR-015.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ErrorCode,
  LoggingMessageNotificationSchema,
  McpError,
  ProgressNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GuardedStdioClientTransport } from "./guarded-stdio-transport";
import type {
  TargetAdapter,
  TargetRuntimeEvent,
  TargetSession,
  TargetSpawnSpec,
  ToolPage,
  RawTool,
  TargetCallResult,
} from "./target-adapter";

interface StdioSession extends TargetSession {
  client: Client;
  callTimeoutMs?: number;
}

export const DEFAULT_STDIO_ENV_KEYS = ["PATH", "SystemRoot", "WINDIR", "ComSpec"];

export interface StdioTargetAdapterOptions {
  inheritedEnvKeys?: string[];
  extraEnv?: Record<string, string>;
}

export function buildStdioEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  inheritedEnvKeys: string[] = DEFAULT_STDIO_ENV_KEYS,
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of inheritedEnvKeys) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...extraEnv };
}

export class StdioTargetAdapter implements TargetAdapter {
  constructor(private opts: StdioTargetAdapterOptions = {}) {}

  async open(
    spec: TargetSpawnSpec,
    onListChanged?: () => void,
    onRuntimeEvent?: (event: TargetRuntimeEvent) => void,
  ): Promise<TargetSession> {
    if (!spec.command) throw new Error("stdio target requires a command");
    const client = new Client({ name: "mcp-policy-gateway-downstream", version: "0.0.0" });
    client.fallbackRequestHandler = async (request) => {
      onRuntimeEvent?.({ type: "unsupported_reverse_request", method: request.method });
      throw new McpError(ErrorCode.MethodNotFound, `unsupported reverse request: ${request.method}`);
    };
    client.setNotificationHandler(ProgressNotificationSchema, async (notification) => {
      onRuntimeEvent?.({ type: "unsupported_reverse_notification", method: notification.method });
    });
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
      onRuntimeEvent?.({ type: "unsupported_reverse_notification", method: notification.method });
    });
    if (onListChanged) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        onListChanged();
      });
    }
    const transport = new GuardedStdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: { ...buildStdioEnvironment(process.env, this.opts.inheritedEnvKeys, this.opts.extraEnv), ...(spec.env ?? {}) },
      cwd: spec.cwd,
      stderr: "inherit",
    }, {
      onGuardError: (error) => onRuntimeEvent?.({ type: "stdio_transport_error", reason: error.message }),
    });
    await client.connect(transport);
    const info = client.getServerVersion();
    const session: StdioSession = { client, callTimeoutMs: spec.callTimeoutMs, info: { name: info?.name, version: info?.version } };
    return session;
  }

  async listToolsPage(session: TargetSession, cursor?: string): Promise<ToolPage> {
    const s = session as StdioSession;
    const res = await s.client.listTools(cursor ? { cursor } : {});
    return { tools: res.tools as RawTool[], nextCursor: res.nextCursor };
  }

  async callTool(session: TargetSession, name: string, args: Record<string, unknown>): Promise<TargetCallResult> {
    const s = session as StdioSession;
    const r = await s.client.callTool(
      { name, arguments: args },
      undefined,
      s.callTimeoutMs === undefined ? undefined : { timeout: s.callTimeoutMs },
    );
    return { content: r.content, isError: r.isError as boolean | undefined, structuredContent: r.structuredContent };
  }

  async close(session: TargetSession): Promise<void> {
    await (session as StdioSession).client.close();
  }
}
