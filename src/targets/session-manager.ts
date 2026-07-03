// Long-lived target session manager (R1: one live session per target).
// Lazily opens a session on first use, subscribes to tools/list_changed to mark
// the catalog stale (fail-closed until rescan), and forwards tools/call.
import type { DB } from "../storage/db";
import type { TargetAdapter, TargetCallResult, TargetRuntimeEvent, TargetSession, TargetSpawnSpec } from "../catalog/target-adapter";
import { markListChanged } from "../catalog/snapshot";
import { recordEvent } from "../audit/audit-log";

export class TargetCallPreflightBlocked extends Error {}

export class TargetSessionManager {
  private sessions = new Map<string, TargetSession>();

  constructor(
    private db: DB,
    private adapter: TargetAdapter,
    private auditScope?: { tenantId: string; actorId?: string; clientId?: string; policyVersion?: string },
  ) {}

  async callTool(
    target: { id: string; spec: TargetSpawnSpec },
    toolName: string,
    args: Record<string, unknown>,
    beforeForward?: () => void | Promise<void>,
  ): Promise<TargetCallResult> {
    let session = this.sessions.get(target.id);
    if (!session) {
      session = await this.adapter.open(
        target.spec,
        () => markListChanged(this.db, target.id),
        (event) => this.auditRuntimeEvent(target.id, event),
      );
      this.sessions.set(target.id, session);
    }
    await beforeForward?.();
    try {
      return await this.adapter.callTool(session, toolName, args);
    } catch (err) {
      this.sessions.delete(target.id);
      try {
        await this.adapter.close(session);
      } catch {
        /* best-effort cleanup after failed call */
      }
      throw err;
    }
  }

  async closeAll(): Promise<void> {
    for (const [id, session] of this.sessions) {
      try {
        await this.adapter.close(session);
      } catch {
        /* best-effort */
      }
      this.sessions.delete(id);
    }
  }

  private auditRuntimeEvent(targetId: string, event: TargetRuntimeEvent): void {
    recordEvent(this.db, {
      eventType: event.type === "stdio_transport_error" ? "target_transport_error" : "unsupported_reverse_capability",
      tenantId: this.auditScope?.tenantId ?? "runtime",
      policyVersion: this.auditScope?.policyVersion ?? "runtime",
      targetId,
      actorId: this.auditScope?.actorId,
      clientId: this.auditScope?.clientId,
      decision: event.type === "stdio_transport_error" ? "error" : "block",
      reason: event.type === "stdio_transport_error" ? event.reason : event.method,
      auditMetadata: event,
    });
  }
}
