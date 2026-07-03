// safe-notes-mcp — read-only sample target MCP (list/get/search only).
// Used to validate allow rules. In-memory fake; no external access (ADR-009).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const notes = [
  { id: "n1", title: "Welcome", body: "hello world" },
  { id: "n2", title: "Roadmap", body: "phase 1 catalog" },
];

const server = new McpServer({ name: "safe-notes-mcp", version: "0.0.0" });

server.registerTool(
  "notes.list",
  { description: "List notes (read-only).", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: JSON.stringify(notes.map((n) => ({ id: n.id, title: n.title }))) }] }),
);

server.registerTool(
  "notes.get",
  { description: "Get a note by id (read-only).", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const note = notes.find((n) => n.id === id);
    return { content: [{ type: "text", text: JSON.stringify(note ?? { error: "not found" }) }] };
  },
);

server.registerTool(
  "notes.search",
  { description: "Search notes by substring (read-only).", inputSchema: { q: z.string() } },
  async ({ q }) => ({
    content: [{ type: "text", text: JSON.stringify(notes.filter((n) => (n.title + n.body).includes(q))) }],
  }),
);

await server.connect(new StdioServerTransport());
console.error("[safe-notes] ready");
