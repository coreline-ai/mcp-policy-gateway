import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderClientConfig } from "../src/onboarding/client-config";
import { validateClientConfigContent } from "../src/onboarding/client-config-validator";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function writeTemp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpg-client-config-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe("client config direct-target guard (Phase 12)", () => {
  it("passes a Gateway-only Claude Desktop JSON config", () => {
    const rendered = renderClientConfig({ target: "claude-desktop", projectRoot: "/tmp/mcp-policy-gateway" });
    const result = validateClientConfigContent({ target: "claude-desktop", content: rendered.content });

    expect(result.status).toBe("pass");
    expect(result.serverNames).toEqual(["mcp-policy-gateway"]);
    expect(result.protectionLevel).toBe("validated_local");
  });

  it("fails Claude Desktop JSON when a direct target MCP is registered", () => {
    const content = JSON.stringify({
      mcpServers: {
        "mcp-policy-gateway": { command: "tsx", args: ["src/index.ts"] },
        "kakao-map": {
          command: "node",
          args: ["target.js"],
          env: { TARGET_TOKEN: "secret-token-that-must-not-leak" },
        },
      },
    });

    const result = validateClientConfigContent({ target: "claude-desktop", content });

    expect(result.status).toBe("fail");
    expect(result.serverNames).toEqual(["kakao-map", "mcp-policy-gateway"]);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "direct_target_registered", serverName: "kakao-map" }),
    );
    expect(JSON.stringify(result)).not.toContain("secret-token-that-must-not-leak");
  });

  it("fails when the Gateway server is missing", () => {
    const content = JSON.stringify({ mcpServers: { "kakao-map": { command: "node" } } });
    const result = validateClientConfigContent({ target: "generic-json", content });

    expect(result.status).toBe("fail");
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "missing_gateway", serverName: "mcp-policy-gateway" }),
    );
  });

  it("fails invalid JSON configs", () => {
    const result = validateClientConfigContent({ target: "claude-desktop", content: "{ nope" });

    expect(result.status).toBe("fail");
    expect(result.violations).toContainEqual(expect.objectContaining({ code: "parse_error" }));
  });

  it("passes a Gateway-only Codex CLI TOML config and does not treat env as a separate server", () => {
    const rendered = renderClientConfig({ target: "codex-cli", projectRoot: "/tmp/mcp-policy-gateway" });
    const result = validateClientConfigContent({ target: "codex-cli", content: rendered.content });

    expect(result.status).toBe("pass");
    expect(result.serverNames).toEqual(["mcp-policy-gateway"]);
  });

  it("fails Codex CLI TOML when a direct target MCP is registered", () => {
    const content = [
      "[mcp_servers.mcp-policy-gateway]",
      'command = "tsx"',
      "",
      "[mcp_servers.mcp-policy-gateway.env]",
      'GATEWAY_TOOL_SURFACE_MODE = "client"',
      "",
      "[mcp_servers.kakao-map]",
      'command = "node"',
      "",
      "[mcp_servers.kakao-map.env]",
      'TARGET_TOKEN = "secret-token-that-must-not-leak"',
      "",
    ].join("\n");

    const result = validateClientConfigContent({ target: "codex-cli", content });

    expect(result.status).toBe("fail");
    expect(result.serverNames).toEqual(["kakao-map", "mcp-policy-gateway"]);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "direct_target_registered", serverName: "kakao-map" }),
    );
    expect(JSON.stringify(result)).not.toContain("secret-token-that-must-not-leak");
  });

  it("returns a non-zero CLI status for direct target registration without leaking secrets", () => {
    const content = JSON.stringify({
      mcpServers: {
        "mcp-policy-gateway": { command: "tsx", args: ["src/index.ts"] },
        "kakao-map": { command: "node", env: { TARGET_TOKEN: "secret-token-that-must-not-leak" } },
      },
    });
    const file = writeTemp("claude.json", content);

    const result = spawnSync(TSX, ["scripts/validate-client-config.ts", "claude-desktop", file], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("direct_target_registered");
    expect(result.stdout).toContain("kakao-map");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("secret-token-that-must-not-leak");
  });

  it("returns zero CLI status for Gateway-only generated config", () => {
    const rendered = renderClientConfig({ target: "claude-desktop", projectRoot: "/tmp/mcp-policy-gateway" });
    const file = writeTemp("claude.json", rendered.content);

    const result = spawnSync(TSX, ["scripts/validate-client-config.ts", "claude-desktop", file], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS");
    expect(result.stdout).toContain("mcp-policy-gateway");
  });

  it("documents the config guard and managed deployment boundary", () => {
    const readme = read("README.md");
    const architecture = read("handoff/02-architecture.md");
    const deployment = read("docs/deployment-managed-client.md");

    for (const doc of [readme, architecture, deployment]) {
      expect(doc).toContain("config:validate");
      expect(doc).toContain("self-managed");
      expect(doc).toContain("validated-local");
      expect(doc).toContain("managed-enforced");
    }
    expect(deployment).toContain("client config에는 Gateway만");
    expect(deployment).toContain("target MCP command/url/token");
    expect(deployment).toContain("drift detection");
  });
});
