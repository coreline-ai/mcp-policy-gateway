// Capability diff + changed-tool default-deny (ADR-008 / T11 / T12).
// After a rescan, added or schema-changed tools are marked
// `changed_pending_review` on the new snapshot so they are neither exposed nor
// callable until an operator re-reviews (fail-closed).
import type { DB } from "../storage/db";

export const CHANGED_PENDING = "changed_pending_review";

export interface ToolChange {
  tool: string;
  change: "added" | "removed" | "input_schema_changed" | "output_schema_changed";
}

export interface ToolDiff {
  added: string[];
  removed: string[];
  changed: ToolChange[];
}

interface Row {
  tool_name: string;
  input_schema_hash: string | null;
  output_schema_hash: string | null;
}

function toolMap(db: DB, observationId: string): Map<string, { input: string | null; output: string | null }> {
  const rows = db
    .prepare(`select tool_name, input_schema_hash, output_schema_hash from mcp_tool_snapshots where observation_id = ?`)
    .all(observationId) as Row[];
  return new Map(rows.map((r) => [r.tool_name, { input: r.input_schema_hash, output: r.output_schema_hash }]));
}

export function diffObservations(db: DB, fromObservationId: string, toObservationId: string): ToolDiff {
  const prev = toolMap(db, fromObservationId);
  const curr = toolMap(db, toObservationId);
  const diff: ToolDiff = { added: [], removed: [], changed: [] };

  for (const [name, hash] of curr) {
    if (!prev.has(name)) diff.added.push(name);
    else {
      const old = prev.get(name)!;
      if (old.input !== hash.input) diff.changed.push({ tool: name, change: "input_schema_changed" });
      else if (old.output !== hash.output) diff.changed.push({ tool: name, change: "output_schema_changed" });
    }
  }
  for (const name of prev.keys()) {
    if (!curr.has(name)) diff.removed.push(name);
  }
  return diff;
}

/** Latest complete observation for a target, excluding a given id. */
export function previousCompleteObservation(db: DB, targetId: string, excludeId: string): string | undefined {
  const row = db
    .prepare(
      `select id from mcp_observations
        where target_id = ? and completeness_status = 'complete' and id != ?
        order by rowid desc limit 1`,
    )
    .get(targetId, excludeId) as { id: string } | undefined;
  return row?.id;
}

/**
 * Compare a fresh observation to the previous complete one and mark added /
 * schema-changed tools as pending review on the new snapshot. Returns the diff.
 */
export function applyChangeReview(db: DB, targetId: string, newObservationId: string): ToolDiff {
  const prevId = previousCompleteObservation(db, targetId, newObservationId);
  if (!prevId) return { added: [], removed: [], changed: [] }; // first snapshot: nothing to review

  const diff = diffObservations(db, prevId, newObservationId);
  const mark = db.prepare(
    `update mcp_tool_snapshots set exposure_status = '${CHANGED_PENDING}'
       where observation_id = @obs and tool_name = @tool`,
  );
  const tx = db.transaction(() => {
    for (const t of diff.added) mark.run({ obs: newObservationId, tool: t });
    for (const c of diff.changed) mark.run({ obs: newObservationId, tool: c.tool });
  });
  tx();
  return diff;
}

/**
 * Operator re-review: clear `changed_pending_review` on the target's latest
 * snapshot so the reviewed tools become eligible for exposure per policy again.
 * Privileged action (see review-cli). Returns how many tool rows were cleared.
 */
export function clearChangeReview(db: DB, targetId: string): { cleared: number; observationId?: string } {
  const latest = db
    .prepare(`select id from mcp_observations where target_id = ? order by rowid desc limit 1`)
    .get(targetId) as { id: string } | undefined;
  if (!latest) return { cleared: 0 };
  const info = db
    .prepare(`update mcp_tool_snapshots set exposure_status = 'hidden' where observation_id = ? and exposure_status = ?`)
    .run(latest.id, CHANGED_PENDING);
  return { cleared: info.changes, observationId: latest.id };
}
