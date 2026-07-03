import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderClientConfig } from "../src/onboarding/client-config";
import { extractSnapshotDate } from "../src/assessment/inventory-freshness";
import { buildUnknownMcpIntake } from "../src/assessment/unknown-mcp-intake";
import { preflightPlayMcp } from "../src/assessment/preflight-service";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("user onboarding config and handoff helpers (Phase 9)", () => {
  it("renders parseable Claude Desktop JSON that registers only the Gateway MCP", () => {
    const rendered = renderClientConfig({ target: "claude-desktop", projectRoot: "/tmp/mcp-policy-gateway" });
    const parsed = JSON.parse(rendered.content) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };

    expect(Object.keys(parsed.mcpServers)).toEqual(["mcp-policy-gateway"]);
    expect(parsed.mcpServers["mcp-policy-gateway"]!.command).toBe("/tmp/mcp-policy-gateway/node_modules/.bin/tsx");
    expect(parsed.mcpServers["mcp-policy-gateway"]!.args).toEqual(["/tmp/mcp-policy-gateway/src/index.ts"]);
    expect(parsed.mcpServers["mcp-policy-gateway"]!.env.GATEWAY_TOOL_SURFACE_MODE).toBe("client");
    expect(parsed.mcpServers["mcp-policy-gateway"]!.env.GATEWAY_HMAC_SECRET).toBe("REPLACE_WITH_LOCAL_HMAC_SECRET");
    expect(rendered.content).not.toContain("dev-insecure-hmac-secret-change-me");
    expect(rendered.content).not.toContain("targetServers");
  });

  it("renders Codex CLI TOML-style config without target MCP registration", () => {
    const rendered = renderClientConfig({ target: "codex", projectRoot: "/tmp/mcp-policy-gateway" });
    expect(rendered.format).toBe("toml");
    expect(rendered.content).toContain("[mcp_servers.mcp-policy-gateway]");
    expect(rendered.content).toContain('command = "/tmp/mcp-policy-gateway/node_modules/.bin/tsx"');
    expect(rendered.content).toContain("[mcp_servers.mcp-policy-gateway.env]");
    expect(rendered.content).toContain('GATEWAY_TOOL_SURFACE_MODE = "client"');
    expect(rendered.content).not.toContain("[mcp_servers.kakao");
  });

  it("renders generic JSON and rejects unsupported client targets", () => {
    const rendered = renderClientConfig({ target: "generic-json", projectRoot: "/tmp/mcp-policy-gateway" });
    expect(() => JSON.parse(rendered.content)).not.toThrow();
    expect(() => renderClientConfig({ target: "unknown-client" })).toThrow(/unsupported client config target/);
  });

  it("adds structured operator handoff to preflight results", () => {
    const result = preflightPlayMcp({ query: "카카오톡 선물하기 MCP는 어떤 승인이 필요해?" });
    expect(result.status).toBe("assessed");
    if (result.status !== "assessed") return;

    expect(result.item.operatorHandoff).toContain("MCP=카카오톡 선물하기");
    expect(result.item.operatorHandoffStructured).toMatchObject({
      mcpName: "카카오톡 선물하기",
      decision: result.item.decision,
      recommendedGatewayAction: expect.stringContaining("approval_required"),
    });
    expect(result.item.operatorHandoffStructured.requiredReviewChecks.join("\n")).toContain("purchase");
    expect(JSON.stringify(result.item.operatorHandoffStructured)).not.toContain("registerTarget");
    expect(JSON.stringify(result.item.operatorHandoffStructured)).not.toContain("npm run");
    expect(JSON.stringify(result.item.operatorHandoffStructured)).not.toContain("api_key=");
    expect(JSON.stringify(result.item.operatorHandoffStructured)).not.toContain("token=");
  });

  it("extracts inventory snapshot freshness and includes it in preflight output", () => {
    expect(extractSnapshotDate("/tmp/playmcp_inventory_20260625.csv")).toBe("2026-06-25");
    const result = preflightPlayMcp({ query: "카카오맵 MCP 연결해도 돼?" });
    expect(result.snapshotDate).toBe("2026-06-25");
    expect(result.inventorySource).toContain("playmcp_inventory_20260625.csv");
    expect(result.freshnessNote).toContain("2026-06-25");
    expect(result.generatedAt).toMatch(/T/);
  });

  it("keeps unknown MCPs on manual review or stronger intake paths", () => {
    const result = preflightPlayMcp({
      query: "없는없는없는 MCP 연결해도 돼?",
      homepageOrPackageUrl: "https://example.com/unknown-mcp",
      declaredTools: ["execute_command"],
      reasonForUse: "local automation",
    });
    expect(result.status).toBe("not_found");
    if (result.status !== "not_found") return;

    expect(result.decision).toBe("manual_review");
    expect(result.unknownMcpIntake.networkFetched).toBe(false);
    expect(result.unknownMcpIntake.provisionalDecision).toBe("blocked");
    expect(result.unknownMcpIntake.provisionalRiskLabels).toContain("code_execution");
    expect(result.userNextAction).toContain("수동 검토");
  });

  it("requests minimum information when unknown MCP declared tools are missing", () => {
    const intake = buildUnknownMcpIntake({ name: "새 MCP" });
    expect(intake.status).toBe("manual_review");
    expect(intake.provisionalDecision).toBe("manual_review");
    expect(intake.requiredInformation[0]).toContain("Tool names");
    expect(intake.networkFetched).toBe(false);
  });

  it("documents the first-user flow and UAT checklist without direct target registration guidance", () => {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const uat = fs.readFileSync(path.join(ROOT, "docs", "user-scenario-uat.md"), "utf8");

    expect(readme).toContain("First 5 Minutes");
    expect(readme).toContain("npm run config:client -- claude-desktop");
    expect(readme).toContain("npm run smoke:mcp-client-preflight");
    expect(readme).toContain("operatorHandoffStructured");
    expect(uat).toContain("Gateway starts as an MCP stdio server");
    expect(uat).toContain("No target MCP server is registered");
    const forbiddenClaims = [
      ["이 MCP는", " 안전하다"].join(""),
      ["안전", " 보증"].join(""),
      ["악성 MCP", " 완전 탐지"].join(""),
      ["sandbox", " 보장"].join(""),
    ];
    for (const forbidden of forbiddenClaims) {
      expect(`${readme}\n${uat}`).not.toContain(forbidden);
    }
  });
});
