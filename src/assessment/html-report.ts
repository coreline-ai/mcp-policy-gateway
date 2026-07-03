import { DECISION_KO, type AssessmentDecision } from "./decision-mapper";
import { LABEL_KO, type RiskLabel } from "./risk-classifier";
import type { AssessmentItem, AssessmentReport } from "./report-model";

const DECISION_ORDER: AssessmentDecision[] = ["usable", "usable_with_approval", "manual_review", "not_recommended", "blocked"];
const LABEL_ORDER: RiskLabel[] = [
  "code_execution",
  "destructive_control",
  "messaging",
  "calendar_write",
  "commerce",
  "finance",
  "medical_safety",
  "legal_public",
  "location_privacy",
  "mutation",
  "requires_auth",
  "content_generation",
  "read_only",
  "unknown",
];

export function renderAssessmentHtml(report: AssessmentReport): string {
  const cards = report.items.map(renderCard).join("");
  const summaryCards = DECISION_ORDER.map((decision) => metric(String(report.summary.decisions[decision] ?? 0), DECISION_KO[decision])).join("");
  const categoryRows = Object.entries(report.summary.categories)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `<tr><td>${escapeHtml(category)}</td><td>${count}</td></tr>`)
    .join("");
  const labelRows = LABEL_ORDER.filter((label) => (report.summary.labels[label] ?? 0) > 0)
    .map((label) => `<tr><td>${escapeHtml(LABEL_KO[label])}</td><td>${report.summary.labels[label]}</td></tr>`)
    .join("");
  const gateRows = report.gateResults.map((gate) =>
    `<tr><td>${escapeHtml(gate.name)}</td><td><code>${escapeHtml(gate.command)}</code></td><td><span class="pill ${statusClass(gate.status)}">${gate.status}</span></td><td>${escapeHtml(gate.evidence)}</td></tr>`,
  ).join("");
  const phaseRows = report.phaseChecks.map((check) =>
    `<tr><td>${escapeHtml(check.id)}</td><td>${escapeHtml(check.name)}</td><td><span class="pill ${statusClass(check.status)}">${check.status}</span></td><td>${escapeHtml(check.detail)}</td></tr>`,
  ).join("");
  const categoryOptions = Object.keys(report.summary.categories).sort().map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
  const decisionOptions = DECISION_ORDER.map((decision) => `<option value="${decision}">${DECISION_KO[decision]}</option>`).join("");
  const notice = report.liveSmoke
    ? "이 보고서는 MCP를 직접 연결하기 전에 사용자가 판단할 수 있도록 돕는 정적 사전검증 결과에 local Gateway pre-use smoke를 첨부한 결과입니다. 최종 허가서가 아니며, 실제 보호는 MCP Client가 Target MCP를 직접 등록하지 않고 Gateway 뒤에 둘 때만 성립합니다. PlayMCP remote MCP의 live tools/list/call은 실행하지 않았습니다."
    : "이 보고서는 MCP를 직접 연결하기 전에 사용자가 판단할 수 있도록 돕는 정적 사전검증 결과입니다. 최종 허가서가 아니며, 실제 보호는 MCP Client가 Target MCP를 직접 등록하지 않고 Gateway 뒤에 둘 때만 성립합니다. PlayMCP remote MCP의 live tools/list/call은 실행하지 않았습니다.";

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PlayMCP 사전검증 결과 보고서</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>PlayMCP MCP 사전검증 결과 보고서</h1>
  <p class="muted">생성 시각: ${escapeHtml(report.generatedAt)} · 기준 파일: ${escapeHtml(report.sourcePath)}</p>
  <div class="notice">${escapeHtml(notice)}</div>
</header>
<main>
  <section>
    <h2>전체 요약</h2>
    <div class="metrics">${metric(String(report.summary.total), "평가 MCP")}${summaryCards}</div>
  </section>
  <section>
    <h2>Gateway 자동화 검증 게이트</h2>
    <table><thead><tr><th>검증</th><th>명령</th><th>상태</th><th>근거</th></tr></thead><tbody>${gateRows}</tbody></table>
  </section>
  <section>
    <h2>Phase 6 사전검증 테스트</h2>
    <table><thead><tr><th>ID</th><th>테스트</th><th>상태</th><th>상세</th></tr></thead><tbody>${phaseRows}</tbody></table>
  </section>
  ${report.liveSmoke ? renderLiveSmoke(report.liveSmoke) : ""}
  <section class="two-col">
    <div><h2>카테고리 분포</h2><table><thead><tr><th>카테고리</th><th>MCP 수</th></tr></thead><tbody>${categoryRows}</tbody></table></div>
    <div><h2>위험 라벨 분포</h2><table><thead><tr><th>라벨</th><th>MCP 수</th></tr></thead><tbody>${labelRows}</tbody></table></div>
  </section>
  <section>
    <h2>MCP별 상세 결과</h2>
    <div class="controls">
      <input id="q" type="search" placeholder="MCP 이름, 팀, 도구명, 설명 검색">
      <select id="decision"><option value="">전체 판정</option>${decisionOptions}</select>
      <select id="category"><option value="">전체 카테고리</option>${categoryOptions}</select>
      <div id="resultCount"></div>
    </div>
    <div id="cards" class="cards">${cards}</div>
  </section>
  <p class="footer">정적 분류는 tool name, MCP 설명, 카테고리 기반의 보수적 휴리스틱입니다. 운영 정책 확정 전에는 고위험 MCP를 upstream에 노출하지 않는 것이 이 보고서의 기본 전제입니다.</p>
