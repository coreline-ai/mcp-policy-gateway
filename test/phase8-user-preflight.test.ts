import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach } from "vitest";
import { openDb, type DB } from "../src/storage/db";
import { migrate } from "../src/storage/migrate";
import { loadConfig, type GatewayConfig } from "../src/config/load-config";
import { PolicyEngine } from "../src/policy/engine";
import { TargetSessionManager } from "../src/targets/session-manager";
import { listTargets } from "../src/targets/registry";
import type { TargetAdapter, TargetCallResult, TargetSession, TargetSpawnSpec, ToolPage } from "../src/catalog/target-adapter";
import { GatewayRuntime } from "../src/upstream/gateway";
import { gatewayToolsForMode } from "../src/upstream/tools";
import { assessRow } from "../src/assessment/report-model";
import { presentAssessment } from "../src/assessment/preflight-presenter";
import { explainPlayMcpRisk, preflightPlayMcp, searchPlayMcp } from "../src/assessment/preflight-service";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class CountingAdapter implements TargetAdapter {
  openCount = 0;
  listCount = 0;
  callCount = 0;

  async open(_spec: TargetSpawnSpec): Promise<TargetSession> {
    this.openCount++;
    throw new Error("preflight tools must not open target sessions");
  }

  async listToolsPage(_session: TargetSession, _cursor?: string): Promise<ToolPage> {
    this.listCount++;
    throw new Error("preflight tools must not list remote target tools");
  }

  async callTool(_session: TargetSession, _name: string, _args: Record<string, unknown>): Promise<TargetCallResult> {
    this.callCount++;
    throw new Error("preflight tools must not call remote target tools");
  }

  async close(): Promise<void> {}
}

let db: DB;
let cfg: GatewayConfig;
let adapter: CountingAdapter;
let runtime: GatewayRuntime;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  cfg = loadConfig({
    GATEWAY_DB_PATH: ":memory:",
    GATEWAY_HMAC_SECRET: "test-secret",
    GATEWAY_TENANT_ID: "t1",
    GATEWAY_CLIENT_ID: "c1",
    GATEWAY_ACTOR_ID: "a1",
    GATEWAY_TOOL_SURFACE_MODE: "client",
    GATEWAY_EXEC_ALLOWLIST: "fake",
  });
  adapter = new CountingAdapter();
  runtime = new GatewayRuntime(
    db,
    cfg,
    new PolicyEngine({ default: "deny", rules: [] }),
    new TargetSessionManager(db, adapter),
    adapter,
    "test-policy",
  );
});

