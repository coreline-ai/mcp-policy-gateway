import { DECISION_HINT, DECISION_KO, GATEWAY_ACTION, type AssessmentDecision } from "./decision-mapper";
import { buildOperatorHandoff, type OperatorHandoffStructured } from "./operator-handoff";
import type { AssessmentItem } from "./report-model";
import { HIGH_RISK_LABELS, LABEL_KO, type RiskLabel } from "./risk-classifier";

export const ASSESSMENT_LIMIT =
  "PlayMCP inventory 기반 정적 사전검증 결과입니다. 실제 remote MCP의 최신 동작이나 악성 여부를 보증하지 않으며, 등록 전 tools/list 재검토와 Gateway 정책 적용이 필요합니다.";

export interface PresentedPlayMcpAssessment {
  id: string;
  name: string;
  team: string;
  category: string;
  status: string;
  authType: string;
  assessmentMode: "정적 사전검증";
  decision: AssessmentDecision;
  sourceDecision: AssessmentDecision;
  decisionKo: string;
  decisionHint: string;
  riskLabels: RiskLabel[];
  riskLabelNames: string[];
  riskScore: number;
  reasons: string[];
  representativeRiskyTools: string[];
  gatewayPolicyRecommendation: string;
  userNextAction: string;
  operatorHandoff: string;
  operatorHandoffStructured: OperatorHandoffStructured;
  assessmentLimit: string;
}

export interface RiskExplanation {
  label: RiskLabel;
  labelName: string;
  explanation: string;
}

const RISK_EXPLANATIONS: Record<RiskLabel, string> = {
  read_only: "조회, 검색, 목록 확인처럼 외부 상태를 바꾸지 않는 도구로 보입니다.",
  mutation: "생성, 수정, 저장, 전송처럼 외부 상태를 바꿀 수 있는 도구가 포함됩니다.",
  destructive_control: "삭제, 초기화, 우회, 롤백처럼 되돌리기 어려운 제어 동작이 포함될 수 있습니다.",
  messaging: "메시지 작성이나 대화 전송처럼 다른 사람에게 전달되는 행동과 연결될 수 있습니다.",
  calendar_write: "일정이나 할 일을 만들거나 바꾸는 쓰기 동작이 포함될 수 있습니다.",
  commerce: "상품, 주문, 결제, 환불, 선물처럼 금전성 행동과 연결될 수 있습니다.",
  finance: "주식, 공시, 투자, 세금처럼 재무 판단에 영향을 줄 수 있는 정보를 다룹니다.",
  medical_safety: "의약품, 병원, 응급, 증상처럼 건강이나 안전 판단에 영향을 줄 수 있는 정보를 다룹니다.",
  legal_public: "법령, 행정, 세금, 특허처럼 법률 또는 공공 의사결정에 영향을 줄 수 있는 정보를 다룹니다.",
  location_privacy: "주소, 경로, 주변 장소, 위치처럼 개인의 동선이나 장소 정보와 연결될 수 있습니다.",
  code_execution: "명령 실행, 컨테이너 생성, 터미널 제어처럼 로컬 또는 원격 실행 위험이 큽니다.",
  content_generation: "문서, 이미지, 글, 요약처럼 콘텐츠를 생성하거나 변환하는 도구입니다.",
  requires_auth: "계정 인증 또는 외부 서비스 권한이 필요해 등록 전 권한 범위 확인이 필요합니다.",
  unknown: "inventory 정보만으로 도구 의미가 충분히 분류되지 않아 운영자 검토가 필요합니다.",
};

export function presentAssessment(item: AssessmentItem): PresentedPlayMcpAssessment {
  const decision = presentationDecision(item);
  const gatewayAction = gatewayPolicyRecommendation(decision);
  return {
    id: item.id,
    name: item.name,
    team: item.team,
    category: item.category,
    status: item.status,
    authType: item.authType,
    assessmentMode: item.assessmentMode,
    decision,
    sourceDecision: item.decision,
    decisionKo: DECISION_KO[decision],
    decisionHint: DECISION_HINT[decision],
    riskLabels: item.labels,
    riskLabelNames: item.labelNames,
    riskScore: item.riskScore,
    reasons: item.reasons,
    representativeRiskyTools: item.representativeRiskyTools,
    gatewayPolicyRecommendation: gatewayAction,
    userNextAction: userNextAction(decision),
    operatorHandoff: operatorHandoff(item, decision),
    operatorHandoffStructured: buildOperatorHandoff(item, decision, gatewayAction),
    assessmentLimit: ASSESSMENT_LIMIT,
  };
}

