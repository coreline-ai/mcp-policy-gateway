import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_PLAYMCP_INVENTORY_PATH } from "../src/assessment/inventory-loader";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface McpClientPreflightSmokeResult {
  status: "PASS";
  toolNames: string[];
  decision: string;
  mcpName: string;
  riskLabels: string[];
  operatorHandoffStructured: unknown;
  freshnessNote: string;
  dbPath: string;
}

export async function runMcpClientPreflightSmoke(rootDir = ROOT): Promise<McpClientPreflightSmokeResult> {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mpg-mcp-client-")), "gateway.sqlite");
  const transport = new StdioClientTransport({
    command: path.join(rootDir, "node_modules", ".bin", "tsx"),
    args: [path.join(rootDir, "src", "index.ts")],
    cwd: rootDir,
    stderr: "pipe",
    env: {
      ...process.env,
      GATEWAY_DB_PATH: dbPath,
      GATEWAY_POLICY_PATH: path.join(rootDir, "examples", "policies", "default-deny.yaml"),
      GATEWAY_TOOL_SURFACE_MODE: "client",
      GATEWAY_HMAC_SECRET: "test-mcp-client-preflight-secret",
      GATEWAY_TENANT_ID: "smoke-tenant",
      GATEWAY_CLIENT_ID: "sdk-smoke-client",
      GATEWAY_ACTOR_ID: "sdk-smoke-actor",
      PLAYMCP_INVENTORY_CSV: process.env.PLAYMCP_INVENTORY_CSV ?? DEFAULT_PLAYMCP_INVENTORY_PATH,
    },
  });
  const client = new Client({ name: "mcp-policy-gateway-smoke", version: "0.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);
    assertIncludes(toolNames, "gateway_search_playmcp");
    assertIncludes(toolNames, "gateway_preflight_mcp");
    assertIncludes(toolNames, "gateway_explain_mcp_risk");
    assertNotIncludes(toolNames, "gateway_list_targets");
    assertNotIncludes(toolNames, "gateway_rescan_target");
    assertNotIncludes(toolNames, "gateway_get_audit_event");

    const result = await client.callTool({
      name: "gateway_preflight_mcp",
      arguments: { query: "카카오맵 MCP 연결해도 돼?", includeCandidates: true },
    });
    const structured = result.structuredContent as {
      status?: string;
      item?: {
        name?: string;
        decision?: string;
        riskLabels?: string[];
        operatorHandoffStructured?: unknown;
      };
      freshnessNote?: string;
    };
    if (structured.status !== "assessed") throw new Error(`expected assessed status, got ${structured.status}`);
    if (structured.item?.name !== "카카오맵") throw new Error(`expected 카카오맵, got ${structured.item?.name}`);
    if (!structured.item.operatorHandoffStructured) throw new Error("operatorHandoffStructured missing");
    if (!structured.freshnessNote) throw new Error("freshnessNote missing");

    return {
      status: "PASS",
      toolNames,
      decision: structured.item.decision ?? "",
      mcpName: structured.item.name,
      riskLabels: structured.item.riskLabels ?? [],
      operatorHandoffStructured: structured.item.operatorHandoffStructured,
      freshnessNote: structured.freshnessNote,
      dbPath,
    };
  } finally {
    await client.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runMcpClientPreflightSmoke();
  console.log(`MCP client preflight smoke: ${result.status}`);
  console.log(`Tools: ${result.toolNames.filter((name) => name.startsWith("gateway_")).join(", ")}`);
  console.log(`Preflight: ${result.mcpName} -> ${result.decision}`);
  console.log(`Freshness: ${result.freshnessNote}`);
}

function assertIncludes(values: string[], expected: string): void {
  if (!values.includes(expected)) throw new Error(`expected ${expected} in tools/list`);
}

function assertNotIncludes(values: string[], unexpected: string): void {
  if (values.includes(unexpected)) throw new Error(`did not expect ${unexpected} in client tools/list`);
}
