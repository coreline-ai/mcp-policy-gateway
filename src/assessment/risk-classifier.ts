import type { PlayMcpInventoryRow } from "./inventory-loader";

export type RiskLabel =
  | "read_only"
  | "mutation"
  | "destructive_control"
  | "messaging"
  | "calendar_write"
  | "commerce"
  | "finance"
  | "medical_safety"
  | "legal_public"
  | "location_privacy"
  | "code_execution"
  | "content_generation"
  | "requires_auth"
  | "unknown";

export interface RiskClassification {
  labels: RiskLabel[];
  labelNames: string[];
  riskScore: number;
  reasons: string[];
  representativeRiskyTools: string[];
}

export const LABEL_KO: Record<RiskLabel, string> = {
  read_only: "읽기/조회형",
  mutation: "상태 변경 가능",
  destructive_control: "파괴적/제어성",
  messaging: "메시지/대화 전송",
  calendar_write: "일정/작업 쓰기",
  commerce: "커머스/주문/가격",
  finance: "금융/투자",
  medical_safety: "의료/안전",
  legal_public: "법률/공공",
  location_privacy: "위치/동선 개인정보",
  code_execution: "코드/명령 실행",
  content_generation: "콘텐츠 생성/문서",
  requires_auth: "인증 필요",
  unknown: "분류 불명확",
};

export const HIGH_RISK_LABELS = new Set<RiskLabel>([
  "mutation",
  "messaging",
  "calendar_write",
  "commerce",
  "code_execution",
  "destructive_control",
]);

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

const CATEGORY_LABELS: Record<string, RiskLabel[]> = {
  "커머스/쇼핑/배송": ["commerce"],
  "금융/투자/사업": ["finance"],
  "헬스/의료/안전": ["medical_safety"],
  "법률/공공/행정": ["legal_public"],
  "생활/로컬/교통": ["location_privacy"],
  "생산성/문서/개발": ["content_generation"],
};

const FULL_TEXT_KEYWORDS: Record<RiskLabel, string[]> = {
  messaging: ["memochat", "talk_to", "message", "generate_message", "draft_", "send", "카카오톡", "카톡", "단톡방", "메시지", "채팅"],
  commerce: ["gift", "order", "refund", "inventory", "price", "product", "shop", "store", "hotel", "booking", "bookable", "cart", "purchase", "daiso", "선물", "주문", "결제", "환불", "상품", "쇼핑", "배송", "숙소", "예약"],
  finance: ["stock", "financial", "finance", "disclosure", "dart", "dividend", "투자", "주식", "금융", "공시", "세금", "절세", "bid", "probability"],
  medical_safety: ["drug", "hospital", "pharmacy", "emergency", "symptom", "disease", "health", "crime", "sexual", "lifeguard", "medicine", "복약", "의약품", "병원", "약국", "응급", "의료", "건강", "안전", "성범죄", "진단"],
  legal_public: ["law", "legal", "trademark", "patent", "ordinance", "tax", "법령", "법률", "행정", "특허", "상표", "공공", "민원"],
  location_privacy: ["map", "route", "geocode", "nearby", "transit", "address", "place", "station", "airport", "train", "toilet", "lost", "coord", "distance", "location", "지도", "위치", "주소", "경로", "교통", "근처", "분실물", "공항", "기차"],
  content_generation: ["generate_", "create_content", "optimize", "summarize", "draft", "mermaid", "image", "visual", "post", "글", "문서", "요약", "콘텐츠"],
  read_only: ["search", "get_", "list_", "find_", "fetch", "lookup", "view", "show_", "compare", "recommend", "analyze", "read_", "검색", "조회", "추천", "비교", "목록", "정보"],
  mutation: [],
  destructive_control: [],
  calendar_write: [],
  code_execution: [],
  requires_auth: [],
  unknown: [],
};

const TOOL_ONLY_KEYWORDS: Record<RiskLabel, string[]> = {
  code_execution: ["execute_command", "create_container", "destroy_container", "check_command_status", "run_command", "terminal", "shell"],
  destructive_control: ["delete", "destroy", "logout_all", "archive_block", "bypass", "rollback", "activate_emergency", "apply_profile", "remove", "clear_", "reset"],
  calendar_write: ["createevent", "createtask", "addschedule", "create_event", "create_task", "schedule_", "record_event"],
  read_only: [],
  mutation: [],
  messaging: [],
  commerce: [],
  finance: [],
  medical_safety: [],
  legal_public: [],
  location_privacy: [],
  content_generation: [],
  requires_auth: [],
  unknown: [],
};

const MUTATION_TOOL = /(^|[_-])(add|create|update|delete|remove|save|send|apply|rollback|bypass|register|logout|archive|execute|destroy|grant|reject|schedule|order|book|pay|refund|link|upload|download)([_-]|$)/i;
const READ_ONLY_TOOL = /^(search|get|list|find|fetch|lookup|view|show|compare|recommend|analyze|read)/i;

