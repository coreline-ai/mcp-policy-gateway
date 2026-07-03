import { DEFAULT_PLAYMCP_INVENTORY_PATH, loadPlayMcpInventory } from "./inventory-loader";
import { inventoryFreshness, type InventoryFreshness } from "./inventory-freshness";
import { assessRow, type AssessmentItem } from "./report-model";
import { sortLabels, type RiskLabel } from "./risk-classifier";
import { buildUnknownMcpIntake, type UnknownMcpIntake } from "./unknown-mcp-intake";
import {
  ASSESSMENT_LIMIT,
  explainRiskLabels,
  presentAssessment,
  type PresentedPlayMcpAssessment,
  type RiskExplanation,
} from "./preflight-presenter";

export interface PreflightOptions {
  inventoryPath?: string;
}

export interface SearchPlayMcpResult {
  id: string;
  name: string;
  team: string;
  category: string;
  decision: string;
  decisionKo: string;
  riskLabels: RiskLabel[];
  riskLabelNames: string[];
  riskScore: number;
  confidence: number;
  matchReason: string;
}

export interface SearchPlayMcpResponse {
  status: "ok";
  query: string;
  sourcePath: string;
  inventorySource: string;
  snapshotDate: string | null;
  generatedAt: string;
  freshnessNote: string;
  freshness: InventoryFreshness;
  totalInventoryRows: number;
  candidates: SearchPlayMcpResult[];
  assessmentLimit: string;
}

export type PreflightPlayMcpResponse =
  | {
      status: "assessed";
      query?: string;
      sourcePath: string;
      inventorySource: string;
      snapshotDate: string | null;
      generatedAt: string;
      freshnessNote: string;
      freshness: InventoryFreshness;
      totalInventoryRows: number;
      item: PresentedPlayMcpAssessment;
      candidates?: SearchPlayMcpResult[];
      assessmentLimit: string;
    }
  | {
      status: "ambiguous";
      query: string;
      sourcePath: string;
      inventorySource: string;
      snapshotDate: string | null;
      generatedAt: string;
      freshnessNote: string;
      freshness: InventoryFreshness;
      totalInventoryRows: number;
      candidates: SearchPlayMcpResult[];
      decision: "manual_review";
      decisionKo: "수동 검토";
      userNextAction: string;
      assessmentLimit: string;
    }
  | {
      status: "not_found";
      query: string;
      sourcePath: string;
      inventorySource: string;
      snapshotDate: string | null;
      generatedAt: string;
      freshnessNote: string;
      freshness: InventoryFreshness;
      totalInventoryRows: number;
      candidates: SearchPlayMcpResult[];
      unknownMcpIntake: UnknownMcpIntake;
      decision: "manual_review";
      decisionKo: "수동 검토";
      userNextAction: string;
      assessmentLimit: string;
    };

export interface PreflightPlayMcpInput {
  id?: string;
  name?: string;
  query?: string;
  includeCandidates?: boolean;
  homepageOrPackageUrl?: string;
  declaredTools?: string[];
  reasonForUse?: string;
}

export type ExplainRiskResponse =
  | {
      status: "explained";
      sourcePath: string;
      inventorySource: string;
      snapshotDate: string | null;
      generatedAt: string;
      freshnessNote: string;
      freshness: InventoryFreshness;
      item?: PresentedPlayMcpAssessment;
      labels: RiskLabel[];
      explanations: RiskExplanation[];
      assessmentLimit: string;
    }
  | {
      status: "ambiguous" | "not_found";
      query: string;
      candidates: SearchPlayMcpResult[];
      decision: "manual_review";
      decisionKo: "수동 검토";
      userNextAction: string;
      assessmentLimit: string;
    };

export interface ExplainRiskInput {
  id?: string;
  query?: string;
  labels?: string[];
}

interface LoadedAssessment {
  sourcePath: string;
  items: AssessmentItem[];
}

interface ScoredItem {
  item: AssessmentItem;
  score: number;
  reason: string;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const AUTO_SELECT_CONFIDENCE = 0.72;
const STOPWORDS = new Set([
  "mcp",
  "mcp는",
  "mcp를",
  "mcp가",
  "연결",
  "연결해도",
  "연결해",
  "돼",
  "되",
  "되나",
  "되나요",
  "괜찮아",
  "괜찮나요",
  "써도",
  "쓸수",
  "쓸",
  "수",
  "있어",
  "있나요",
  "알려줘",
  "어떤",
  "승인",
  "필요해",
  "필요",
  "왜",
  "차단",
  "후보야",
  "위험",
  "판단",
  "해줘",
]);

export function resolvePlayMcpInventoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLAYMCP_INVENTORY_CSV ?? DEFAULT_PLAYMCP_INVENTORY_PATH;
}

export function loadPlayMcpAssessment(options: PreflightOptions = {}): LoadedAssessment {
  const sourcePath = options.inventoryPath ?? resolvePlayMcpInventoryPath();
  const items = loadPlayMcpInventory(sourcePath).map(assessRow);
  return { sourcePath, items };
}

