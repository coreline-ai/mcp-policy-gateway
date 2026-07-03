# MCP Policy Gateway

MCP preflight and runtime policy tooling for people who want to evaluate a
target MCP before connecting it.

The current product direction has two modes:

1. **PlayMCP Hosted Preflight MCP**: a public Remote MCP surface for PlayMCP/Kakao
   registration. Users ask whether another MCP should be connected and receive
   inventory-based risk labels, decision aid, recommended Gateway policy, and
   operator handoff. This mode must not call target MCPs.
2. **Runtime Policy Gateway**: a local or managed inline MCP proxy. It sits
   between an MCP client and target MCP servers, exposes only policy-approved
   tools, enforces allow/block/approval decisions before `tools/call`, and
   records audit/evidence for each decision.

> Status: **MVP acceptance hardening evidence complete for the stdio core** —
> tools-only mediation, filtered exposure, call-time enforcement, approvals,
> output policy, snapshot diff, audit read privacy, target registration guards,
> and stdio runtime hardening are implemented and tested. HTTP target socket-IP
> pinning and full remote HTTP MCP E2E remain explicit follow-ups.
>
> PlayMCP public registration is the P1 hosted-service target. It still requires
> a new inbound Streamable HTTP server mode (`public-preflight`) and a strict
> public tool allowlist. See
> `docs/playmcp-public-hosted-preflight.md` and `docs/adr/ADR-018.md`.

## PlayMCP Hosted Preflight Direction

For PlayMCP/Kakao, the intended listing is a hosted Remote MCP named
`MCP Policy Gateway Preflight`.

```text
PlayMCP / Toolbox / Claude / ChatGPT
  -> https://<public-host>/mcp
      -> public-preflight tools
          -> PlayMCP inventory assessment
```

This is not a local PC install flow for the end user. The operator deploys the
public HTTPS MCP endpoint first, registers that endpoint in the PlayMCP developer
console, tests it as a temporary registration, then requests review.

Public PlayMCP tool surface:

- `gateway_search_playmcp` — search PlayMCP inventory candidates before connecting a target MCP.
- `gateway_preflight_mcp` — static pre-use decision aid for a PlayMCP MCP: decision, risk labels, representative risky tools, Gateway policy recommendation, and next action.
- `gateway_explain_mcp_risk` — plain-language explanation of risk labels and decision rationale.

Do not expose `gateway_call_tool`, `gateway_request_approval`,
`gateway_list_exposed_tools`, target aliases, audit, rescan, diff, or registry
tools in public PlayMCP mode. `gateway_health` should be an HTTP `/healthz`
endpoint, not an LLM-visible MCP tool.

Current P1 implementation gap: the repository currently starts the upstream
server over stdio. PlayMCP registration needs an inbound Streamable HTTP `/mcp`
endpoint, Streamable HTTP header/session/version handling, `/healthz`, hosted
abuse/privacy controls, and the `public-preflight` allowlist.

## Local Runtime Tools (current)

Default client surface (`GATEWAY_TOOL_SURFACE_MODE=client`):
- `gateway_health` — liveness/identity.
- `gateway_search_playmcp` — search PlayMCP inventory candidates before connecting a target MCP.
- `gateway_preflight_mcp` — static pre-use decision aid for a PlayMCP MCP: decision, risk labels, representative risky tools, Gateway policy recommendation, and next action.
- `gateway_explain_mcp_risk` — plain-language explanation of risk labels and decision rationale.
- `gateway_call_tool` — policy-evaluated router; enforces allow/approval/deny at call time by real tool name. On an approval-gated tool it consumes a matching approval (atomic, one-time) or returns a pending one.
- `gateway_list_exposed_tools` — current policy-filtered target aliases exposed upstream.
- `gateway_request_approval` — create a pending approval bound to the exact call (JCS args hash + policy/observation/schema/rewrite hash) with a short TTL.

