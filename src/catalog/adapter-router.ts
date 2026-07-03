// Routes a target session to the right adapter by spec.kind, so the session
// manager and observer keep using a single TargetAdapter regardless of kind.
import type { TargetAdapter, TargetRuntimeEvent, TargetSession, TargetSpawnSpec, ToolPage, TargetCallResult } from "./target-adapter";

export class TargetAdapterRouter implements TargetAdapter {
  private owner = new WeakMap<TargetSession, TargetAdapter>();

  constructor(
    private stdio: TargetAdapter,
    private http: TargetAdapter,
  ) {}

  async open(
    spec: TargetSpawnSpec,
    onListChanged?: () => void,
    onRuntimeEvent?: (event: TargetRuntimeEvent) => void,
  ): Promise<TargetSession> {
    const adapter = spec.kind === "http" ? this.http : this.stdio;
    const session = await adapter.open(spec, onListChanged, onRuntimeEvent);
    this.owner.set(session, adapter);
    return session;
  }

  listToolsPage(session: TargetSession, cursor?: string): Promise<ToolPage> {
    return this.ownerOf(session).listToolsPage(session, cursor);
  }

  callTool(session: TargetSession, name: string, args: Record<string, unknown>): Promise<TargetCallResult> {
    return this.ownerOf(session).callTool(session, name, args);
  }

  close(session: TargetSession): Promise<void> {
    return this.ownerOf(session).close(session);
  }

  private ownerOf(session: TargetSession): TargetAdapter {
    const a = this.owner.get(session);
    if (!a) throw new Error("session not opened by this router");
    return a;
  }
}
