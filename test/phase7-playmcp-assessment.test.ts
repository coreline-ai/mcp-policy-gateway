import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PLAYMCP_INVENTORY_PATH, loadPlayMcpInventory, parseCsv } from "../src/assessment/inventory-loader";
import { DECISION_KO } from "../src/assessment/decision-mapper";
import { HIGH_RISK_LABELS } from "../src/assessment/risk-classifier";
import { assessRow, buildAssessmentReport, highRiskDefaultAllow } from "../src/assessment/report-model";
import { renderAssessmentHtml } from "../src/assessment/html-report";
import { runPreUseLiveSmoke } from "../src/assessment/preuse-live-smoke";

const INVENTORY = process.env.PLAYMCP_INVENTORY_CSV ?? DEFAULT_PLAYMCP_INVENTORY_PATH;

describe("PlayMCP full-inventory pre-use assessment (Phase 6)", () => {
  const rows = loadPlayMcpInventory(INVENTORY);
  const report = buildAssessmentReport(rows, INVENTORY, "2026-07-02T00:00:00.000Z");

  it("PM-T01 parses the full 187-row PlayMCP inventory", () => {
    expect(rows).toHaveLength(187);
    expect(rows[0]).toMatchObject({ id: "469", name: "찐맛집" });
    expect(new Set(rows.map((row) => row.id)).size).toBe(187);
    expect(rows.filter((row) => row.name === "학교 급식 정보")).toHaveLength(2);
  });

  it("PM-T02 includes every category in the snapshot", () => {
    expect(Object.keys(report.summary.categories)).toHaveLength(12);
    expect(report.summary.categories["헬스/의료/안전"]).toBe(25);
    expect(report.summary.categories["생활/로컬/교통"]).toBe(24);
  });

  it("PM-T03 assigns at least one risk label to every MCP", () => {
    expect(report.items.every((item) => item.labels.length > 0)).toBe(true);
    expect(report.summary.labels.unknown).toBeGreaterThanOrEqual(0);
  });

  it("PM-T04 assigns exactly one supported decision to every MCP", () => {
    const allowed = new Set(Object.keys(DECISION_KO));
    expect(report.items.every((item) => allowed.has(item.decision))).toBe(true);
    expect(Object.values(report.summary.decisions).reduce((a, b) => a + b, 0)).toBe(187);
  });

  it("PM-T05 never maps high-risk labels to default usable", () => {
    expect(highRiskDefaultAllow(report.items)).toHaveLength(0);
    for (const item of report.items) {
      if (item.labels.some((label) => HIGH_RISK_LABELS.has(label))) {
        expect(item.decision).not.toBe("usable");
      }
    }
  });

  it("PM-T06 includes Kakao representative services and does not default-allow them", () => {
    for (const name of ["카카오톡 나챗방", "톡캘린더", "카카오맵", "카카오톡 선물하기", "멜론"]) {
      const item = report.items.find((candidate) => candidate.name === name);
      expect(item, name).toBeTruthy();
      expect(item!.decision, name).not.toBe("usable");
    }
  });

  it("PM-T07~PM-T13 emits individual static sample checks", () => {
    const expected = ["PM-T07", "PM-T08", "PM-T09", "PM-T10", "PM-T11", "PM-T12", "PM-T13"];
    const checks = report.phaseChecks.filter((check) => expected.includes(check.id));
    expect(checks.map((check) => check.id)).toEqual(expected);
    expect(checks.map((check) => check.status)).toEqual(expected.map(() => "PASS"));
  });

  it("does not map synthetic destructive_control-only tools to default usable", () => {
    const item = assessRow({
      id: "synthetic-destructive-control",
      name: "Synthetic cache controls",
      team: "test",
      teamType: "INDIVIDUAL",
      status: "APPROVED",
      authType: "NONE",
      category: "기타/실험",
      toolCount: 2,
      monthlyToolCallCount: 0,
      totalToolCallCount: 0,
      featuredLevel: "0",
      toolNames: "clear_cache|reset_session",
      tools: ["clear_cache", "reset_session"],
      starterMessages: "",
      description: "",
    });

    expect(item.labels).toContain("destructive_control");
    expect(item.decision).not.toBe("usable");
    expect(item.decision).toBe("usable_with_approval");
  });

  it("PM-T19 renders reproducible HTML and JSON reports", () => {
    const html = renderAssessmentHtml(report);
    const json = JSON.stringify(report, null, 2);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playmcp-assessment-"));
    const htmlPath = path.join(dir, "report.html");
    const jsonPath = path.join(dir, "report.json");
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(jsonPath, json);

    expect(fs.statSync(htmlPath).size).toBeGreaterThan(100_000);
    expect(fs.statSync(jsonPath).size).toBeGreaterThan(100_000);
    expect(html).toContain("MCP별 상세 결과");
    expect(html).toContain("Gateway 권장 정책");
    expect(html.match(/class="mcp-card"/g)).toHaveLength(187);
  });

  it("PM-T20 avoids forbidden product claims in generated report framing", () => {
    const html = renderAssessmentHtml(report);
    const forbiddenClaims = [
      ["이 MCP는", " 안전하다"].join(""),
      ["안전", " 보증"].join(""),
      ["악성 MCP", " 완전 탐지"].join(""),
      ["sandbox", " 보장"].join(""),
      ["모든 MCP 공격을", " 막는다"].join(""),
    ];
    for (const forbidden of forbiddenClaims) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("PM-T14~PM-T18 runs a real Gateway -> target MCP pre-use smoke", async () => {
    const liveSmoke = await runPreUseLiveSmoke();
    expect(liveSmoke.status).toBe("PASS");
    expect(liveSmoke.completeness).toBe("complete");
    expect(liveSmoke.toolCount).toBe(4);
    expect(liveSmoke.exposedTools).toContain("risky_actions__actions_list_runs");
    expect(liveSmoke.exposedTools).toContain("risky_actions__preview_profile");
    expect(liveSmoke.exposedTools.some((tool) => tool.includes("delete_all"))).toBe(false);
    expect(liveSmoke.hiddenToolDirectCallBlocked).toBe(true);
    expect(liveSmoke.deniedForwardingCount).toBe(0);
    expect(liveSmoke.approvalRequiredBeforeGrant).toBe(true);
    expect(liveSmoke.approvedCallForwardedOnce).toBe(true);
    expect(liveSmoke.approvalReplayBlocked).toBe(true);
    expect(liveSmoke.diffChecked).toBe(true);
    expect(liveSmoke.auditReadRedacted).toBe(true);

    const reportWithLiveSmoke = buildAssessmentReport(rows, INVENTORY, "2026-07-02T00:00:00.000Z", liveSmoke);
    const liveStatuses = reportWithLiveSmoke.phaseChecks
      .filter((check) => ["PM-T14", "PM-T15", "PM-T16", "PM-T17", "PM-T18"].includes(check.id))
      .map((check) => check.status);
    expect(liveStatuses).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS"]);
  });

  it("parses quoted CSV fields with commas and escaped quotes", () => {
    expect(parseCsv('a,b\n"hello, ""world""",x\n')).toEqual([
      ["a", "b"],
      ['hello, "world"', "x"],
    ]);
  });
});