Trusted operator surface (`GATEWAY_TOOL_SURFACE_MODE=operator`) additionally exposes:
- `gateway_list_targets` — registered targets (tenant-scoped).
- `gateway_rescan_target` — observe a target's `tools/list` (all pages) and store a fresh snapshot.
- `gateway_inspect_target` — latest snapshot: tools, completeness, callability (fail-closed if incomplete/stale).
- `gateway_diff_target` — diff two snapshots (added/removed/schema-changed tools).
- `gateway_get_audit_event` — minimal, tenant-scoped, redacted metadata for one audit event: decision/rule id, HMAC hashes, policy-version availability, and no raw arguments/results (records an `audit_event_read`).

Operators grant/reject a pending approval out of band:

```bash
GATEWAY_DB_PATH=... npm run approve -- <approvalId>          # grant
GATEWAY_DB_PATH=... npm run approve -- reject <approvalId>   # reject
```

## Guarantees and limits

- Allowed tool results pass an **output policy** before return: best-effort redaction of
  known secret patterns, a resource-link scheme allowlist, and embedded-resource block.
  This is **not** a complete DLP guarantee (ADR-010).
- A rescan that changes a tool's schema marks it **pending re-review** — it is neither
  exposed nor callable until re-reviewed (fail-closed, ADR-008).
- Audit events store only hashes + redacted metadata; raw arguments/results are never
  persisted by default. Audit reads are tenant-scoped and return HMAC evidence plus
  redacted metadata, not raw payloads (ADR-005, ADR-014).

Plus **policy-filtered target aliases** exposed as real MCP tools (`<target_slug>__<tool_slug>`),
e.g. an allowed read-only tool, or a limited alias that forces a preview/dry-run mode.
Only allowed tools and aliases appear in `tools/list`; hidden/denied tools are never exposed
and are blocked at call time even if invoked by real name (list filtering is not the control).

Try it in trusted operator mode: `GATEWAY_TOOL_SURFACE_MODE=operator GATEWAY_POLICY_PATH=examples/policies/local-dev.yaml` with the
`risky-actions-mcp` sample target (`npm run start:target:risky`).

Target registration is a privileged operation; set `GATEWAY_EXEC_ALLOWLIST` (comma-separated
executables) for stdio targets (ADR-012). An empty allowlist fails closed unless
`GATEWAY_DEV_MODE=true` or `GATEWAY_ALLOW_UNLISTED_EXECUTABLES=true` is set for local development.
The MVP registry rejects raw stdio `env` values, and target processes inherit only
`GATEWAY_STDIO_ENV_KEYS` (default: `PATH,SystemRoot,WINDIR,ComSpec`) plus explicit adapter-provided env.
Use a later env-profile/secret-store integration for production target credentials.

## Hosted User Flow

For the PlayMCP/Kakao path, the user starts after the hosted MCP has already
been registered by an operator:

1. The user opens PlayMCP, Toolbox, Claude, ChatGPT, or another client connected
   through PlayMCP.
2. The user selects `MCP Policy Gateway Preflight`.
3. The user asks:

```text
카카오맵 MCP 연결해도 돼?
```

4. The response returns a static decision aid, risk labels, representative risky
   tools, recommended policy, and next action.
5. The user decides whether to connect the target MCP, request approval, or send
   the handoff to an operator.

This hosted preflight flow does not install target MCPs, call target MCP tools,
or provide runtime enforcement. Runtime enforcement begins only when a target is
placed behind a managed Gateway deployment.

## Local Prompt Window Preflight

For local development, the starting point can still be the prompt window in
Claude, Codex CLI, or a desktop MCP client. Register **this Gateway MCP** in the
client first, then ask about a target MCP before adding that target directly.

### First 5 Minutes

1. Install dependencies:

```bash
npm install
```

2. Generate the MCP client config for your app:

```bash
npm run config:client -- claude-desktop
npm run config:client -- codex-cli
npm run config:client -- generic-json
```

3. Add only `mcp-policy-gateway` to the MCP client config. Do not add the target
MCP directly to the client.

4. Validate the active MCP client config before use:

