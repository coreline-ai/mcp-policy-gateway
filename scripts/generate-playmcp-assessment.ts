import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PLAYMCP_INVENTORY_PATH, loadPlayMcpInventory } from "../src/assessment/inventory-loader";
import { buildAssessmentReport } from "../src/assessment/report-model";
import { renderAssessmentHtml } from "../src/assessment/html-report";
import { runPreUseLiveSmoke } from "../src/assessment/preuse-live-smoke";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = process.argv[2] ?? process.env.PLAYMCP_INVENTORY_CSV ?? DEFAULT_PLAYMCP_INVENTORY_PATH;
const outDir = process.argv[3] ?? path.join(ROOT, "reports");
const timestamp = timestampForFilename(new Date());

fs.mkdirSync(outDir, { recursive: true });

const rows = loadPlayMcpInventory(sourcePath);
const liveSmoke = process.env.PLAYMCP_SKIP_LIVE_SMOKE === "true" ? undefined : await runPreUseLiveSmoke({ rootDir: ROOT });
const report = buildAssessmentReport(rows, sourcePath, new Date().toISOString(), liveSmoke);
const html = renderAssessmentHtml(report);

const jsonPath = path.join(outDir, `playmcp_assessment_${timestamp}.json`);
const htmlPath = path.join(outDir, `playmcp_assessment_report_${timestamp}.html`);

fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
fs.writeFileSync(htmlPath, html, "utf8");

console.log(`PlayMCP assessment complete: ${report.summary.total} MCPs`);
console.log(`HTML: ${htmlPath}`);
console.log(`JSON: ${jsonPath}`);
console.log(`Decisions: ${JSON.stringify(report.summary.decisions)}`);
console.log(`High-risk default allow violations: ${report.summary.highRiskDefaultAllowCount}`);
if (liveSmoke) console.log(`Pre-use live smoke: ${liveSmoke.status}`);

function timestampForFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}
