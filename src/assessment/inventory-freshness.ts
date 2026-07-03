import path from "node:path";

export interface InventoryFreshness {
  inventorySource: string;
  snapshotDate: string | null;
  generatedAt: string;
  freshnessNote: string;
}

export function inventoryFreshness(sourcePath: string, generatedAt = new Date().toISOString()): InventoryFreshness {
  const snapshotDate = extractSnapshotDate(sourcePath);
  return {
    inventorySource: sourcePath,
    snapshotDate,
    generatedAt,
    freshnessNote: snapshotDate
      ? `PlayMCP inventory snapshot date is ${snapshotDate}. Re-check tools/list behind the Gateway before operator registration.`
      : "PlayMCP inventory snapshot date could not be inferred. Re-check tools/list behind the Gateway before operator registration.",
  };
}

export function extractSnapshotDate(sourcePath: string): string | null {
  const file = path.basename(sourcePath);
  const match = file.match(/(20\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}