</main>
<script id="assessment-data" type="application/json">${escapeHtml(JSON.stringify(report))}</script>
<script>${JS}</script>
</body>
</html>
`;
}

function renderLiveSmoke(liveSmoke: NonNullable<AssessmentReport["liveSmoke"]>): string {
  return `<section>
    <h2>실제 MCP 연결 Smoke</h2>
    <table><tbody>
      <tr><th>상태</th><td><span class="pill ${statusClass(liveSmoke.status)}">${liveSmoke.status}</span></td></tr>
      <tr><th>Target</th><td>${escapeHtml(liveSmoke.targetName)} (${escapeHtml(liveSmoke.targetKind)})</td></tr>
      <tr><th>Snapshot</th><td>${escapeHtml(liveSmoke.completeness)} · tools=${liveSmoke.toolCount}</td></tr>
      <tr><th>Filtered Exposure</th><td>${escapeHtml(liveSmoke.exposedTools.filter((tool) => tool.startsWith("risky_actions__")).join(", "))}</td></tr>
      <tr><th>Blocked Direct Call</th><td>blocked=${String(liveSmoke.hiddenToolDirectCallBlocked)} · forwarded=${liveSmoke.deniedForwardingCount}</td></tr>
      <tr><th>Approval</th><td>required=${String(liveSmoke.approvalRequiredBeforeGrant)} · once=${String(liveSmoke.approvedCallForwardedOnce)} · replayBlocked=${String(liveSmoke.approvalReplayBlocked)}</td></tr>
      <tr><th>Diff/Audit</th><td>diff=${String(liveSmoke.diffChecked)} · auditRedacted=${String(liveSmoke.auditReadRedacted)}</td></tr>
    </tbody></table>
  </section>`;
}

function renderCard(item: AssessmentItem): string {
  const tools = item.tools.length > 0 ? item.tools.join(", ") : "도구명 없음";
  const labels = item.labelNames.map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join("");
  const reasons = item.reasons.length > 0
    ? item.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")
    : "<li>명시적 근거 부족. 수동 검토 권장.</li>";
  const risky = item.representativeRiskyTools.length > 0 ? item.representativeRiskyTools.join(", ") : "없음";
  const search = [item.name, item.team, item.category, tools, item.description].join(" ").toLowerCase();
  return `<article class="mcp-card" data-decision="${item.decision}" data-category="${escapeHtml(item.category)}" data-search="${escapeHtml(search)}">
  <div class="card-head"><div><h3>${escapeHtml(item.name)}</h3><p class="muted">ID ${escapeHtml(item.id)} · ${escapeHtml(item.team)} · ${escapeHtml(item.category)}</p></div><span class="decision ${decisionClass(item.decision)}">${escapeHtml(item.decisionKo)}</span></div>
  <div class="card-grid"><div><b>Gateway 권장 정책</b><p>${escapeHtml(item.gatewayAction)}</p></div><div><b>위험 점수</b><p>${item.riskScore} / 100</p></div><div><b>도구 수</b><p>${item.toolCount}개</p></div><div><b>Live tools/list</b><p>${escapeHtml(item.liveToolsListStatusKo)}</p></div></div>
  <p class="hint">${escapeHtml(item.decisionHint)}</p>
  <div class="tags">${labels}</div>
  <details><summary>상세 근거와 도구 목록 보기</summary><div class="detail-block">
    <h4>대표 위험/검토 도구</h4><p>${escapeHtml(risky)}</p>
    <h4>분류 근거</h4><ul>${reasons}</ul>
    <h4>전체 도구</h4><p class="tools">${escapeHtml(tools)}</p>
    <h4>설명</h4><p>${escapeHtml(item.description || "설명 없음")}</p>
    <h4>추천 사용자 행동</h4><p>${escapeHtml(item.recommendation)}</p>
  </div></details>