export function searchPlayMcp(query: string, limit = DEFAULT_LIMIT, options: PreflightOptions = {}): SearchPlayMcpResponse {
  const loaded = loadPlayMcpAssessment(options);
  const candidates = searchLoadedItems(loaded.items, query, limit).map(toSearchResult);
  const fresh = freshnessFields(loaded.sourcePath);
  return {
    status: "ok",
    query,
    sourcePath: loaded.sourcePath,
    ...fresh,
    totalInventoryRows: loaded.items.length,
    candidates,
    assessmentLimit: ASSESSMENT_LIMIT,
  };
}

export function preflightPlayMcp(input: PreflightPlayMcpInput, options: PreflightOptions = {}): PreflightPlayMcpResponse {
  const loaded = loadPlayMcpAssessment(options);
  const query = firstNonEmpty(input.id, input.name, input.query);

  const exactMatches = exactMatch(loaded.items, input.id, input.name);
  if (exactMatches.length === 1) {
    const candidates = input.includeCandidates ? searchLoadedItems(loaded.items, query, DEFAULT_LIMIT).map(toSearchResult) : undefined;
    return assessedResponse(exactMatches[0]!, loaded, query, candidates);
  }
  if (exactMatches.length > 1) {
    return ambiguousResponse(query, loaded, exactMatches.map((item) => toSearchResult({ item, score: 900, reason: "동일한 MCP 이름이 여러 개 존재" })));
  }

  const scored = searchLoadedItems(loaded.items, query, input.includeCandidates ? DEFAULT_LIMIT : Math.max(2, DEFAULT_LIMIT));
  if (scored.length === 0) return notFoundResponse(query, loaded, input);

  const top = scored[0]!;
  const tied = scored.filter((candidate) => candidate.score === top.score);
  if (top.scoreToConfidence >= AUTO_SELECT_CONFIDENCE && tied.length === 1) {
    const candidates = input.includeCandidates ? scored.slice(0, DEFAULT_LIMIT).map(toSearchResult) : undefined;
    return assessedResponse(top.item, loaded, query, candidates);
  }

  return ambiguousResponse(query, loaded, scored.slice(0, DEFAULT_LIMIT).map(toSearchResult));
}

export function explainPlayMcpRisk(input: ExplainRiskInput, options: PreflightOptions = {}): ExplainRiskResponse {
  const labels = normalizeRiskLabels(input.labels ?? []);
  if (labels.length > 0) {
    return {
      status: "explained",
      sourcePath: options.inventoryPath ?? resolvePlayMcpInventoryPath(),
      ...freshnessFields(options.inventoryPath ?? resolvePlayMcpInventoryPath()),
      labels,
      explanations: explainRiskLabels(labels),
      assessmentLimit: ASSESSMENT_LIMIT,
    };
  }

  const preflight = preflightPlayMcp({ id: input.id, query: input.query }, options);
  if (preflight.status !== "assessed") {
    return {
      status: preflight.status,
      query: preflight.query,
      candidates: preflight.candidates,
      decision: "manual_review",
      decisionKo: "수동 검토",
      userNextAction: preflight.userNextAction,
      assessmentLimit: ASSESSMENT_LIMIT,
    };
  }

  return {
    status: "explained",
    sourcePath: preflight.sourcePath,
    inventorySource: preflight.inventorySource,
    snapshotDate: preflight.snapshotDate,
    generatedAt: preflight.generatedAt,
    freshnessNote: preflight.freshnessNote,
    freshness: preflight.freshness,
    item: preflight.item,
    labels: preflight.item.riskLabels,
    explanations: explainRiskLabels(preflight.item.riskLabels),
    assessmentLimit: ASSESSMENT_LIMIT,
  };
}

function searchLoadedItems(items: AssessmentItem[], query: string, limit: number): Array<ScoredItem & { scoreToConfidence: number }> {
  const max = clampLimit(limit);
  const info = queryInfo(query);
  if (!info.normalized && info.tokens.length === 0) return [];

  return items
    .map((item) => scoreItem(item, info))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "ko") || Number(a.item.id) - Number(b.item.id))
    .slice(0, max)
    .map((entry) => ({ ...entry, scoreToConfidence: scoreToConfidence(entry.score) }));
}

function scoreItem(item: AssessmentItem, info: ReturnType<typeof queryInfo>): ScoredItem {
  const itemName = normalizeSearchText(item.name);
  const itemId = normalizeSearchText(item.id);
  const category = normalizeSearchText(item.category);
  const team = normalizeSearchText(item.team);
  const tools = normalizeSearchText(item.tools.join(" "));
  const description = normalizeSearchText([item.description, item.reasons.join(" "), item.labelNames.join(" ")].join(" "));
  let score = 0;
  const reasons: string[] = [];

  if (info.normalized && itemId === info.normalized) {
    score += 1000;
    reasons.push("id exact");
  }
  if (info.normalized && itemName === info.normalized) {
    score += 920;
    reasons.push("name exact");
  } else if (info.normalized && info.normalized.includes(itemName) && itemName.length >= 2) {
    score += 760;
    reasons.push("query contains name");
  } else if (info.normalized && itemName.includes(info.normalized) && info.normalized.length >= 2) {
    score += 700;
    reasons.push("name contains query");
  }

  for (const token of info.tokens) {
    if (itemName === token) {
      score += 120;
      reasons.push(`name token exact:${token}`);
    } else if (itemName.includes(token)) {
      score += 90;
      reasons.push(`name token:${token}`);
    } else if (tools.includes(token)) {
      score += 45;
      reasons.push(`tool token:${token}`);
    } else if (category.includes(token) || team.includes(token)) {
      score += 35;
      reasons.push(`metadata token:${token}`);
    } else if (description.includes(token)) {
      score += 15;
      reasons.push(`description token:${token}`);
    }
  }

  return { item, score, reason: unique(reasons).slice(0, 3).join(", ") || "keyword match" };
}

