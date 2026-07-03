// Capability catalog: observe a target's tools/list (all pages), normalize,
// hash, and persist an observation + per-tool snapshot rows.
//
// ADR-008: a snapshot is only `complete` when every page was collected. An
// incomplete snapshot (pagination not finished, or an error mid-collection) and
// a snapshot invalidated by tools/list_changed are NOT callable — fail-closed.
import crypto from "node:crypto";
import type { DB } from "../storage/db";
import type { TargetAdapter, TargetSpawnSpec, RawTool } from "./target-adapter";
import { normalizeTools, observationHash, toolHashes } from "./normalize";

export type Completeness = "complete" | "incomplete";

export interface ObserveResult {
  observationId: string;
  completeness: Completeness;
  toolCount: number;
  normalizedHash: string;
}

export interface ObservationRow {
  id: string;
  target_id: string;
  observed_at: string;
  normalized_hash: string;
  completeness_status: string;
  list_changed_at: string | null;
  server_name: string | null;
  server_version: string | null;
}

export async function observeTarget(
  db: DB,
  cfg: { tenantId: string; hmacSecret: string },
  target: { id: string; spec: TargetSpawnSpec },
  adapter: TargetAdapter,
  opts: { maxPages?: number } = {},
): Promise<ObserveResult> {
  const maxPages = opts.maxPages ?? 100;
  const raw: RawTool[] = [];
  let completeness: Completeness = "incomplete";
  let info: { name?: string; version?: string } | undefined;
  let session;

  try {
    session = await adapter.open(target.spec);
    info = session.info;
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await adapter.listToolsPage(session, cursor);
      raw.push(...res.tools);
      if (!res.nextCursor) {
        completeness = "complete";
        break;
      }
      cursor = res.nextCursor;
    }
  } catch (err) {
    completeness = "incomplete";
    console.error(`[catalog] observation error for target ${target.id}: ${String(err)}`);
  } finally {
    if (session) {
      try {
        await adapter.close(session);
      } catch {
        /* best-effort close */
      }
    }
  }

  const normalized = normalizeTools(raw);
  const normalizedHash = observationHash(cfg.hmacSecret, cfg.tenantId, normalized);
  const observationId = crypto.randomUUID();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `insert into mcp_observations
         (id, target_id, observed_at, source_kind, server_name, server_version, normalized_hash, completeness_status, status)
       values (@id, @target, @now, 'tools/list', @sn, @sv, @hash, @comp, 'observed')`,
    ).run({
      id: observationId,
      target: target.id,
      now,
      sn: info?.name ?? null,
      sv: info?.version ?? null,
      hash: normalizedHash,
      comp: completeness,
    });
    const ins = db.prepare(
      `insert into mcp_tool_snapshots
         (id, observation_id, tool_name, description_hash, input_schema_hash, output_schema_hash, exposure_status, tool_json)
       values (@id, @obs, @name, @dh, @ih, @oh, 'hidden', @json)`,
    );
    for (const t of normalized) {
      const h = toolHashes(cfg.hmacSecret, cfg.tenantId, t);
      ins.run({
        id: crypto.randomUUID(),
        obs: observationId,
        name: t.name,
        dh: h.descriptionHash,
        ih: h.inputSchemaHash,
        oh: h.outputSchemaHash,
        json: JSON.stringify(t),
      });
    }
  });
  tx();

  return { observationId, completeness, toolCount: normalized.length, normalizedHash };
}

export function getLatestObservation(db: DB, targetId: string): ObservationRow | undefined {
  return db
    .prepare(
      `select id, target_id, observed_at, normalized_hash, completeness_status, list_changed_at, server_name, server_version
         from mcp_observations where target_id = ? order by rowid desc limit 1`,
    )
    .get(targetId) as ObservationRow | undefined;
}

export interface SnapshotToolRow {
  tool_name: string;
  exposure_status: string;
  input_schema_hash: string | null;
  output_schema_hash: string | null;
}

export function getSnapshotTools(db: DB, observationId: string): SnapshotToolRow[] {
  return db
    .prepare(
      `select tool_name, exposure_status, input_schema_hash, output_schema_hash
         from mcp_tool_snapshots where observation_id = ? order by tool_name`,
    )
    .all(observationId) as SnapshotToolRow[];
}

export interface SnapshotFullTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

/** Full normalized tools from a snapshot (parsed tool_json) — for exposure/list building. */
export function getSnapshotToolsFull(db: DB, observationId: string): SnapshotFullTool[] {
  const rows = db
    .prepare(`select tool_json from mcp_tool_snapshots where observation_id = ? order by tool_name`)
    .all(observationId) as { tool_json: string }[];
  return rows.map((r) => {
    const t = JSON.parse(r.tool_json) as SnapshotFullTool;
    return { name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema };
  });
}

/** ADR-008: mark the target's latest snapshot stale on tools/list_changed. */
export function markListChanged(db: DB, targetId: string): void {
  db.prepare(
    `update mcp_observations set list_changed_at = ?
       where id = (select id from mcp_observations where target_id = ? order by rowid desc limit 1)`,
  ).run(new Date().toISOString(), targetId);
}

/** Fail-closed: callable only when the latest snapshot is complete and not stale. */
export function snapshotCallable(obs: ObservationRow | undefined): boolean {
  return !!obs && obs.completeness_status === "complete" && !obs.list_changed_at;
}
