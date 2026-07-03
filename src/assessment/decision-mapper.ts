import type { PlayMcpInventoryRow } from "./inventory-loader";
import type { RiskClassification, RiskLabel } from "./risk-classifier";

export type AssessmentDecision = "usable" | "usable_with_approval" | "manual_review" | "not_recommended" | "blocked";

export interface DecisionMapping {
  decision: AssessmentDecision;
  decisionKo: string;
  decisionHint: string;
  gatewayAction: string;
}

export const DECISION_KO: Record<AssessmentDecision, string> = {
  usable: "사용 가능",
  usable_with_approval: "승인 후 사용",
  manual_review: "수동 검토",
  not_recommended: "비추천",
  blocked: "차단 권장",
};

export const DECISION_HINT: Record<AssessmentDecision, string> = {
  usable: "읽기/조회 위주로 보이며 기본 정책에서 제한 허용 후보입니다.",
  usable_with_approval: "개인정보, 외부 행위, 쓰기 또는 금전성 맥락이 있어 승인 후 사용해야 합니다.",
  manual_review: "도구 의미가 불명확하거나 고위험 도메인이라 운영자가 정책을 직접 확정해야 합니다.",
  not_recommended: "의료/금융/법률 판단 또는 민감 데이터 처리 가능성이 높아 기본 사용은 권장하지 않습니다.",
  blocked: "명령 실행, 파괴적 제어, 강한 side effect 가능성이 있어 기본 차단해야 합니다.",
};

export const GATEWAY_ACTION: Record<AssessmentDecision, string> = {
  usable: "allow 또는 limited_alias",
  usable_with_approval: "approval_required + 일부 read-only allow",
  manual_review: "manual_review, 기본 upstream 미노출",
  not_recommended: "block 기본값, 필요 시 operator 예외 정책",
  blocked: "block, target 호출 금지",
};

export function mapAssessmentDecision(row: PlayMcpInventoryRow, risk: RiskClassification): DecisionMapping {
  const labels = new Set<RiskLabel>(risk.labels);
  const text = [row.name, row.category, row.toolNames, row.starterMessages, row.description].join(" ").toLowerCase();
  let decision: AssessmentDecision;

  if (
    labels.has("code_execution") ||
    (labels.has("destructive_control") && includesAny(text, ["delete", "destroy", "bypass", "rollback", "execute", "logout_all", "activate_emergency", "delete_child"]))
  ) {
    decision = "blocked";
  } else if (
    labels.has("medical_safety") &&
    includesAny(text, ["analyze_symptoms", "drug_interaction", "dosage", "contraindication", "diagnose", "응급", "진단", "복약", "성범죄"])
  ) {
    decision = "not_recommended";
  } else if (labels.has("finance") && includesAny(text, ["stock", "투자", "prediction", "probability", "finance_news", "주식"])) {
    decision = "manual_review";
  } else if (labels.has("legal_public") && includesAny(text, ["legal_qa", "법률 자문", "tax", "절세", "소송"])) {
    decision = "manual_review";
  } else if (hasAnyLabel(labels, ["destructive_control", "messaging", "calendar_write", "commerce", "location_privacy", "mutation", "requires_auth"])) {
    decision = "usable_with_approval";
  } else if (labels.has("unknown")) {
    decision = "manual_review";
  } else {
    decision = "usable";
  }

  if (decision === "usable" && hasAnyLabel(labels, ["medical_safety", "finance", "legal_public"])) {
    decision = "manual_review";
  }

  return {
    decision,
    decisionKo: DECISION_KO[decision],
    decisionHint: DECISION_HINT[decision],
    gatewayAction: GATEWAY_ACTION[decision],
  };
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle.toLowerCase()));
}

function hasAnyLabel(labels: Set<RiskLabel>, wanted: RiskLabel[]): boolean {
  return wanted.some((label) => labels.has(label));
}
