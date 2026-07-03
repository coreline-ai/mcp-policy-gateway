// Operator re-review channel (privileged, like the approve CLI).
// After reviewing a target's changed/added tools, clear the pending-review flag
// so they can be exposed/called again per policy.
//   GATEWAY_DB_PATH=... npm run review -- <targetId>
import { loadConfig } from "../config/load-config";
import { openDb } from "../storage/db";
import { clearChangeReview } from "./diff";
import { recordEvent } from "../audit/audit-log";

const targetId = process.argv[2];
if (!targetId) {
  console.error("usage: review <targetId>");
  process.exit(2);
}

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const { cleared, observationId } = clearChangeReview(db, targetId);
recordEvent(db, {
  eventType: "target_reviewed",
  tenantId: cfg.tenantId,
  policyVersion: "n/a",
  targetId,
  actorId: cfg.actorId,
  reason: `cleared ${cleared} pending tool(s) on observation ${observationId ?? "none"}`,
});
console.error(`reviewed ${targetId}: cleared ${cleared} pending tool(s)`);
process.exit(0);
