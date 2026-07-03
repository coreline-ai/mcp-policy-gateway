import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb, type DB } from "../src/storage/db";
import { migrate } from "../src/storage/migrate";
import { registerTarget, getTarget, TargetRegistrationError } from "../src/targets/registry";
import {
  isPrivateIp,
  validateUrlShape,
  assertEgressAllowed,
  EgressBlockedError,
  DEFAULT_EGRESS,
  type EgressPolicy,
  type Resolver,
} from "../src/targets/egress-guard";
import { TargetAdapterRouter } from "../src/catalog/adapter-router";
import { HttpTargetAdapter } from "../src/catalog/http-adapter";
import type { TargetAdapter, TargetSession, ToolPage, TargetCallResult, TargetSpawnSpec } from "../src/catalog/target-adapter";

const policy: EgressPolicy = DEFAULT_EGRESS;

describe("isPrivateIp", () => {
  it("flags loopback / private / link-local / metadata / ULA", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  it("flags reserved, documentation, multicast, and broadcast IPs as non-global", () => {
    for (const ip of ["192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255", "2001:db8::1", "ff02::1", "::ffff:192.0.2.1", "::ffff:c000:0201"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8", "::ffff:808:808"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
});

describe("validateUrlShape (sync, registration-time)", () => {
  it("rejects non-allowed schemes", () => {
    expect(() => validateUrlShape("http://example.com/mcp", policy)).toThrow(EgressBlockedError);
    expect(() => validateUrlShape("file:///etc/passwd", policy)).toThrow(EgressBlockedError);
  });
  it("rejects literal private IP hosts", () => {
    expect(() => validateUrlShape("https://169.254.169.254/latest/meta-data", policy)).toThrow(EgressBlockedError);
    expect(() => validateUrlShape("https://127.0.0.1/mcp", policy)).toThrow(EgressBlockedError);
    expect(() => validateUrlShape("https://[::1]/mcp", policy)).toThrow(EgressBlockedError);
    expect(() => validateUrlShape("https://[::ffff:127.0.0.1]/mcp", policy)).toThrow(EgressBlockedError);
    expect(() => validateUrlShape("https://[::ffff:169.254.169.254]/latest", policy)).toThrow(EgressBlockedError);
  });
  it("accepts a public https host", () => {
    expect(validateUrlShape("https://mcp.example.com/mcp", policy).host).toBe("mcp.example.com");
  });
  it("enforces a host allowlist when configured", () => {
    const p: EgressPolicy = { allowedSchemes: ["https"], allowedHosts: ["mcp.example.com"], allowPrivate: false };
    expect(validateUrlShape("https://mcp.example.com/x", p).host).toBe("mcp.example.com");
    expect(() => validateUrlShape("https://evil.example.com/x", p)).toThrow(EgressBlockedError);
  });
  it("allows private literal hosts only when allowPrivate is explicitly enabled", () => {
    const p: EgressPolicy = { allowedSchemes: ["https"], allowPrivate: true };
    expect(validateUrlShape("https://127.0.0.1/mcp", p).host).toBe("127.0.0.1");
    expect(validateUrlShape("https://[::ffff:127.0.0.1]/mcp", p).host).toBe("::ffff:7f00:1");
  });
});

describe("assertEgressAllowed (async, DNS-rebinding defense)", () => {
  const resolvesTo = (ips: string[]): Resolver => async () => ips;

  it("blocks when the hostname resolves to a private IP", async () => {
    await expect(assertEgressAllowed("https://rebind.example.com/mcp", policy, resolvesTo(["169.254.169.254"]))).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(assertEgressAllowed("https://rebind.example.com/mcp", policy, resolvesTo(["8.8.8.8", "10.0.0.5"]))).rejects.toBeInstanceOf(EgressBlockedError);
  });
  it("allows when every resolved address is public", async () => {
    const r = await assertEgressAllowed("https://ok.example.com/mcp", policy, resolvesTo(["93.184.216.34"]));
    expect(r.addresses).toContain("93.184.216.34");
  });
  it("blocks empty DNS resolution", async () => {
    await expect(assertEgressAllowed("https://void.example.com/mcp", policy, resolvesTo([]))).rejects.toBeInstanceOf(EgressBlockedError);
  });
  it("blocks when the hostname resolves to reserved or otherwise non-global IPs", async () => {
    await expect(assertEgressAllowed("https://reserved.example.com/mcp", policy, resolvesTo(["192.0.2.1"]))).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(assertEgressAllowed("https://multicast.example.com/mcp", policy, resolvesTo(["224.0.0.1"]))).rejects.toBeInstanceOf(EgressBlockedError);
  });
  it("allows private DNS resolution only when allowPrivate is explicitly enabled", async () => {
    const p: EgressPolicy = { allowedSchemes: ["https"], allowPrivate: true };
    const r = await assertEgressAllowed("https://local-dev.example/mcp", p, resolvesTo(["127.0.0.1"]));
    expect(r.addresses).toEqual(["127.0.0.1"]);
  });
});

describe("HTTP target registration (ADR-006 / T10)", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db);
  });
  const cfg = { tenantId: "t1", egress: DEFAULT_EGRESS };

  it("rejects an http target whose endpoint is a private/metadata URL", () => {
    expect(() =>
      registerTarget(db, cfg, { name: "meta", kind: "http", endpointUrl: "https://169.254.169.254/latest" }),
    ).toThrow(TargetRegistrationError);
    expect(() =>
      registerTarget(db, cfg, { name: "plain", kind: "http", endpointUrl: "http://mcp.example.com/mcp" }),
    ).toThrow(TargetRegistrationError);
  });

  it("registers a valid https target and getTarget returns a kind:http spec", () => {
    const id = registerTarget(db, cfg, { name: "remote", kind: "http", endpointUrl: "https://mcp.example.com/mcp" });
    const t = getTarget(db, cfg, id)!;
    expect(t.kind).toBe("http");
    expect(t.spec).toEqual({ kind: "http", url: "https://mcp.example.com/mcp" });
  });

  it("rejects mixed http/stdio registration specs and never routes them by accident", () => {
    expect(() =>
      registerTarget(db, cfg, {
        name: "remote-mixed",
        kind: "http",
        endpointUrl: "https://mcp.example.com/mcp",
        command: { command: "node" },
      }),
    ).toThrow(TargetRegistrationError);

    expect(() =>
      registerTarget(db, { tenantId: "t1", executableAllowlist: [], allowUnlistedExecutables: true }, {
        name: "local-mixed",
        kind: "stdio",
        endpointUrl: "https://mcp.example.com/mcp",
        command: { command: "node" },
      }),
    ).toThrow(TargetRegistrationError);

    db.prepare(
      `insert into mcp_targets (id, tenant_id, name, target_kind, registration_source, command, endpoint_url, status, created_at, updated_at)
       values ('bad-http', 't1', 'bad', 'http', 'test', '{"command":"node"}', 'https://mcp.example.com/mcp', 'active', 'now', 'now')`,
    ).run();
    expect(getTarget(db, { tenantId: "t1" }, "bad-http")?.spec).toBeNull();
  });

  it("stdio target still yields a kind:stdio spec", () => {
    const id = registerTarget(db, { tenantId: "t1", executableAllowlist: ["node"] }, { name: "local", kind: "stdio", command: { command: "node", args: ["x.js"] } });
    const t = getTarget(db, { tenantId: "t1" }, id)!;
    expect(t.spec?.kind).toBe("stdio");
    expect(t.spec?.command).toBe("node");
  });

  it("rejects stdio env injection and legacy env-bearing rows fail closed", () => {
    expect(() =>
      registerTarget(db, { tenantId: "t1", executableAllowlist: ["node"] }, {
        name: "env-target",
        kind: "stdio",
        command: { command: "node", env: { TARGET_CALL_LOG: "/tmp/target.log" } },
      }),
    ).toThrow(TargetRegistrationError);
    const stored = db.prepare("select * from mcp_policy_events").all();
    expect(JSON.stringify(stored)).not.toContain("/tmp/target.log");

    db.prepare(
      `insert into mcp_targets (id, tenant_id, name, target_kind, registration_source, command, endpoint_url, status, created_at, updated_at)
       values ('legacy-env', 't1', 'legacy', 'stdio', 'test', '{"command":"node","env":{"TARGET_CALL_LOG":"/tmp/target.log"}}', null, 'active', 'now', 'now')`,
    ).run();
    expect(getTarget(db, { tenantId: "t1" }, "legacy-env")?.spec).toBeNull();
  });

  it("rejects unsupported target kinds and audits the rejection", () => {
    expect(() =>
      registerTarget(db, cfg, { name: "weird", kind: "ftp", endpointUrl: "ftp://example.com" }),
    ).toThrow(TargetRegistrationError);
    const ev = db.prepare("select event_type from mcp_policy_events where event_type='target_registration_rejected'").get();
    expect(ev).toBeTruthy();
  });

  it("rejects secret-looking env/args and records no raw secret in audit", () => {
    expect(() =>
      registerTarget(db, { tenantId: "t1", executableAllowlist: ["node"] }, {
        name: "secret-env",
        kind: "stdio",
        command: { command: "node", env: { API_TOKEN: "sk-ABCDEFGHIJKLMNOP1234" } },
      }),
    ).toThrow(TargetRegistrationError);
    const rows = db.prepare("select * from mcp_policy_events").all();
    expect(JSON.stringify(rows)).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
  });

  it("fails closed by default when the executable allowlist is empty", () => {
    expect(() =>
      registerTarget(db, { tenantId: "t1", executableAllowlist: [] }, {
        name: "local",
        kind: "stdio",
        command: { command: "node" },
      }),
    ).toThrow(TargetRegistrationError);
  });

  it("allows an empty executable allowlist only with the explicit dev escape hatch", () => {
    const id = registerTarget(
      db,
      { tenantId: "t1", executableAllowlist: [], allowUnlistedExecutables: true },
      { name: "dev-local", kind: "stdio", command: { command: "node" } },
    );
    expect(id).toBeTruthy();
  });

  it("audits successful target registration", () => {
    const id = registerTarget(db, { tenantId: "t1", executableAllowlist: ["node"] }, { name: "local", kind: "stdio", command: { command: "node" } });
    const ev = db.prepare("select target_id from mcp_policy_events where event_type='target_registered'").get() as
      | { target_id: string }
      | undefined;
    expect(ev?.target_id).toBe(id);
  });
});

describe("HttpTargetAdapter guarded fetch redirects", () => {
  it("validates redirect destinations and blocks redirects to metadata/private IPs", async () => {
    const adapter = new HttpTargetAdapter(DEFAULT_EGRESS);
    vi.stubGlobal("fetch", async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } }));
    await expect((adapter as unknown as { fetchWithRedirectGuard(input: string): Promise<Response> }).fetchWithRedirectGuard("https://93.184.216.34/mcp")).rejects.toBeInstanceOf(EgressBlockedError);
    vi.unstubAllGlobals();
  });
});