export function explainRiskLabels(labels: RiskLabel[]): RiskExplanation[] {
  return labels.map((label) => ({
    label,
    labelName: LABEL_KO[label],
    explanation: RISK_EXPLANATIONS[label],
  }));
}

export function formatAssessmentText(item: PresentedPlayMcpAssessment): string {
  return [
    `MCP 사전검증: ${item.name}`,
    `판정: ${item.decisionKo} (${item.decision})`,
    `위험 라벨: ${formatList(item.riskLabelNames)}`,
    `대표 위험 도구: ${formatList(item.representativeRiskyTools)}`,
    `Gateway 권장 정책: ${item.gatewayPolicyRecommendation}`,
    `다음 행동: ${item.userNextAction}`,
    `한계: ${item.assessmentLimit}`,
  ].join("\n");
}

export function formatSearchText(query: string, candidates: Array<{ name: string; decisionKo: string; confidence: number; matchReason: string }>): string {
  if (candidates.length === 0) {
    return `PlayMCP 후보 검색: "${query}"\n후보 없음\n다음 행동: 이름을 다시 확인하거나 운영자 수동 검토로 넘기세요.`;
  }
  return [
    `PlayMCP 후보 검색: "${query}"`,
    ...candidates.map((candidate, index) => `${index + 1}. ${candidate.name} - ${candidate.decisionKo}, confidence=${candidate.confidence.toFixed(2)}, ${candidate.matchReason}`),
  ].join("\n");
}

export function formatRiskExplanationText(explanations: RiskExplanation[]): string {
  if (explanations.length === 0) return "설명할 risk label이 없습니다. 운영자 수동 검토가 필요합니다.";
  return [
    "Risk label 설명",
    ...explanations.map((entry) => `- ${entry.labelName} (${entry.label}): ${entry.explanation}`),
  ].join("\n");
}

function presentationDecision(item: AssessmentItem): AssessmentDecision {
  if (item.decision === "usable" && item.labels.some((label) => HIGH_RISK_LABELS.has(label))) {
    return "manual_review";
  }
  return item.decision;
}

function gatewayPolicyRecommendation(decision: AssessmentDecision): string {
  return GATEWAY_ACTION[decision];
}

function userNextAction(decision: AssessmentDecision): string {
  switch (decision) {
    case "usable":
      return "Gateway 뒤에 등록한 뒤 read-only 도구 중심으로 노출하고, 노출 목록을 확인하세요.";
    case "usable_with_approval":
      return "직접 연결하지 말고 operator에게 approval_required 또는 limited_alias 정책으로 등록을 요청하세요.";
    case "manual_review":
      return "운영자가 도구 목적, 인증 범위, 사용자 데이터 처리를 확인하기 전까지 노출하지 마세요.";
    case "not_recommended":
      return "일반 사용자는 연결하지 않는 쪽을 권장하며, 꼭 필요하면 operator 예외 검토를 요청하세요.";
    case "blocked":
      return "일반 사용자 연결 후보에서 제외하고 Gateway 정책은 block으로 두세요.";
  }
}

function operatorHandoff(item: AssessmentItem, decision: AssessmentDecision): string {
  const tools = item.representativeRiskyTools.length > 0 ? item.representativeRiskyTools.join(", ") : "대표 위험 tool 없음";
  return [
    `MCP=${item.name}`,
    `id=${item.id}`,
    `decision=${decision}`,
    `labels=${item.labels.join(",")}`,
    `gatewayAction=${gatewayPolicyRecommendation(decision)}`,
    `riskTools=${tools}`,
    "등록 전 tools/list 재수집과 정책 리뷰 필요",
  ].join(" | ");
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "없음";
}
