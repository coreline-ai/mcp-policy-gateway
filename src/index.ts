// Gateway entrypoint.
// stdout is reserved for the MCP JSON-RPC channel; all logs go to stderr.
import fs from "node:fs";
import { loadConfig } from "./config/load-config";
import { openDb } from "./storage/db";
import { migrate } from "./storage/migrate";
import { loadAndStorePolicy, storePolicyContent } from "./policy/policy-store";
import { PolicyEngine, type PolicyDoc } from "./policy/engine";
import { StdioTargetAdapter } from "./catalog/stdio-adapter";
import { HttpTargetAdapter } from "./catalog/http-adapter";
import { TargetAdapterRouter } from "./catalog/adapter-router";
import { TargetSessionManager } from "./targets/session-manager";
import { GatewayRuntime } from "./upstream/gateway";
import { startServer } from "./upstream/server";

const cfg = loadConfig();
const db = openDb(cfg.dbPath);

const ran = migrate(db);
if (ran.length) console.error(`[gateway] applied migrations: ${ran.join(", ")}`);

let policyDoc: PolicyDoc;
let policyVersion: string;
if (cfg.policyPath && fs.existsSync(cfg.policyPath)) {
  const loaded = loadAndStorePolicy(db, cfg, cfg.policyPath);
  policyDoc = loaded.content as PolicyDoc;
  policyVersion = loaded.version;
} else {
  policyDoc = { version: 1, default: "deny", rules: [] };
  policyVersion = storePolicyContent(db, cfg, policyDoc);
}
console.error(`[gateway] active policy version: ${policyVersion}`);

const adapter = new TargetAdapterRouter(new StdioTargetAdapter({ inheritedEnvKeys: cfg.stdioEnvKeys }), new HttpTargetAdapter(cfg.egress));
const sessions = new TargetSessionManager(db, adapter, {
  tenantId: cfg.tenantId,
  actorId: cfg.actorId,
  clientId: cfg.clientId,
  policyVersion,
});
const engine = new PolicyEngine(policyDoc);
const runtime = new GatewayRuntime(db, cfg, engine, sessions, adapter, policyVersion);

await startServer(runtime);
console.error("[gateway] ready (stdio); tenant=" + cfg.tenantId);