```bash
npm run config:validate -- claude-desktop /path/to/claude_desktop_config.json
npm run config:validate -- codex-cli /path/to/codex-config.toml
npm run config:validate -- generic-json /path/to/mcp-config.json
```

This is a local drift check: it confirms the config currently lists only
`mcp-policy-gateway`. It is not an OS/MDM-level lock.

5. Restart the MCP client and ask from the prompt window:

```text
카카오맵 MCP 연결해도 돼?
```

6. Send the returned `operatorHandoffStructured` to the operator or use it as a
self-review checklist before any target registration behind the Gateway.

Local protocol smoke:

```bash
npm run smoke:mcp-client-preflight
```

This starts the Gateway as an MCP stdio server, lists the tools through the MCP
SDK client, and calls `gateway_preflight_mcp` through the real protocol path.

### Config Examples

Claude Desktop style:

```json
{
  "mcpServers": {
    "mcp-policy-gateway": {
      "command": "/path/to/mcp-policy-gateway/node_modules/.bin/tsx",
      "args": ["/path/to/mcp-policy-gateway/src/index.ts"],
      "env": {
        "GATEWAY_TOOL_SURFACE_MODE": "client",
        "GATEWAY_HMAC_SECRET": "REPLACE_WITH_LOCAL_HMAC_SECRET",
        "PLAYMCP_INVENTORY_CSV": "/path/to/playmcp_inventory_20260625.csv"
      }
    }
  }
}
```

Codex CLI style:

```toml
[mcp_servers.mcp-policy-gateway]
command = "/path/to/mcp-policy-gateway/node_modules/.bin/tsx"
args = ["/path/to/mcp-policy-gateway/src/index.ts"]

[mcp_servers.mcp-policy-gateway.env]
GATEWAY_TOOL_SURFACE_MODE = "client"
GATEWAY_HMAC_SECRET = "REPLACE_WITH_LOCAL_HMAC_SECRET"
PLAYMCP_INVENTORY_CSV = "/path/to/playmcp_inventory_20260625.csv"
```

Generic stdio JSON clients can use the same JSON shape generated by:

```bash
npm run config:client -- generic-json
```

Example prompts:

- `카카오맵 MCP 연결해도 돼?`
- `카카오톡 선물하기 MCP는 어떤 승인이 필요해?`
- `컴퓨터 사용 MCP는 왜 차단 후보야?`

The client can call:

- `gateway_search_playmcp` when the MCP name is vague.
- `gateway_preflight_mcp` when the user wants a decision aid for one MCP.
- `gateway_explain_mcp_risk` when the user asks why a label or decision was assigned.

The answer is a PlayMCP inventory based static pre-use assessment. It includes a
decision such as `usable`, `usable_with_approval`, `manual_review`,
`not_recommended`, or `blocked`, plus risk labels, representative risky tools,
Gateway policy recommendation, and an operator handoff string.
The structured result also includes `operatorHandoffStructured` for operator
review queues or a self-review checklist.

Do not register the target MCP directly in the client if you want Gateway
protection. A target should be registered behind the Gateway by an operator or
managed config, then exposed through filtered aliases and call-time policy.

### Downstream HTTP (Streamable HTTP) targets

`kind: "http"` targets are a guarded post-MVP surface behind an SSRF egress guard (ADR-017):
`https` only by default, redirect destinations are re-validated before following, and every
connection + request is blocked from resolving to loopback/private/link-local/metadata IPs
(DNS-rebinding re-validated per request). Configure via:

```bash
GATEWAY_EGRESS_SCHEMES=https                 # allowed URL schemes (default: https)
GATEWAY_EGRESS_HOSTS=mcp.example.com         # optional host allowlist (default: any public host)
GATEWAY_EGRESS_ALLOW_PRIVATE=true            # local dev ONLY — permit private/loopback egress
```

Residual HTTP risks are tracked explicitly: true socket-IP pinning requires a later transport
hook (for example an undici Agent lookup hook), and full remote HTTP MCP end-to-end testing
requires a real remote MCP server.

