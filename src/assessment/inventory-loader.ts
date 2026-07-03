import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PLAYMCP_INVENTORY_PATH =
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "playmcp_inventory_20260625.csv");

export type PlayMcpRawRow = Record<string, string>;

export interface PlayMcpInventoryRow {
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
  toolNames: string;
  tools: string[];
  starterMessages: string;
  description: string;
}

const REQUIRED_COLUMNS = [
  "id",
  "name",
  "team",
  "teamType",
  "status",
  "authType",
  "category",
  "toolCount",
  "monthlyToolCallCount",
  "totalToolCallCount",
  "featuredLevel",
  "toolNames",
  "starterMessages",
  "description",
] as const;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.length > 0));
}

export function parsePlayMcpInventoryCsv(text: string): PlayMcpInventoryRow[] {
  const parsed = parseCsv(text);
  const header = parsed[0];
  if (!header) throw new Error("PlayMCP inventory CSV is empty");

  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) throw new Error(`PlayMCP inventory missing required column: ${col}`);
  }

  return parsed.slice(1).map((fields, rowIndex) => {
    const raw: PlayMcpRawRow = {};
    header.forEach((name, i) => {
      raw[name] = fields[i] ?? "";
    });
    return normalizeRow(raw, rowIndex + 2);
  });
}

export function loadPlayMcpInventory(path = DEFAULT_PLAYMCP_INVENTORY_PATH): PlayMcpInventoryRow[] {
  return parsePlayMcpInventoryCsv(fs.readFileSync(path, "utf8"));
}

export function splitToolNames(toolNames: string): string[] {
  return toolNames.split("|").map((t) => t.trim()).filter(Boolean);
}

function normalizeRow(raw: PlayMcpRawRow, rowNumber: number): PlayMcpInventoryRow {
  const id = raw.id?.trim() ?? "";
  const name = raw.name?.trim() ?? "";
  if (!id || !name) throw new Error(`PlayMCP inventory row ${rowNumber} is missing id or name`);

  const toolNames = raw.toolNames ?? "";
  return {
    id,
    name,
    team: raw.team?.trim() ?? "",
    teamType: raw.teamType?.trim() ?? "",
    status: raw.status?.trim() ?? "",
    authType: raw.authType?.trim() ?? "",
    category: raw.category?.trim() ?? "",
    toolCount: parseInteger(raw.toolCount),
    monthlyToolCallCount: parseInteger(raw.monthlyToolCallCount),
    totalToolCallCount: parseInteger(raw.totalToolCallCount),
    featuredLevel: raw.featuredLevel?.trim() ?? "",
    toolNames,
    tools: splitToolNames(toolNames),
    starterMessages: raw.starterMessages ?? "",
    description: raw.description ?? "",
  };
}

function parseInteger(value: string | undefined): number {
  const n = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}
