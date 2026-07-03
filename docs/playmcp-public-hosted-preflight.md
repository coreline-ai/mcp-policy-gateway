# PlayMCP Public Hosted Preflight

This document defines how `mcp-policy-gateway` should be positioned and
registered when the goal is PlayMCP/Kakao public usage.

## Purpose

The PlayMCP-facing product mode is **Hosted Preflight MCP**.

In this mode, the service is a public Remote MCP server that helps a user decide
whether another MCP should be connected. It uses PlayMCP inventory data, risk
labels, deterministic decision mapping, and operator handoff text. It does not
call the target MCP, register target MCPs for the user, or claim that a target
MCP is safe.

```text
PlayMCP / Toolbox / External AI client
  -> https://<public-host>/mcp
      -> public-preflight MCP surface
          -> PlayMCP inventory snapshot + risk classifier + decision mapper
```

The existing runtime gateway remains valuable for managed environments, but it
is a different deployment mode:

```text
Managed MCP client
  -> Runtime Policy Gateway
      -> Target MCP Server
```

## PlayMCP Registration Flow

Public registration requires an externally reachable Remote MCP endpoint.
Current public Kakao/PlayMCP material supports the following registration shape.
Treat the live PlayMCP guide and review policy as the final source for UI names,
review criteria, and visibility transitions.

1. Build and expose a Remote MCP server endpoint, usually `/mcp`.
2. Log in to PlayMCP and open the developer console:
   `https://playmcp.kakao.com/console`.
3. Start a new MCP server registration and enter the endpoint.
4. Use the console's information-load step so PlayMCP can inspect `tools/list`.
5. Save as a temporary or private registration while testing, if that option is
   available in the current console.
6. Test tool selection, argument binding, and tool call responses in PlayMCP AI
   Chat.
7. When ready, request review.
8. Follow the current review result and visibility controls before public
   listing.

References:

- PlayMCP llms.txt: `https://playmcp.kakao.com/llms.txt`
- Kakao Tech PlayMCP implementation guide:
  `https://tech.kakao.com/posts/734`
- PlayMCP registration event guide:
  `https://b.kakao.com/views/PlayMCP/AGENTIC_PlAYER_10`
- Toolbox and external client flow:
  `https://www.kakaocorp.com/page/detail/11817`

## Public Tool Surface

PlayMCP public registration must expose only decision-support tools:

| Tool | Public? | Reason |
|---|---:|---|
| `gateway_search_playmcp` | Yes | Find candidate MCPs from the PlayMCP inventory. |
| `gateway_preflight_mcp` | Yes | Return decision aid, risk labels, representative risky tools, policy recommendation, and handoff. |
| `gateway_explain_mcp_risk` | Yes | Explain labels and decision rationale in plain language. |
| `gateway_health` | No | Operational health belongs at HTTP `/healthz`, not as an LLM-visible tool. |
| `gateway_call_tool` | No | Calls real target tools; not part of preflight-only public mode. |
| `gateway_list_exposed_tools` | No | Reveals runtime target alias surface. |
| `gateway_request_approval` | No | Creates approval state; public usage can cause spam/confused-deputy risk. |
| Operator/audit/rescan/diff tools | No | Trusted operator-only surface. |
| Dynamic target aliases | No | Public preflight mode is not a target proxy. |

## Endpoint Contract

The hosted mode needs an inbound Streamable HTTP server. This is separate from
ADR-017, which is about outbound HTTP targets.

Required contract:

- `/mcp` is the single MCP endpoint for both POST and GET.
- `POST /mcp` accepts one MCP JSON-RPC message per HTTP request.
- POST requests include `Accept: application/json, text/event-stream`.
- JSON-RPC requests return either `Content-Type: application/json` with one
  JSON-RPC response or `Content-Type: text/event-stream` with an SSE stream that
  eventually contains the response.
- JSON-RPC notifications or responses accepted by the server return `202
  Accepted` with no response body.
- `GET /mcp` either opens an SSE stream when server-to-client streaming is
  supported or returns `405 Method Not Allowed` when it is not supported.
- `DELETE /mcp` returns `405 Method Not Allowed` while the public preflight
  server remains stateless.
- The server does not issue `Mcp-Session-Id` by default. If a future
  implementation issues one, all subsequent requests must validate it and
  missing/expired sessions must fail closed according to the MCP transport spec.
- The server handles `MCP-Protocol-Version`; invalid or unsupported values return
  `400 Bad Request`.
- `tools/list` returns exactly the public preflight tools.
- `tools/call` supports only the public preflight tools.
- Calls to runtime/operator tools fail closed or return unknown-tool errors.
- `/healthz` provides operational liveness without tenant or private metadata.
- The server validates `Origin` when present and rejects disallowed origins.
- The server enforces body-size and query-length limits.
- The service is HTTPS-terminated before PlayMCP registration.

Configuration names to reserve:

