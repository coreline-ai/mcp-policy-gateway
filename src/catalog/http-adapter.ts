// HttpTargetAdapter: connects to a Streamable HTTP target MCP.
// Every connection and every request passes the SSRF egress guard (ADR-006/T10).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { TargetAdapter, TargetSession, TargetSpawnSpec, ToolPage, RawTool, TargetCallResult } from "./target-adapter";
import { assertEgressAllowed, type EgressPolicy, DEFAULT_EGRESS } from "../targets/egress-guard";

interface HttpSession extends TargetSession {
  client: Client;
}

export class HttpTargetAdapter implements TargetAdapter {
  constructor(private policy: EgressPolicy = DEFAULT_EGRESS) {}

  // Re-validate egress on every outbound request (DNS-rebinding mitigation).
  private guardedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return this.fetchWithRedirectGuard(input, init);
  };

  private async fetchWithRedirectGuard(input: string | URL | Request, init?: RequestInit, redirects = 0): Promise<Response> {
    if (redirects > 5) throw new Error("HTTP target redirect limit exceeded");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    await assertEgressAllowed(url, this.policy);
    const response = await fetch(input as string | URL | Request, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    const nextUrl = new URL(location, url).href;
    await assertEgressAllowed(nextUrl, this.policy);

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      throw new Error("HTTP target redirect blocked for non-idempotent MCP request");
    }
    return this.fetchWithRedirectGuard(nextUrl, init, redirects + 1);
  }

  async open(spec: TargetSpawnSpec, onListChanged?: () => void): Promise<TargetSession> {
    if (!spec.url) throw new Error("http target requires a url");
    await assertEgressAllowed(spec.url, this.policy); // pre-connect gate

    const client = new Client({ name: "mcp-policy-gateway-downstream", version: "0.0.0" });
    if (onListChanged) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        onListChanged();
      });
    }
    const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      fetch: this.guardedFetch as unknown as typeof fetch,
      requestInit: spec.headers ? { headers: spec.headers } : undefined,
    });
    await client.connect(transport);
    const info = client.getServerVersion();
    const session: HttpSession = { client, info: { name: info?.name, version: info?.version } };
    return session;
  }

  async listToolsPage(session: TargetSession, cursor?: string): Promise<ToolPage> {
    const s = session as HttpSession;
    const res = await s.client.listTools(cursor ? { cursor } : {});
    return { tools: res.tools as RawTool[], nextCursor: res.nextCursor };
  }

  async callTool(session: TargetSession, name: string, args: Record<string, unknown>): Promise<TargetCallResult> {
    const s = session as HttpSession;
    const r = await s.client.callTool({ name, arguments: args });
    return { content: r.content, isError: r.isError as boolean | undefined, structuredContent: r.structuredContent };
  }

  async close(session: TargetSession): Promise<void> {
    await (session as HttpSession).client.close();
  }
}
