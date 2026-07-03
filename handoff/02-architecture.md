# 02. Architecture

## 1. High-Level Architecture

```text
MCP Client
  Claude / Codex / ChatGPT
    |
    | MCP stdio or Streamable HTTP
    v
MCP Runtime Policy Gateway
    |
    +-- Upstream MCP Server
    +-- Target Registry
    +-- Target Adapters
    +-- Capability Catalog
    +-- Policy Engine
    +-- Name Mapper
    +-- Approval Store
    +-- Audit Logger
    +-- Evidence Store
    |
    v
Target MCP Server
```

Gateway는 동시에 두 역할을 수행한다.

| 방향 | 역할 |
|---|---|
| Upstream | LLM client 입장에서는 일반 MCP server |
| Downstream | target MCP server 입장에서는 MCP client |

## 2. Runtime Flow

### 2.1 Discovery

```text
1. Operator registers target MCP.
2. Gateway initializes target session.
3. Gateway sends `notifications/initialized` when the MCP lifecycle requires it.
4. Gateway calls target `tools/list` until all pages are collected.
5. Gateway tracks `nextCursor` and `notifications/tools/list_changed`.
6. Gateway normalizes tool definitions.
7. Gateway stores a complete capability snapshot and schema hashes.
8. Policy engine decides exposed aliases.
9. Upstream `tools/list` returns filtered tool surface.
```

### 2.2 Pre-Use Assessment

사용자가 target MCP를 직접 client에 등록하기 전에는 Gateway 자체를 먼저 MCP client에 등록하고, 다음 user-facing tools로 정적 사전검증을 수행한다.

```text
1. User registers only MCP Runtime Policy Gateway in Claude/Codex/desktop MCP client.
2. Client lists Gateway tools in `GATEWAY_TOOL_SURFACE_MODE=client`.
3. User asks whether a target MCP can be connected.
4. Gateway answers through `gateway_search_playmcp`, `gateway_preflight_mcp`, or `gateway_explain_mcp_risk`.
5. The result returns a static inventory-based decision aid, risk labels, representative risky tools, Gateway policy recommendation, and operator handoff.
6. Operator or managed config decides whether/how the target MCP is registered behind the Gateway.
```

이 흐름은 "안전 보장"이 아니라 사용 가능 여부 판단 지원이다. 실제 보호는 target MCP가 client에 직접 등록되지 않고 Gateway 뒤에 있을 때만 성립한다.

### 2.3 Tool Call

```text
1. Client calls Gateway tool.
2. Gateway resolves exposed alias to target/tool.
3. Gateway validates arguments against target schema and alias constraints.
4. Policy engine returns allow, block, approval_required, rewrite, or limited_alias.
5. If block: return MCP tool error with audit id.
6. If approval_required: return approval-required result and use `gateway_request_approval` as the default approval fallback.
7. If allow: call target tools/call.
8. Gateway applies output redaction/egress/resource-link policy to returned text, structuredContent, resource_link, embedded resource, image/audio content.
9. Gateway redacts and stores request/result metadata.
10. Gateway returns sanitized target result plus policy/audit metadata.
```

## 3. Components

| Component | Responsibility | MVP |
|---|---|---:|
| Upstream MCP Server | exposes Gateway tools to LLM clients | Yes |
| Target Registry | stores target config and auth profile ref | Yes |
| StdioTargetAdapter | launches/attaches target MCP over stdio | Yes |
| HttpTargetAdapter | connects to Streamable HTTP target behind ADR-017 egress guard | Guarded post-MVP surface |
| Capability Catalog | stores `tools/list` snapshot and hashes | Yes |
| Policy Engine | evaluates allow/block/approval/alias rules | Yes |
| Name Mapper | maps `target.tool` or alias to target tool | Yes |
| Approval Store | stores exact args hash and TTL approvals | Yes |
| Audit Logger | writes every decision and call event | Yes |
| Evidence Store | stores redacted snapshots and diffs | Yes |
| Dashboard | approval/policy/audit UI | Later |

### 3.1 HTTP Target Adapter / SSRF Guard

HTTP target support is a **post-MVP guarded surface**, not the stdio MVP cut line.
When present, it must stay behind ADR-017:

- `validateUrlShape` checks scheme allowlist, optional host allowlist, and literal private IPs at registration time.
- `assertEgressAllowed` resolves the hostname and requires every resolved address to be public.
- The guard blocks loopback/private/link-local/ULA/CGNAT/metadata IPs, including IPv4-mapped IPv6 forms.
- `HttpTargetAdapter` injects a guarded fetch into `StreamableHTTPClientTransport` and re-validates each request.
- Redirect destinations are validated before following; non-idempotent MCP requests fail closed on redirect.
- True socket-IP pinning and full remote HTTP MCP E2E are follow-up work, not current MVP completion criteria.

## 4. Deployment Rule

보호가 되려면 target MCP는 client에 직접 등록하면 안 된다.

```text
Protected:
  MCP Client -> Gateway -> Target MCP

Not Protected:
  MCP Client -> Gateway
  MCP Client -> Target MCP
```

Deployment modes:

