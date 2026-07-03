// Minimal raw stdio MCP target used for transport hardening tests.
// Modes:
//   malformed   -> writes invalid JSON-RPC and waits
//   oversized   -> writes a JSON-RPC line larger than the gateway transport limit
//   crash-tool  -> exits during tools/call
//   reverse     -> sends an unsupported server->client request during tools/call
//   hang-tool   -> never answers tools/call
//   env-check   -> reports whether selected gateway env keys reached the target
import readline from "node:readline";

const mode = process.argv[2] ?? "crash-tool";

if (mode === "malformed") {
  process.stdout.write("not-json\n");
  setInterval(() => undefined, 1000);
} else if (mode === "oversized") {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { blob: "x".repeat(1024 * 1024 + 1) } }) + "\n");
  setInterval(() => undefined, 1000);
} else {
  const rl = readline.createInterface({ input: process.stdin });
  let pendingCallId: string | number | null = null;

  rl.on("line", (line) => {
    const msg = JSON.parse(line) as {
      id?: string | number;
      method?: string;
      result?: unknown;
      error?: unknown;
      params?: { name?: string };
    };
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "hardening-mcp", version: "0.0.0" },
          capabilities: { tools: {} },
        },
      });
      return;
    }
    if (msg.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: mode === "reverse" ? "hardening.reverse" : mode === "hang-tool" ? "hardening.hang" : mode === "env-check" ? "hardening.env_check" : "hardening.crash",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
      return;
    }
    if (msg.method === "tools/call") {
      if (mode === "crash-tool") process.exit(42);
      if (mode === "hang-tool") return;
      if (mode === "env-check") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  hasGatewaySecret: process.env.GATEWAY_HMAC_SECRET !== undefined,
                  hasTargetCallLog: process.env.TARGET_CALL_LOG !== undefined,
                }),
              },
            ],
          },
        });
        return;
      }
      pendingCallId = msg.id ?? null;
      send({
        jsonrpc: "2.0",
        id: "reverse-1",
        method: "sampling/createMessage",
        params: { messages: [], maxTokens: 1 },
      });
      return;
    }
    if (msg.id === "reverse-1" && pendingCallId !== null) {
      send({
        jsonrpc: "2.0",
        id: pendingCallId,
        result: { content: [{ type: "text", text: msg.error ? "reverse blocked" : "reverse served" }] },
      });
      pendingCallId = null;
    }
  });
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}