describe("TargetAdapterRouter dispatches by spec.kind", () => {
  class TaggedAdapter implements TargetAdapter {
    constructor(public tag: string, public opened: string[]) {}
    async open(spec: TargetSpawnSpec): Promise<TargetSession> {
      this.opened.push(this.tag);
      return { info: { name: this.tag } } as TargetSession;
    }
    async listToolsPage(): Promise<ToolPage> { return { tools: [{ name: `${this.tag}.tool` }] }; }
    async callTool(): Promise<TargetCallResult> { return { content: [{ type: "text", text: this.tag }] }; }
    async close(): Promise<void> {}
  }

  it("routes stdio and http specs to the right adapter and back", async () => {
    const opened: string[] = [];
    const router = new TargetAdapterRouter(new TaggedAdapter("stdio", opened), new TaggedAdapter("http", opened));

    const sStdio = await router.open({ kind: "stdio", command: "x" });
    const sHttp = await router.open({ kind: "http", url: "https://ok.example.com/mcp" });
    expect(opened).toEqual(["stdio", "http"]);

    expect((await router.listToolsPage(sStdio)).tools[0]!.name).toBe("stdio.tool");
    expect((await router.listToolsPage(sHttp)).tools[0]!.name).toBe("http.tool");
    expect((await router.callTool(sHttp, "t", {})).content).toEqual([{ type: "text", text: "http" }]);

    // spec with no kind defaults to the stdio adapter
    await router.open({ command: "y" });
    expect(opened).toEqual(["stdio", "http", "stdio"]);
  });
});
