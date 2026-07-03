// Operator approval channel (R2 / Q4): grant or reject a pending approval.
// Usage:
//   GATEWAY_DB_PATH=... npm run approve -- <approvalId>          # grant
//   GATEWAY_DB_PATH=... npm run approve -- reject <approvalId>   # reject
import { loadConfig } from "../config/load-config";
import { openDb } from "../storage/db";
import { grantApproval, rejectApproval } from "./approval-store";

const argv = process.argv.slice(2);
const reject = argv[0] === "reject";
const approvalId = reject ? argv[1] : argv[0];

if (!approvalId) {
  console.error("usage: approve [reject] <approvalId>");
  process.exit(2);
}

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const ok = reject
  ? rejectApproval(db, cfg.tenantId, approvalId, { actorId: cfg.actorId, clientId: cfg.clientId })
  : grantApproval(db, cfg.tenantId, approvalId, { actorId: cfg.actorId, clientId: cfg.clientId });

if (ok) {
  console.error(`${reject ? "rejected" : "approved"}: ${approvalId}`);
  process.exit(0);
} else {
  console.error(`no pending approval to ${reject ? "reject" : "approve"} (id=${approvalId}, tenant=${cfg.tenantId})`);
  process.exit(1);
}