export function classifyRisk(row: PlayMcpInventoryRow): RiskClassification {
  const labels = new Set<RiskLabel>();
  const reasons: string[] = [];
  const fullText = [row.name, row.category, row.toolNames, row.starterMessages, row.description].join(" ");

  for (const label of CATEGORY_LABELS[row.category] ?? []) {
    addLabel(labels, reasons, label, `카테고리 기준: ${LABEL_KO[label]}`);
  }

  for (const [label, keywords] of typedEntries(FULL_TEXT_KEYWORDS)) {
    if (keywords.length > 0 && hasAny(fullText, keywords)) addLabel(labels, reasons, label, `키워드 기준: ${LABEL_KO[label]}`);
  }

  for (const [label, keywords] of typedEntries(TOOL_ONLY_KEYWORDS)) {
    if (keywords.length > 0 && (hasAny(row.tools.join(" "), keywords) || (label === "code_execution" && row.name === "컴퓨터 사용"))) {
      addLabel(labels, reasons, label, `도구명 기준: ${LABEL_KO[label]}`);
    }
  }

  const mutationTools = row.tools.filter((tool) => MUTATION_TOOL.test(tool));
  if (mutationTools.length > 0) {
    addLabel(labels, reasons, "mutation", `상태 변경 동사 포함 도구: ${mutationTools.slice(0, 5).join(", ")}`);
  }

  if (row.authType && row.authType !== "NONE") {
    addLabel(labels, reasons, "requires_auth", `인증 방식: ${row.authType}`);
  }

  if (row.tools.length > 0 && row.tools.every((tool) => READ_ONLY_TOOL.test(tool))) {
    addLabel(labels, reasons, "read_only", "도구명이 주로 조회/검색형 동사로 구성됨");
  }

  if (row.tools.length === 0) {
    addLabel(labels, reasons, "unknown", "toolNames가 비어 있어 정적 판정 불충분");
  }

  if (labels.size === 0) {
    addLabel(labels, reasons, "unknown", "정적 키워드로 충분히 분류되지 않아 보수적으로 수동 검토 처리");
  }

  const sortedLabels = sortLabels([...labels]);
  return {
    labels: sortedLabels,
    labelNames: sortedLabels.map((label) => LABEL_KO[label]),
    riskScore: riskScore(sortedLabels),
    reasons: unique(reasons).slice(0, 8),
    representativeRiskyTools: representativeRiskyTools(row, sortedLabels),
  };
}

export function sortLabels(labels: RiskLabel[]): RiskLabel[] {
  return labels.sort((a, b) => LABEL_ORDER.indexOf(a) - LABEL_ORDER.indexOf(b));
}

function representativeRiskyTools(row: PlayMcpInventoryRow, labels: RiskLabel[]): string[] {
  const keywords = [
    ...TOOL_ONLY_KEYWORDS.code_execution,
    ...TOOL_ONLY_KEYWORDS.destructive_control,
    ...TOOL_ONLY_KEYWORDS.calendar_write,
    ...FULL_TEXT_KEYWORDS.messaging,
    ...FULL_TEXT_KEYWORDS.commerce,
    ...FULL_TEXT_KEYWORDS.finance,
    ...FULL_TEXT_KEYWORDS.medical_safety,
    ...FULL_TEXT_KEYWORDS.legal_public,
    ...FULL_TEXT_KEYWORDS.location_privacy,
  ].map((k) => k.toLowerCase());

  const tools = row.tools.filter((tool) => MUTATION_TOOL.test(tool) || keywords.some((keyword) => tool.toLowerCase().includes(keyword)));
  if (tools.length > 0) return tools.slice(0, 8);
  if (labels.includes("unknown")) return [];
  return row.tools.slice(0, 3);
}

function riskScore(labels: RiskLabel[]): number {
  const scoreByLabel: Record<RiskLabel, number> = {
    read_only: 5,
    content_generation: 15,
    requires_auth: 30,
    location_privacy: 35,
    mutation: 35,
    legal_public: 40,
    calendar_write: 45,
    commerce: 45,
    finance: 45,
    medical_safety: 55,
    destructive_control: 75,
    code_execution: 90,
    messaging: 50,
    unknown: 50,
  };
  return labels.reduce((score, label) => Math.max(score, scoreByLabel[label]), 10);
}

function addLabel(labels: Set<RiskLabel>, reasons: string[], label: RiskLabel, reason: string): void {
  labels.add(label);
  reasons.push(reason);
}

function hasAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function typedEntries<T extends Record<string, unknown>>(obj: T): Array<[keyof T, T[keyof T]]> {
  return Object.entries(obj) as Array<[keyof T, T[keyof T]]>;
}