</article>`;
}

function metric(value: string, label: string): string {
  return `<div class="metric"><span class="metric-value">${escapeHtml(value)}</span><span class="metric-label">${escapeHtml(label)}</span></div>`;
}

function statusClass(status: string): string {
  if (status === "PASS") return "pass";
  if (status === "FAIL") return "fail";
  return "neutral";
}

function decisionClass(decision: AssessmentDecision): string {
  return {
    usable: "ok",
    usable_with_approval: "warn",
    manual_review: "review",
    not_recommended: "badsoft",
    blocked: "bad",
  }[decision];
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const CSS = `
:root{color-scheme:dark;--bg:#0e1116;--panel:#151a22;--panel2:#1b222d;--line:#2d3644;--text:#edf2f7;--muted:#9da9b8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55}header{padding:32px 40px 24px;border-bottom:1px solid var(--line);background:#111720}h1{margin:0 0 10px;font-size:30px;letter-spacing:0}h2{margin:36px 0 14px;font-size:21px}h3{margin:0;font-size:18px}h4{margin:18px 0 6px;font-size:14px;color:#c9d4e2}main{padding:0 40px 48px;max-width:1480px;margin:0 auto}code{color:#d7e7ff;background:#202938;padding:2px 6px;border-radius:5px}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:#cbd8e8;background:#1b2430;font-size:13px}tr:last-child td{border-bottom:0}.muted{color:var(--muted);margin:4px 0 0}.notice{margin-top:18px;padding:14px 16px;background:#1b2430;border:1px solid var(--line);border-left:4px solid #8aa4ff;border-radius:8px;color:#dce6f3}.metrics{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:12px;margin:24px 0}.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px}.metric-value{display:block;font-size:30px;font-weight:760}.metric-label{display:block;color:var(--muted)}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}.pill,.decision,.tag{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:700;border:1px solid transparent;white-space:nowrap}.pass{color:#d8ffe9;background:rgba(47,184,117,.14);border-color:rgba(47,184,117,.35)}.fail{color:#ffe1e5;background:rgba(239,91,106,.15);border-color:rgba(239,91,106,.35)}.neutral{color:#e3e9f2;background:rgba(138,164,255,.12);border-color:rgba(138,164,255,.32)}.decision.ok{color:#d8ffe9;background:rgba(47,184,117,.16);border-color:rgba(47,184,117,.36)}.decision.warn{color:#fff0ce;background:rgba(226,166,59,.16);border-color:rgba(226,166,59,.36)}.decision.review{color:#e0e7ff;background:rgba(138,164,255,.16);border-color:rgba(138,164,255,.36)}.decision.badsoft{color:#ffe5da;background:rgba(239,125,84,.16);border-color:rgba(239,125,84,.36)}.decision.bad{color:#ffe1e5;background:rgba(239,91,106,.16);border-color:rgba(239,91,106,.36)}.controls{position:sticky;top:0;z-index:2;margin:24px 0;padding:14px;background:rgba(14,17,22,.96);border:1px solid var(--line);border-radius:8px;display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:10px}input,select{width:100%;padding:10px 11px;border-radius:7px;border:1px solid var(--line);background:#111720;color:var(--text);font:inherit}#resultCount{align-self:center;color:var(--muted);font-size:14px}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.mcp-card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;min-width:0}.card-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.card-grid{margin:14px 0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.card-grid div{background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:10px;min-width:0}.card-grid b{display:block;font-size:12px;color:var(--muted)}.card-grid p{margin:4px 0 0;overflow-wrap:anywhere}.hint{color:#dce6f3}.tags{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.tag{background:#222b38;color:#d7e2ef;border-color:#334154;font-weight:600}details{border-top:1px solid var(--line);padding-top:10px}summary{cursor:pointer;color:#d7e7ff}.detail-block{color:#dbe4ef}.tools{overflow-wrap:anywhere}.footer{margin-top:32px;color:var(--muted);font-size:13px}@media(max-width:980px){header,main{padding-left:18px;padding-right:18px}.metrics,.two-col,.cards,.controls{grid-template-columns:1fr}.card-grid{grid-template-columns:1fr 1fr}}@media(max-width:540px){.card-grid{grid-template-columns:1fr}}
`;

const JS = `
const q=document.getElementById('q'),decision=document.getElementById('decision'),category=document.getElementById('category'),cards=Array.from(document.querySelectorAll('.mcp-card')),resultCount=document.getElementById('resultCount');
function applyFilters(){const term=q.value.trim().toLowerCase(),d=decision.value,c=category.value;let shown=0;for(const card of cards){const ok=(!term||card.dataset.search.includes(term))&&(!d||card.dataset.decision===d)&&(!c||card.dataset.category===c);card.style.display=ok?'':'none';if(ok)shown++}resultCount.textContent=shown+' / '+cards.length+' 표시'}
q.addEventListener('input',applyFilters);decision.addEventListener('change',applyFilters);category.addEventListener('change',applyFilters);applyFilters();
`;
