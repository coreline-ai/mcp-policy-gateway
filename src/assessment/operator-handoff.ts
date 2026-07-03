import type { AssessmentDecision } from "./decision-mapper";
import type { AssessmentItem } from "./report-model";
import type { RiskLabel } from "./risk-classifier";

export interface OperatorHandoffStructured {
  mcpId: string;
  mcpName: string;
  decision: AssessmentDecision;
  riskLabels: RiskLabel[];
  representativeRiskyTools: string[];
  recommendedGatewayAction: string;
  requiredReviewChecks: string[];
  registrationBoundary: string;
  policyDraftHint: string;
}

const REGISTRATION_BOUNDARY =
  "Target MCP registration remains a privileged operator/config action. This handoff is not an automatic registration command.";

export function buildOperatorHandoff(item: AssessmentItem, decision: AssessmentDecision, recommendedGatewayAction: string): OperatorHandoffStructured {
  return {
    mcpId: item.id,
    mcpName: item.name,
    decision,
    riskLabels: item.labels,
    representativeRiskyTools: item.representativeRiskyTools,
    recommendedGatewayAction,
    requiredReviewChecks: reviewChecks(item.labels, decision),
    registrationBoundary: REGISTRATION_BOUNDARY,
    policyDraftHint: policyDraftHint(decision),
  };
}

function reviewChecks(labels: RiskLabel[], decision: AssessmentDecision): string[] {
  const checks = new Set<string>([
    "Re-run tools/list behind the Gateway before exposure.",
    "Confirm target credentials are not embedded in policy, command args, audit, or tool schemas.",
    "Expose only reviewed aliases; do not expose the raw target surface by default.",
  ]);

  if (labels.includes("commerce")) checks.add("Review purchase, order, payment, refund, gift, and price-changing tools.");
  if (labels.includes("messaging")) checks.add("Review message sending, chat posting, and recipient selection tools.");
  if (labels.includes("calendar_write")) checks.add("Review event/task creation or schedule mutation tools.");
  if (labels.includes("location_privacy")) checks.add("Review address, route, nearby place, and user-location handling.");
  if (labels.includes("code_execution")) checks.add("Keep command/container/file-execution tools blocked unless a separate isolation plan exists.");
  if (labels.includes("destructive_control")) checks.add("Review delete, reset, rollback, bypass, logout, and irreversible control tools.");
  if (labels.includes("finance")) checks.add("Review financial decision support, investment, tax, and trading-related outputs.");
  if (labels.includes("medical_safety")) checks.add("Review medical, emergency, drug, diagnosis, and safety-related outputs.");
  if (labels.includes("legal_public")) checks.add("Review legal advice, tax, administrative, and public decision-support scope.");
  if (labels.includes("requires_auth")) checks.add("Confirm OAuth/API scopes and account permissions before registration.");
  if (labels.includes("unknown")) checks.add("Require operator tool-by-tool review because static inventory is insufficient.");

  if (decision !== "usable") checks.add("Do not allow direct client registration; keep the target behind Gateway policy.");
  return [...checks];
}

function policyDraftHint(decision: AssessmentDecision): string {
  switch (decision) {
    case "usable":
      return "Start with read-only allow or limited_alias rules after operator tools/list review.";
    case "usable_with_approval":
      return "Use approval_required for side-effect tools and limited_alias for constrained preview/dry-run tools.";
    case "manual_review":
      return "Keep upstream exposure empty until an operator writes explicit allow, limited_alias, approval_required, or block rules.";
    case "not_recommended":
      return "Default to block; document any operator exception with narrow aliases and audit expectations.";
    case "blocked":
      return "Default to block and do not forward calls to the target tool surface.";
  }
}
