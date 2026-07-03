import { describe, expect, it } from "vitest";
import { runMcpClientPreflightSmoke } from "../scripts/smoke-mcp-client-preflight";

describe("real MCP protocol preflight smoke (Phase 10)", () => {
  it("lists and calls user-facing preflight tools through the SDK stdio client", async () => {
    const result = await runMcpClientPreflightSmoke();
    expect(result.status).toBe("PASS");
    expect(result.toolNames).toContain("gateway_search_playmcp");
    expect(result.toolNames).toContain("gateway_preflight_mcp");
    expect(result.toolNames).toContain("gateway_explain_mcp_risk");
    expect(result.toolNames).not.toContain("gateway_list_targets");
    expect(result.toolNames).not.toContain("gateway_rescan_target");
    expect(result.mcpName).toBe("카카오맵");
    expect(result.decision).not.toBe("usable");
    expect(result.riskLabels).toContain("location_privacy");
    expect(result.operatorHandoffStructured).toBeTruthy();
    expect(result.freshnessNote).toContain("PlayMCP inventory snapshot date");
  }, 15_000);
});