| Mode | Control | Claim boundary |
|---|---|---|
| `self-managed` | 문서와 예시 config를 사용자가 직접 따른다. | 사용자가 target MCP를 직접 추가하면 Gateway 보호 경계를 우회할 수 있다. |
| `validated-local` | `config:validate`로 현재 client config에 Gateway 외 MCP server가 있는지 검사한다. | Drift detection이다. OS/MDM 수준의 lock이 아니며 사후 수정까지 막지는 않는다. |
| `managed-enforced` | MDM, GPO, read-only config, workspace policy 같은 외부 운영 통제로 client config를 배포/잠근다. | 강한 Gateway-only enforcement claim은 이 조건에서만 가능하다. |

운영 문서에는 반드시 다음을 명시한다.

1. client에는 Gateway만 등록한다.
2. target credentials는 Gateway만 가진다.
3. target direct access는 unsupported로 둔다.
4. 이 조건이 깨지면 Gateway는 차단기가 아니라 경고기다.
5. target secret은 policy YAML, command args, env dump, audit/evidence, tool schema에 저장하지 않는다.
6. target은 공식 API, 명시적 권한, 또는 사용자가 보유한 라이선스 범위 안에서만 등록한다.
7. self-managed와 validated-local에서는 `config:validate`를 사용해 drift를 감지하되, managed-enforced 배포가 아니면 강한 직접 연결 차단을 주장하지 않는다.

## 5. Target Session State Machine

Stdio target adapter는 단순 process wrapper가 아니라 MCP lifecycle state machine이어야 한다.

```text
created
  -> spawned
  -> initializing
  -> initialized
  -> observing_tools
  -> ready
  -> closing
  -> closed
  -> crashed
```

필수 처리:

| 항목 | 요구 |
|---|---|
| initialize | protocol version과 capabilities를 협상한다. |
| initialized notification | target lifecycle이 요구하는 초기화 완료 notification을 처리한다. |
| stdio framing | stdout에는 newline-delimited JSON-RPC 메시지만 허용하고 stderr는 diagnostic channel로 분리한다. |
| request id correlation | 모든 downstream request id를 upstream call/audit event와 매핑한다. |
| timeout/cancel | target timeout, client cancel, stale request cleanup을 처리한다. |
| shutdown | 정상 종료 후 미종료 시 SIGTERM, 최종적으로 SIGKILL escalation을 둔다. |
| crash isolation | target crash가 Gateway process를 죽이지 않으며 audit/error event를 남긴다. |
| complete tool observation | paginated `tools/list` 전체 수집 전 snapshot status는 incomplete다. |
| incomplete snapshot behavior | complete snapshot 전에는 target call을 fail-closed한다. |
| reverse capabilities | sampling/elicitation/roots/progress는 MVP에서 advertise하지 않고 target이 요구하면 fail-closed한다. |

## 6. Recommended New Repo Structure

```text
mcp-runtime-policy-gateway/
  README.md
  docs/
    architecture.md
    policy-model.md
    threat-model.md
    testing.md
  packages/
    gateway/
      src/
        upstream/
        targets/
        catalog/
        policy/
        approval/
        audit/
        evidence/
        storage/
        config/
      test/
    sample-targets/
      safe-notes-mcp/
      risky-actions-mcp/
  scripts/
    dev-target.sh
    run-all-tests.sh
  examples/
    policies/
      default-deny.yaml
      local-dev.yaml
```

## 7. Design Constraints

- MVP는 `tools/list`와 `tools/call`만 지원한다.
- resources/prompts는 후순위다.
- target stdio process는 session 단위로 격리 시작한다.
- target tool annotations는 신뢰하지 않는다.
- policy decision은 call-time에 다시 평가한다.
- `tools/list` filtering만으로는 충분하지 않다.
- raw request/result 원문 저장은 기본 금지다.
- `tools/list` pagination 전체 수집 전 snapshot은 complete로 보지 않는다.
- incomplete snapshot 상태에서는 모든 target call을 default block한다.
- `notifications/tools/list_changed`를 받으면 changed tool은 default-deny 또는 재승인 필요 상태로 전환한다.
- `gateway_call_tool` router만으로 제품 demo를 끝내지 않고 최소 1개 filtered target alias를 upstream MCP tool로 노출한다.
- allowed call result도 output redaction/egress policy를 통과해야 한다.
- 브라우저 자동화, 비공식 API, paywall, 약관, rate limit, anti-bot, 인증/권한 우회 target은 unsupported다.
- stdio MVP identity는 config single principal이다.
- target registration is a privileged config/operator boundary, not arbitrary runtime user input.
- unsupported target->client reverse capability requests fail closed.

## 8. Initial NFRs

인라인 프록시는 target 호출마다 policy evaluation, hashing, audit write를 추가한다.

MVP는 다음을 측정하고 회귀 방지한다.

| Area | Initial target |
|---|---|
| Gateway overhead | target execution 시간을 제외한 local policy/hash/audit overhead p95 50ms 이하를 목표로 측정 |
| Audit durability | policy decision event는 응답 전 durable write, bulky raw evidence는 off by default |
| Target timeout | target call timeout과 cancel cleanup을 contract test로 검증 |
| Backpressure | audit/evidence write failure는 allow로 열지 않고 fail-closed 또는 explicit degraded error |

## 9. Protocol References

- MCP Tools: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- MCP Transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP Authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP Security Best Practices: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