## Why

LLM clients should not see or call every target MCP tool by default. The gateway
reduces the exposed tool surface, enforces policy at call time (not just in the
tool list), and keeps an audit trail of who decided what and why.

## Quickstart (dev)

```bash
npm install
npm run typecheck
npm test                     # unit + integration tests
npm run --silent config:client -- claude-desktop > /tmp/mcp-policy-gateway-claude.json
npm run config:validate -- claude-desktop /tmp/mcp-policy-gateway-claude.json
npm run smoke:preuse         # local pre-use Gateway -> target MCP smoke
npm run smoke:mcp-client-preflight  # MCP SDK client -> Gateway preflight smoke
npm run assessment:playmcp   # PlayMCP inventory static assessment + HTML/JSON report
npm run demo:mvp             # local MVP smoke walk (register -> filter -> block -> approve -> redact -> diff -> audit)
npm run verify:mvp           # full local MVP verification gate
npm run migrate              # apply SQLite migrations
GATEWAY_POLICY_PATH=examples/policies/default-deny.yaml npm start   # start client-surface gateway over stdio
```

Sample targets: `npm run start:target:safe` (read-only), `npm run start:target:risky` (mutation/destructive).
Run `npm run demo:mvp` first — it prints each gateway decision step by step.

## Verification And Release Notes

Release hygiene commands:

```bash
npm run verify:mvp
```

Equivalent expanded gate:

```bash
npm run typecheck
npm test
npm run smoke:preuse
npm run smoke:mcp-client-preflight
npm run assessment:playmcp
npm run demo:mvp
npm audit --omit=dev
```

Use `.env.example` as the non-secret configuration template. There is no project
license file yet; add an explicit license before public redistribution. Known
follow-up risks remain tracked in ADR-017: true socket-IP pinning for HTTP targets
and full remote HTTP MCP E2E against a real remote server.

## MVP Identity

The stdio MVP uses one configured principal for tenant/client/actor identity
(`GATEWAY_TENANT_ID`, etc.). Per-user approval and team enforcement require an
authenticated transport or managed deployment — see `docs/adr/ADR-011.md`.

## Deployment Rule

Register **only** the gateway in the MCP client, and keep target MCP
endpoints/processes/credentials behind the gateway. Strong enforcement claims hold
only when the client cannot register targets directly (managed config / MDM /
workspace policy). Target registration is a privileged operator action
(`docs/adr/ADR-012.md`).

Deployment modes:

| Mode | What it means | Claim boundary |
|---|---|---|
| `self-managed` | User follows docs and config examples manually. | Direct target registration can still bypass the Gateway. |
| `validated-local` | `npm run config:validate -- <target> <config-path>` checks the current config for Gateway-only registration. | Detects config drift; does not lock the OS or client. |
| `managed-enforced` | Organization deploys read-only/managed client config through MDM, GPO, workspace policy, or equivalent controls. | Strong Gateway-only enforcement claims are scoped to this deployment condition. |

See `docs/deployment-managed-client.md` for the operator checklist.

## Non-Goals

- Not a global MCP firewall.
- Not complete malicious-MCP detection.
- Not a sandbox.
- Not a paywall / API / rate-limit / anti-bot bypass tool.

Output redaction is best-effort, never a complete DLP guarantee.

## Tool names

All exposed tool names use `[a-z0-9_]` only (no dots): admin tools are `gateway_*`
(e.g. `gateway_list_targets`); target aliases use `<target_slug>__<tool_slug>`.
This keeps names valid after a client namespaces them as `mcp__<server>__<tool>`
(`docs/adr/ADR-016.md`).

## Layout

```
src/            gateway source (config, storage, policy, targets, upstream)
sample-targets/ in-memory fake target MCPs (safe-notes-mcp)
examples/       example policy YAML
test/           vitest unit tests
docs/adr/       architecture decision records
handoff/   design handoff pack (authoritative)
```
