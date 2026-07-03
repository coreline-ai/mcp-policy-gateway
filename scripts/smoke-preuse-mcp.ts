import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPreUseLiveSmoke } from "../src/assessment/preuse-live-smoke";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] ?? path.join(ROOT, "reports");
fs.mkdirSync(outDir, { recursive: true });

const result = await runPreUseLiveSmoke({ rootDir: ROOT });
const outPath = path.join(outDir, `preuse_live_smoke_${timestampForFilename(new Date())}.json`);
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

console.log(`Pre-use live smoke: ${result.status}`);
console.log(`Target: ${result.targetName} (${result.targetKind})`);
console.log(`Snapshot: ${result.completeness}, tools=${result.toolCount}`);
console.log(`Denied forwarding count: ${result.deniedForwardingCount}`);
console.log(`Output: ${outPath}`);

process.exit(result.status === "PASS" ? 0 : 1);

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
