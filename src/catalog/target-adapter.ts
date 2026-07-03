// Target adapter contract. observeTarget() is written against this interface so
// pagination / incomplete-snapshot behavior can be unit-tested with a fake,
// independent of any real subprocess.

export interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface ToolPage {
  tools: RawTool[];
  nextCursor?: string;
}

export interface TargetSpawnSpec {
  /** Connection kind; defaults to "stdio" when absent (backward compatible). */
  kind?: "stdio" | "http";
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  callTimeoutMs?: number;
  // http (Streamable HTTP)
  url?: string;
  headers?: Record<string, string>;
}

export interface TargetSession {
  info?: { name?: string; version?: string; protocolVersion?: string };
}

export interface TargetCallResult {
  content?: unknown;
  isError?: boolean;
  structuredContent?: unknown;
}

export type TargetRuntimeEvent =
  | { type: "unsupported_reverse_request"; method: string }
  | { type: "unsupported_reverse_notification"; method: string }
  | { type: "stdio_transport_error"; reason: string };

export interface TargetAdapter {
  /** Spawn/connect the target and complete the MCP initialize handshake. */
  open(spec: TargetSpawnSpec, onListChanged?: () => void, onRuntimeEvent?: (event: TargetRuntimeEvent) => void): Promise<TargetSession>;
  /** Fetch one page of tools/list. Absence of nextCursor means the last page. */
  listToolsPage(session: TargetSession, cursor?: string): Promise<ToolPage>;
  /** Forward a tools/call to the target. */
  callTool(session: TargetSession, name: string, args: Record<string, unknown>): Promise<TargetCallResult>;
  close(session: TargetSession): Promise<void>;
}
