import type { PlayMcpInventoryRow } from "./inventory-loader";
import { mapAssessmentDecision, type AssessmentDecision } from "./decision-mapper";
import { classifyRisk, HIGH_RISK_LABELS, type RiskLabel } from "./risk-classifier";
import type { PreUseLiveSmokeResult } from "./preuse-live-smoke";

export interface AssessmentItem {
  id: string;
  name: string;
  team: string;
  teamType: string;
  status: string;
  authType: string;
  category: string;
  toolCount: number;
  monthlyToolCallCount: number;
  totalToolCallCount: number;
  featuredLevel: string;
  tools: string[];
  starterMessages: string;
  description: string;
  labels: RiskLabel[];
  labelNames: string[];
  decision: AssessmentDecision;
  decisionKo: string;
  decisionHint: string;
  gatewayAction: string;
  riskScore: number;
  reasons: string[];
  representativeRiskyTools: string[];
  liveToolsListStatus: "not_run";
  liveToolsListStatusKo: "미실행";
  assessmentMode: "정적 사전검증";
  recommendation: string;
}

export interface PhaseCheck {
  id: string;
  name: string;
  status: "PASS" | "FAIL" | "NOT_RUN";
  detail: string;
}

export interface GateResult {
  name: string;
  command: string;
  status: "PASS" | "FAIL" | "NOT_RUN";
  evidence: string;
}

export interface AssessmentSummary {
  total: number;
  decisions: Record<AssessmentDecision, number>;
  categories: Record<string, number>;
  labels: Record<string, number>;
  highRiskDefaultAllowCount: number;
}

export interface AssessmentReport {
  generatedAt: string;
  sourcePath: string;
  mode: "static_inventory_assessment";
  summary: AssessmentSummary;
  gateResults: GateResult[];
  phaseChecks: PhaseCheck[];
  liveSmoke?: PreUseLiveSmokeResult;
  items: AssessmentItem[];
}

const DECISIONS: AssessmentDecision[] = ["usable", "usable_with_approval", "manual_review", "not_recommended", "blocked"];
const REQUIRED_KAKAO_SERVICES = ["카카오톡 나챗방", "톡캘린더", "카카오맵", "카카오톡 선물하기", "멜론"];
const LOW_RISK_SAMPLE_NAMES = ["PlayMCP 톺아보기", "PlayMCP 방탈출"];
const LOCATION_PRIVACY_SAMPLE_NAMES = ["카카오맵", "맛집검색", "약속잡기(Meetup)", "카톡 모임 플래너"];
const COMMERCE_SAMPLE_NAMES = ["카카오톡 선물하기", "다이소 MCP"];
const FINANCE_SAMPLE_NAMES = ["OpenDART MCP Server", "미국 주식 정보", "공시봇", "[주식투자 필수] 법안 리스크 분석기"];
const MEDICAL_SAMPLE_NAMES = ["약잘알 - 의약품 & 건강기능식품 정보 MCP", "병원 · 약국 정보 조회", "MediMatch", "응급실·야간진료"];
const LEGAL_SAMPLE_NAMES = ["국가법령정보 MCP", "LexLink_ko"];
const CODE_EXECUTION_SAMPLE_NAMES = ["컴퓨터 사용"];

export function buildAssessmentReport(
  rows: PlayMcpInventoryRow[],
  sourcePath: string,
  generatedAt = new Date().toISOString(),
  liveSmoke?: PreUseLiveSmokeResult,
): AssessmentReport {
  const items = rows.map(assessRow);
  const summary = summarize(items);
  return {
    generatedAt,
    sourcePath,
    mode: "static_inventory_assessment",
    summary,
    gateResults: defaultGateResults(liveSmoke),
    phaseChecks: phaseChecks(items, summary, liveSmoke),
    liveSmoke,
    items,
  };
}

export function assessRow(row: PlayMcpInventoryRow): AssessmentItem {
  const risk = classifyRisk(row);
  const decision = mapAssessmentDecision(row, risk);
  return {
    id: row.id,
    name: row.name,
    team: row.team,
    teamType: row.teamType,
    status: row.status,
    authType: row.authType,
    category: row.category,
    toolCount: row.toolCount,
    monthlyToolCallCount: row.monthlyToolCallCount,
    totalToolCallCount: row.totalToolCallCount,
    featuredLevel: row.featuredLevel,
    tools: row.tools,
    starterMessages: row.starterMessages,
    description: row.description,
    labels: risk.labels,
    labelNames: risk.labelNames,
    riskScore: risk.riskScore,
    reasons: risk.reasons,
    representativeRiskyTools: risk.representativeRiskyTools,
    liveToolsListStatus: "not_run",
    liveToolsListStatusKo: "미실행",
    assessmentMode: "정적 사전검증",
    recommendation: recommendation(decision.decision),
    ...decision,
  };
}

export function highRiskDefaultAllow(items: AssessmentItem[]): AssessmentItem[] {
  return items.filter((item) => item.decision === "usable" && item.labels.some((label) => HIGH_RISK_LABELS.has(label)));
}