function exactMatch(items: AssessmentItem[], id?: string, name?: string): AssessmentItem[] {
  const normalizedId = normalizeSearchText(id ?? "");
  const normalizedName = normalizeSearchText(name ?? "");
  if (normalizedId) {
    const byId = items.filter((item) => normalizeSearchText(item.id) === normalizedId);
    if (byId.length > 0) return byId;
  }
  if (normalizedName) return items.filter((item) => normalizeSearchText(item.name) === normalizedName);
  return [];
}

function assessedResponse(
  item: AssessmentItem,
  loaded: LoadedAssessment,
  query: string,
  candidates?: SearchPlayMcpResult[],
): PreflightPlayMcpResponse {
  const fresh = freshnessFields(loaded.sourcePath);
  return {
    status: "assessed",
    query: query || undefined,
    sourcePath: loaded.sourcePath,
    ...fresh,
    totalInventoryRows: loaded.items.length,
    item: presentAssessment(item),
    candidates,
    assessmentLimit: ASSESSMENT_LIMIT,
  };
}

function ambiguousResponse(query: string, loaded: LoadedAssessment, candidates: SearchPlayMcpResult[]): PreflightPlayMcpResponse {
  const fresh = freshnessFields(loaded.sourcePath);
  return {
    status: "ambiguous",
    query,
    sourcePath: loaded.sourcePath,
    ...fresh,
    totalInventoryRows: loaded.items.length,
    candidates,
    decision: "manual_review",
    decisionKo: "수동 검토",
    userNextAction: "후보가 여러 개입니다. 원하는 MCP 이름 또는 id를 골라 다시 사전검증하세요.",
    assessmentLimit: ASSESSMENT_LIMIT,
  };
}

function notFoundResponse(query: string, loaded: LoadedAssessment, input: PreflightPlayMcpInput = {}): PreflightPlayMcpResponse {
  const fresh = freshnessFields(loaded.sourcePath);
  return {
    status: "not_found",
    query,
    sourcePath: loaded.sourcePath,
    ...fresh,
    totalInventoryRows: loaded.items.length,
    candidates: [],
    unknownMcpIntake: buildUnknownMcpIntake({
      name: query || input.name || "Unknown MCP",
      homepageOrPackageUrl: input.homepageOrPackageUrl,
      declaredTools: input.declaredTools,
      reasonForUse: input.reasonForUse,
    }),
    decision: "manual_review",
    decisionKo: "수동 검토",
    userNextAction: "inventory에서 후보를 찾지 못했습니다. 이름을 다시 확인하거나 operator 수동 검토로 넘기세요.",
    assessmentLimit: ASSESSMENT_LIMIT,
  };
}

function freshnessFields(sourcePath: string): InventoryFreshness & { freshness: InventoryFreshness } {
  const freshness = inventoryFreshness(sourcePath);
  return { ...freshness, freshness };
}

function toSearchResult(entry: ScoredItem & { scoreToConfidence?: number }): SearchPlayMcpResult {
  const presented = presentAssessment(entry.item);
  return {
    id: entry.item.id,
    name: entry.item.name,
    team: entry.item.team,
    category: entry.item.category,
    decision: presented.decision,
    decisionKo: presented.decisionKo,
    riskLabels: presented.riskLabels,
    riskLabelNames: presented.riskLabelNames,
    riskScore: presented.riskScore,
    confidence: entry.scoreToConfidence ?? scoreToConfidence(entry.score),
    matchReason: entry.reason,
  };
}

function normalizeRiskLabels(labels: string[]): RiskLabel[] {
  const valid = new Set(Object.keys(LABEL_NAMES) as RiskLabel[]);
  return sortLabels(labels.filter((label): label is RiskLabel => valid.has(label as RiskLabel)));
}

const LABEL_NAMES: Record<RiskLabel, true> = {
  read_only: true,
  mutation: true,
  destructive_control: true,
  messaging: true,
  calendar_write: true,
  commerce: true,
  finance: true,
  medical_safety: true,
  legal_public: true,
  location_privacy: true,
  code_execution: true,
  content_generation: true,
  requires_auth: true,
  unknown: true,
};

function queryInfo(query: string): { normalized: string; tokens: string[] } {
  const normalized = normalizeSearchText(query);
  const tokens = normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  return { normalized, tokens: unique(tokens) };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/mcp/g, " ")
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreToConfidence(score: number): number {
  return Math.min(1, Math.round((score / 920) * 100) / 100);
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