describe("user-facing PlayMCP preflight tools (Phase 8)", () => {
  it("PM-U01 exposes preflight/search/explain tools on the client surface", () => {
    const names = runtime.listTools().map((tool) => tool.name);
    expect(names).toContain("gateway_search_playmcp");
    expect(names).toContain("gateway_preflight_mcp");
    expect(names).toContain("gateway_explain_mcp_risk");
  });

  it("PM-U02 keeps operator-only tools out of the client surface", () => {
    const clientNames = gatewayToolsForMode("client").map((tool) => tool.name);
    expect(clientNames).not.toContain("gateway_list_targets");
    expect(clientNames).not.toContain("gateway_rescan_target");
    expect(clientNames).not.toContain("gateway_get_audit_event");

    const operatorNames = gatewayToolsForMode("operator").map((tool) => tool.name);
    expect(operatorNames).toContain("gateway_preflight_mcp");
    expect(operatorNames).toContain("gateway_rescan_target");
  });

  it("PM-U03 deterministically searches representative PlayMCP candidates from natural prompts", () => {
    const result = searchPlayMcp("카카오맵 MCP 연결해도 돼?", 5);
    expect(result.totalInventoryRows).toBe(187);
    expect(result.candidates[0]).toMatchObject({ name: "카카오맵" });
    expect(result.candidates[0]!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("PM-U04 returns decision, risk, recommendation, and operator handoff for a selected MCP", () => {
    const result = preflightPlayMcp({ query: "카카오톡 선물하기 MCP는 어떤 승인이 필요해?", includeCandidates: true });
    expect(result.status).toBe("assessed");
    if (result.status !== "assessed") return;

    expect(result.item.name).toBe("카카오톡 선물하기");
    expect(result.item.riskLabels).toContain("commerce");
    expect(result.item.decision).not.toBe("usable");
    expect(result.item.gatewayPolicyRecommendation).toContain("approval_required");
    expect(result.item.operatorHandoff).toContain("MCP=카카오톡 선물하기");
    expect(result.item.assessmentLimit).toContain("정적 사전검증");
    expect(result.candidates?.[0]?.name).toBe("카카오톡 선물하기");
  });

  it("PM-U05 does not recommend direct/default usable handling for high-risk MCPs", () => {
    for (const query of ["카카오맵 MCP 연결해도 돼?", "톡캘린더 MCP", "컴퓨터 사용 MCP는 왜 차단 후보야?"]) {
      const result = preflightPlayMcp({ query });
      expect(result.status, query).toBe("assessed");
      if (result.status !== "assessed") continue;
      expect(result.item.decision, query).not.toBe("usable");
      expect(result.item.userNextAction, query).not.toContain("바로 연결");
    }

    const synthetic = assessRow({
      id: "synthetic-high-risk",
      name: "Synthetic risky but mislabeled usable",
      team: "test",
      teamType: "INDIVIDUAL",
      status: "APPROVED",
      authType: "NONE",
      category: "기타/실험",
      toolCount: 1,
      monthlyToolCallCount: 0,
      totalToolCallCount: 0,
      featuredLevel: "0",
      toolNames: "clear_cache",
      tools: ["clear_cache"],
      starterMessages: "",
      description: "",
    });
    const guarded = presentAssessment({ ...synthetic, decision: "usable", decisionKo: "사용 가능", decisionHint: "", gatewayAction: "allow" });
    expect(guarded.riskLabels).toContain("destructive_control");
    expect(guarded.decision).toBe("manual_review");
  });

  it("PM-U06 returns manual review guidance for an unknown query instead of default allow", () => {
    const result = preflightPlayMcp({ query: "없는없는없는 MCP 연결해도 돼?" });
    expect(result.status).toBe("not_found");
    if (result.status === "assessed") throw new Error("unknown query must not be assessed");
    expect(result.decision).toBe("manual_review");
    expect(result.userNextAction).toContain("수동 검토");
  });

  it("PM-U07 preflight dispatch does not register, spawn, list, or call target MCPs", async () => {
    expect(listTargets(db, cfg)).toHaveLength(0);

    const result = await runtime.dispatch("gateway_preflight_mcp", { query: "카카오맵 MCP 연결해도 돼?" });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { status?: string }).status).toBe("assessed");

    expect(listTargets(db, cfg)).toHaveLength(0);
    expect(adapter.openCount).toBe(0);
    expect(adapter.listCount).toBe(0);
    expect(adapter.callCount).toBe(0);
  });

  it("PM-U08 avoids forbidden claims in README and user-facing tool output", async () => {
    const preflight = await runtime.dispatch("gateway_preflight_mcp", { query: "컴퓨터 사용 MCP는 왜 차단 후보야?" });
    const explanation = explainPlayMcpRisk({ labels: ["code_execution", "destructive_control"] });
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const text = [
      preflight.content.map((block) => block.text ?? "").join("\n"),
      JSON.stringify(preflight.structuredContent),
      JSON.stringify(explanation),
      readme,
    ].join("\n");

    const forbiddenClaims = [
      ["이 MCP는", " 안전하다"].join(""),
      ["안전", " 보증"].join(""),
      ["악성 MCP", " 완전 탐지"].join(""),
      ["sandbox", " 보장"].join(""),
      ["모든 MCP 공격을", " 막는다"].join(""),
    ];
    for (const forbidden of forbiddenClaims) {
      expect(text).not.toContain(forbidden);
    }
  });
});