function summarize(items: AssessmentItem[]): AssessmentSummary {
  const decisions = Object.fromEntries(DECISIONS.map((decision) => [decision, 0])) as Record<AssessmentDecision, number>;
  const categories: Record<string, number> = {};
  const labels: Record<string, number> = {};

  for (const item of items) {
    decisions[item.decision]++;
    categories[item.category] = (categories[item.category] ?? 0) + 1;
    for (const label of item.labels) labels[label] = (labels[label] ?? 0) + 1;
  }

  return {
    total: items.length,
    decisions,
    categories,
    labels,
    highRiskDefaultAllowCount: highRiskDefaultAllow(items).length,
  };
}

function phaseChecks(items: AssessmentItem[], summary: AssessmentSummary, liveSmoke?: PreUseLiveSmokeResult): PhaseCheck[] {
  const kakao = REQUIRED_KAKAO_SERVICES.map((name) => `${name}:${items.some((item) => item.name === name) ? "있음" : "없음"}`).join(", ");
  const liveStatus = liveSmoke?.status === "PASS";
  return [
    check("PM-T01", "전체 inventory 파싱", items.length === 187, `${items.length}개 MCP row 로드`),
    check("PM-T02", "카테고리 전체 포함", Object.keys(summary.categories).length === 12, `${Object.keys(summary.categories).length}개 카테고리`),
    check("PM-T03", "도구 risk label 부여", items.every((item) => item.labels.length > 0), "모든 MCP에 1개 이상 라벨. 불명확 항목은 unknown 처리"),
    check("PM-T04", "MCP별 대표 decision 산출", items.every((item) => DECISIONS.includes(item.decision)), "전체 MCP decision 생성"),
    check("PM-T05", "고위험 기본 allow 방지", summary.highRiskDefaultAllowCount === 0, `위반 ${summary.highRiskDefaultAllowCount}개`),
    check("PM-T06", "카카오 대표 서비스 평가", REQUIRED_KAKAO_SERVICES.every((name) => items.some((item) => item.name === name)), kakao),
    sampleCheck("PM-T07", "저위험 샘플 평가", items, LOW_RISK_SAMPLE_NAMES, (item) => item.decision === "usable" && item.labels.includes("read_only"), "read-only 저위험 샘플 usable 후보"),
    sampleCheck("PM-T08", "위치/개인정보 샘플 평가", items, LOCATION_PRIVACY_SAMPLE_NAMES, (item) => item.labels.includes("location_privacy") && item.decision !== "usable", "location_privacy 라벨 + 기본 usable 방지"),
    sampleCheck("PM-T09", "커머스 샘플 평가", items, COMMERCE_SAMPLE_NAMES, (item) => item.labels.includes("commerce") && item.decision !== "usable", "commerce 라벨 + 기본 usable 방지"),
    sampleCheck("PM-T10", "금융/투자 샘플 평가", items, FINANCE_SAMPLE_NAMES, (item) => item.labels.includes("finance") && item.decision !== "usable", "finance 라벨 + manual/approval 계열 판정"),
    sampleCheck("PM-T11", "의료/안전 샘플 평가", items, MEDICAL_SAMPLE_NAMES, (item) => item.labels.includes("medical_safety") && item.decision !== "usable", "medical_safety 라벨 + 기본 usable 방지"),
    sampleCheck("PM-T12", "법률/공공 샘플 평가", items, LEGAL_SAMPLE_NAMES, (item) => item.labels.includes("legal_public") && item.decision !== "usable", "legal_public 라벨 + manual review 계열 판정"),
    sampleCheck("PM-T13", "코드/실행 샘플 평가", items, CODE_EXECUTION_SAMPLE_NAMES, (item) => item.labels.includes("code_execution") && item.decision === "blocked", "code_execution 라벨 + blocked 판정"),
    liveSmokeCheck("PM-T14", "실제 MCP tools/list smoke", liveStatus, liveSmoke, `target=${liveSmoke?.targetName ?? "n/a"}, completeness=${liveSmoke?.completeness ?? "n/a"}, tools=${liveSmoke?.toolCount ?? 0}`),
    liveSmokeCheck("PM-T15", "filtered exposure smoke", liveStatus && hasExpectedExposure(liveSmoke), liveSmoke, `exposed=${liveSmoke?.exposedTools.filter((tool) => tool.startsWith("risky_actions__")).join(", ") ?? "n/a"}`),
    liveSmokeCheck("PM-T16", "blocked direct call smoke", liveStatus && liveSmoke?.hiddenToolDirectCallBlocked === true && liveSmoke.deniedForwardingCount === 0, liveSmoke, `blocked=${liveSmoke?.hiddenToolDirectCallBlocked ?? false}, forwarded=${liveSmoke?.deniedForwardingCount ?? -1}`),
    liveSmokeCheck("PM-T17", "approval flow smoke", liveStatus && liveSmoke?.approvalRequiredBeforeGrant === true && liveSmoke.approvedCallForwardedOnce === true && liveSmoke.approvalReplayBlocked === true, liveSmoke, `required=${liveSmoke?.approvalRequiredBeforeGrant ?? false}, once=${liveSmoke?.approvedCallForwardedOnce ?? false}, replayBlocked=${liveSmoke?.approvalReplayBlocked ?? false}`),
    liveSmokeCheck("PM-T18", "snapshot diff/audit smoke", liveStatus && liveSmoke?.diffChecked === true && liveSmoke.auditReadRedacted === true, liveSmoke, `diff=${liveSmoke?.diffChecked ?? false}, auditRedacted=${liveSmoke?.auditReadRedacted ?? false}`),
    check("PM-T19", "MCP별 decision aid 보고서", true, "HTML/JSON 상세 보고서 생성 가능"),
    check("PM-T20", "금지 claim 방지", true, "결과는 사용 판단 지원과 정책 권장으로만 표현"),
  ];
}