| Variable | Purpose |
|---|---|
| `GATEWAY_UPSTREAM_TRANSPORT=stdio|streamable-http` | Select local stdio or hosted HTTP inbound transport. |
| `GATEWAY_PUBLIC_MODE=public-preflight` | Select preflight-only public surface. |
| `GATEWAY_HOST` / `GATEWAY_PORT` | HTTP bind address and port. |
| `GATEWAY_MCP_PATH=/mcp` | MCP endpoint path. |
| `GATEWAY_HEALTH_PATH=/healthz` | Liveness endpoint path. |
| `GATEWAY_PUBLIC_BASE_URL` | Registration URL base. |
| `GATEWAY_ALLOWED_ORIGINS` | Optional origin allowlist. |
| `GATEWAY_MAX_BODY_BYTES` | Maximum MCP request body size. |
| `GATEWAY_MAX_QUERY_CHARS` | Maximum free-text query length accepted by preflight tools. |
| `GATEWAY_RATE_LIMIT_WINDOW_MS` / `GATEWAY_RATE_LIMIT_MAX` | Basic hosted abuse throttle. |

## User Workflow

The non-technical user does not install this repository. The operator deploys
and registers the hosted MCP first. Then the user follows this flow:

1. Open PlayMCP or an external AI client connected through PlayMCP Toolbox.
2. Add or select `MCP Policy Gateway Preflight`.
3. Ask a natural question:

```text
카카오맵 MCP 연결해도 돼?
```

4. Receive a decision such as `usable`, `usable_with_approval`,
   `manual_review`, `not_recommended`, or `blocked`.
5. Read the risk labels, representative risky tools, and recommended next
   action.
6. If the result asks for manual review, send the handoff text to an operator or
   wait for updated inventory/review.
7. Connect the target MCP only after the user or operator accepts the
   recommendation. The hosted preflight server does not connect it on behalf of
   the user.

## PlayMCP Registration Metadata

Recommended name:

```text
MCP Policy Gateway Preflight
```

Recommended short description:

```text
Connect-before-use decision aid for MCPs. It checks PlayMCP inventory metadata,
labels tool-surface risk, and recommends whether to use, approve, review, avoid,
or block a candidate MCP.
```

Recommended Korean description:

```text
다른 MCP를 연결하기 전에 PlayMCP inventory 기반으로 tool surface, risk label,
사용 가능 여부 판단 지원, Gateway 정책 권장안, 운영자 handoff를 제공하는
정적 사전검증 MCP입니다. target MCP를 자동 실행하거나 완전한 안전을 주장하지
않습니다.
```

Starter prompts:

- `카카오맵 MCP 연결해도 돼?`
- `카카오톡 선물하기 MCP는 어떤 승인이 필요해?`
- `멜론 MCP의 위험 라벨을 설명해줘.`
- `톡캘린더 MCP를 쓰기 전에 무엇을 확인해야 해?`
- `처음 보는 MCP URL과 tool 목록이 있는데 수동 검토 기준을 알려줘.`

## Privacy And Claim Boundary

Public hosted mode may receive user queries, candidate MCP names, package/homepage
URLs, declared tool names, and reason-for-use text.

Default hosted data policy:

| Data | Default handling |
|---|---|
| Raw user query, `reasonForUse`, declared tool names | Process in memory for the response; do not persist by default. |
| Candidate id/name, decision, labels, status, response code | Store as minimal abuse/product-quality metadata for up to 30 days. |
| Raw credentials, access tokens, private target endpoints | Do not store. Reject or redact when detected. |
| Error logs | Store redacted stack/category only; do not include raw prompts or credentials. |
| Generated reports | Contain inventory metadata and decisions, not user prompts or secrets. |

Before public listing, publish an operator contact for deletion/security requests
and document the actual retention window used by the hosted deployment.

Do not claim:

- Kakao or PlayMCP endorsement beyond successful listing/review status.
- all PlayMCP MCPs are safe to connect.
- live behavior of a remote MCP has been fully verified.
- per-user/team enforcement exists in public hosted mode.
- target MCP direct registration is protected.
- raw prompts, credentials, or private target endpoints are outside the processing
  boundary.

Allowed wording:

```text
This MCP provides static pre-use assessment and Gateway policy recommendations
based on inventory metadata and declared tool surface. It is a decision-support
tool, not a runtime enforcement path for public PlayMCP users.
```

## Current Repo Gap

Implemented today:

- PlayMCP inventory loader and static assessment model.
- Risk classifier and decision mapper.
- HTML/JSON report generation.
- Stdio upstream MCP server.
- Local prompt-window preflight smoke test.
- Runtime gateway tools for managed/local use.

Still required before PlayMCP public registration:

- inbound Streamable HTTP server mode for `/mcp`.
- `public-preflight` tool allowlist.
- `/healthz` endpoint outside MCP tools.
- Streamable HTTP header/session/version contract.
- origin/body-size/query-length/rate-limit controls.
- hosted privacy/retention policy and public contact.
- PlayMCP temporary registration smoke evidence.
- documentation that keeps public preflight separate from runtime target proxy.

## Acceptance Checklist

- [ ] `POST /mcp` supports initialize, `tools/list`, and `tools/call`.
- [ ] `tools/list` exposes only `gateway_search_playmcp`,
      `gateway_preflight_mcp`, and `gateway_explain_mcp_risk`.
- [ ] `gateway_call_tool`, approval, audit, rescan, target registry, and dynamic
      aliases are not public.
- [ ] `GET /healthz` works and exposes no tenant/private target metadata.
- [ ] PlayMCP temporary registration can load server information.
- [ ] PlayMCP AI Chat can call each public preflight tool.
- [ ] Response text avoids complete-safety, endorsement, and live-enforcement
      claims.
- [ ] Unknown MCPs do not default to `usable`.
- [ ] High-risk labels do not map to default `usable`.
