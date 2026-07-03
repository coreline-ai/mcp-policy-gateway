import { assessRow } from "./report-model";
import type { AssessmentDecision } from "./decision-mapper";
import type { RiskLabel } from "./risk-classifier";

export interface UnknownMcpIntakeInput {
  name: string;
  homepageOrPackageUrl?: string;
  declaredTools?: string[];
  reasonForUse?: string;
}

export interface UnknownMcpIntake {
  status: "manual_review";
  name: string;
  homepageOrPackageUrl?: string;
  declaredTools: string[];
  provisionalDecision: AssessmentDecision;
  provisionalRiskLabels: RiskLabel[];
  requiredInformation: string[];
  userNextAction: string;
  networkFetched: false;
}

export function buildUnknownMcpIntake(input: UnknownMcpIntakeInput): UnknownMcpIntake {
  const declaredTools = (input.declaredTools ?? []).map((tool) => tool.trim()).filter(Boolean);
  const synthetic = assessRow({
    id: "unknown-mcp",
    name: input.name || "Unknown MCP",
    team: "unknown",
    teamType: "UNKNOWN",
    status: "UNKNOWN",
    authType: "UNKNOWN",
    category: "기타/실험",
    toolCount: declaredTools.length,
    monthlyToolCallCount: 0,
    totalToolCallCount: 0,
    featuredLevel: "0",
    toolNames: declaredTools.join("|"),
    tools: declaredTools,
    starterMessages: input.reasonForUse ?? "",
    description: [input.homepageOrPackageUrl ?? "", input.reasonForUse ?? ""].join(" "),
  });
  const provisionalDecision = conservativeUnknownDecision(synthetic.labels);

  return {
    status: "manual_review",
    name: input.name || "Unknown MCP",
    homepageOrPackageUrl: shapeOnlyUrl(input.homepageOrPackageUrl),
    declaredTools,
    provisionalDecision,
    provisionalRiskLabels: synthetic.labels,
    requiredInformation: requiredInformation(declaredTools),
    userNextAction: "PlayMCP inventory에서 찾지 못했습니다. target MCP를 직접 연결하지 말고 아래 정보를 operator 검토로 넘기세요.",
    networkFetched: false,
  };
}

function conservativeUnknownDecision(labels: RiskLabel[]): AssessmentDecision {
  if (labels.includes("code_execution") || labels.includes("destructive_control")) return "blocked";
  return "manual_review";
}

function requiredInformation(declaredTools: string[]): string[] {
  const info = [
    "MCP name and source URL or package identifier",
    "Declared tools/list output or documentation",
    "Authentication and permission scopes",
    "Expected user data handled by the MCP",
    "Reason for use and required workflow",
  ];
  if (declaredTools.length === 0) info.unshift("Tool names or tools/list snapshot");
  return info;
}

function shapeOnlyUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.toString();
  } catch {
    return value.trim();
  }
}