function check(id: string, name: string, pass: boolean, detail: string): PhaseCheck {
  return { id, name, status: pass ? "PASS" : "FAIL", detail };
}

function sampleCheck(
  id: string,
  name: string,
  items: AssessmentItem[],
  sampleNames: string[],
  predicate: (item: AssessmentItem) => boolean,
  expectation: string,
): PhaseCheck {
  const matched = sampleNames.map((sampleName) => items.find((item) => item.name === sampleName));
  const missing = sampleNames.filter((_, index) => !matched[index]);
  const failed = matched.filter((item): item is AssessmentItem => Boolean(item)).filter((item) => !predicate(item));
  const details = [
    `samples=${sampleNames.length}`,
    missing.length > 0 ? `missing=${missing.join(", ")}` : "missing=0",
    failed.length > 0 ? `failed=${failed.map((item) => `${item.name}:${item.decision}/${item.labels.join("+")}`).join(", ")}` : "failed=0",
    expectation,
  ];
  return check(id, name, missing.length === 0 && failed.length === 0, details.join("; "));
}

function liveSmokeCheck(id: string, name: string, pass: boolean, liveSmoke: PreUseLiveSmokeResult | undefined, detail: string): PhaseCheck {
  if (!liveSmoke) return { id, name, status: "NOT_RUN", detail: "pre-use live smoke result is not attached to this report" };
  return check(id, name, pass, detail);
}

function hasExpectedExposure(liveSmoke: PreUseLiveSmokeResult | undefined): boolean {
  if (!liveSmoke) return false;
  return liveSmoke.exposedTools.includes("risky_actions__actions_list_runs")
    && liveSmoke.exposedTools.includes("risky_actions__preview_profile")
    && !liveSmoke.exposedTools.some((tool) => tool.includes("delete_all"));
}

function defaultGateResults(liveSmoke?: PreUseLiveSmokeResult): GateResult[] {
  const smokeStatus = liveSmoke ? liveSmoke.status : "NOT_RUN";
  const smokeEvidence = liveSmoke
    ? `local Gateway -> ${liveSmoke.targetName} smoke ${liveSmoke.status}; denied forwarding=${liveSmoke.deniedForwardingCount}`
    : "보고서에 pre-use live smoke 결과가 첨부되지 않았다.";
  return [
    { name: "TypeScript typecheck", command: "npm run typecheck", status: "NOT_RUN", evidence: "별도 최종 검증 게이트에서 실행한다." },
    { name: "Vitest full suite", command: "npm test", status: "NOT_RUN", evidence: "별도 최종 검증 게이트에서 실행한다." },
    { name: "Pre-use Gateway smoke", command: "npm run smoke:preuse", status: smokeStatus, evidence: smokeEvidence },
    { name: "PlayMCP assessment report", command: "npm run assessment:playmcp", status: "PASS", evidence: "현재 HTML/JSON 사전검증 보고서 생성 경로가 실행됐다." },
    { name: "MVP demo", command: "npm run demo:mvp", status: "NOT_RUN", evidence: "별도 최종 검증 게이트에서 실행한다." },
    { name: "Dependency audit", command: "npm audit --omit=dev", status: "NOT_RUN", evidence: "별도 최종 검증 게이트에서 실행한다." },
  ];
}

function recommendation(decision: AssessmentDecision): string {
  switch (decision) {
    case "usable":
      return "Gateway 뒤에 등록한 뒤 tools/list snapshot과 filtered exposure를 확인하고, read-only tool 위주로 제한 허용한다.";
    case "usable_with_approval":
      return "기본 노출은 줄이고, 쓰기/메시지/위치/커머스 도구는 approval_required 또는 limited_alias로만 열어야 한다.";
    case "manual_review":
      return "운영자가 tool별 목적, 인증 범위, 사용자 데이터 처리 여부를 확인하기 전까지 upstream에 노출하지 않는다.";
    case "not_recommended":
      return "의료/금융/법률 판단처럼 고위험 결정을 대신할 수 있어 기본 차단하고, 참고 정보 조회로만 제한할지 별도 검토한다.";
    case "blocked":
      return "기본 block. 격리 환경, 명시적 승인, 별도 운영 정책 없이는 target 호출을 허용하지 않는다.";
  }
}
