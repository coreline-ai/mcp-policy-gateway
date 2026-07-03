// risky-actions-mcp — sample target with read-only + mutation + destructive tools.
// Records every tools/call it actually receives to TARGET_CALL_LOG so tests can
// prove that blocked calls never reach the target. In-memory fake (ADR-009).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";

const LOG = process.env.TARGET_CALL_LOG;
function record(tool: string, args: unknown) {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ tool, arguments: args, ts: Date.now() }) + "\n");
}

const server = new McpServer({ name: "risky-actions-mcp", version: "0.0.0" });

server.registerTool(
  "actions.list_runs",
  { description: "List runs (read-only).", inputSchema: {} },
  async () => {
    record("actions.list_runs", {});
    return { content: [{ type: "text", text: JSON.stringify(["run-1", "run-2"]) }] };
  },
);

server.registerTool(
  "actions.get_config",
  { description: "Get config (read-only). Returns a fake secret to exercise output redaction.", inputSchema: {} },
  async () => {
    record("actions.get_config", {});
    return { content: [{ type: "text", text: "config: api_key=sk-DEMOKEY0123456789ABC region=us" }] };
  },
);

server.registerTool(
  "actions.apply_profile",
  { description: "Apply a profile (mutation). Supports dryRun.", inputSchema: { profileId: z.string(), dryRun: z.boolean().optional() } },
  async ({ profileId, dryRun }) => {
    record("actions.apply_profile", { profileId, dryRun });
    return { content: [{ type: "text", text: `applied ${profileId} dryRun=${dryRun}` }] };
  },
);

server.registerTool(
  "actions.delete_all",
  { description: "Delete everything (destructive).", inputSchema: { confirm: z.boolean().optional() } },
  async ({ confirm }) => {
    record("actions.delete_all", { confirm });
    return { content: [{ type: "text", text: "deleted" }] };
  },
);

await server.connect(new StdioServerTransport());
console.error("[risky-actions] ready");
