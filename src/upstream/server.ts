// Upstream MCP server: the gateway as an MCP server to the LLM client.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type ListToolsResult,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { GatewayRuntime } from "./gateway";

export async function startServer(runtime: GatewayRuntime): Promise<void> {
  const server = new Server(
    { name: "mcp-runtime-policy-gateway", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: runtime.listTools() } as unknown as ListToolsResult;
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const res = await runtime.dispatch(req.params.name, args);
    return res as unknown as CallToolResult;
  });

  await server.connect(new StdioServerTransport());
}
