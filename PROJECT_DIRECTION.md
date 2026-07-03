# Project Direction Lock

작성일: 2026-06-30 KST

## 1. Fixed Project Purpose

이 프로젝트의 정본 목적은 **MCP를 연결하기 전에 판단을 돕고, 관리형 환경에서는 정책을 집행하는 Gateway**를 만드는 것이다.

현재 제품 모드는 둘로 분리한다.

| Mode | Primary audience | Purpose | Current status |
|---|---|---|---|
| `public-preflight` | PlayMCP/Kakao 사용자와 일반 사용자 | 다른 MCP를 연결하기 전 inventory 기반 사전검증, risk label, decision aid, handoff 제공 | 평가 엔진 구현됨, inbound HTTP hosted mode가 P1 |
| `runtime-gateway` | 개인 개발자, 팀/플랫폼 운영자 | target MCP를 Gateway 뒤에 두고 tool 노출과 `tools/call`을 정책으로 집행 | stdio core 구현됨 |

PlayMCP/Kakao 등록을 위한 1차 제품은 **Hosted Preflight MCP**다. 이 모드는 public Remote MCP server로 등록되며 target MCP를 자동 실행하거나 등록하지 않는다.

> MCP Runtime Policy Gateway is an inline MCP policy proxy that sits between LLM clients and target MCP servers, exposes only policy-approved capabilities, enforces allow/block/approval decisions before tool calls, and records audit/evidence for every decision.

한국어 정의:

> MCP Runtime Policy Gateway는 Claude, Codex, ChatGPT 같은 MCP client와 대상 MCP server 사이에 위치해, 대상 MCP의 tool을 그대로 노출하지 않고 정책에 따라 축소·별칭·승인 대기·차단하며, 모든 호출 결정과 근거를 감사 가능하게 남기는 MCP 실행 정책 게이트웨이다.

Hosted Preflight MCP 정의:

> Hosted Preflight MCP는 PlayMCP/Kakao에 등록되는 public Remote MCP server로, 사용자가 다른 MCP를 연결하기 전에 PlayMCP inventory와 선언된 tool surface를 기반으로 사용 가능 여부 판단 지원, risk label, 권장 Gateway 정책, 운영자 handoff를 제공한다.

## 2. Why This Is The Project

이 저장소는 Android 제어, 공공데이터 조회, 생활정보 MCP, 단순 보안 리포트 방향을 모두 검토했다.

최종 판단은 다음과 같다.

| 후보 방향 | 최종 판정 | 이유 |
|---|---|---|
| Android Fleet control MCP | 주력 폐기 | 기기 권한, 상시 연결, 앱/운영 서버 성격이 강하고 범용 MCP 제품성이 약하다. |
| Public Data MCP Gateway | 주력 폐기 | 사용자 키/운영 키/심의/쿼터/Skill 대체 문제가 크다. |
| 병원/주거/등교/기업/소상공인 MCP | 주력 폐기 | 공개 데이터는 Skill로 충분하고 핵심 데이터는 제휴/동의/유료 영역이다. |
| MCP scanner/report | 단독으로 약함 | 리포트만 생성하면 기존 보안 스캐너 또는 Skill과 겹친다. |
| MCP Runtime Policy Gateway | 조건부 채택 | 실제 MCP 호출 경로에서 tool 노출과 실행을 정책으로 통제하면 MCP다운 차별점이 생긴다. |

## 3. Product Thesis

MCP 생태계의 실질적인 문제는 "MCP server가 있는가"가 아니라 다음이다.

1. LLM client가 등록된 MCP의 전체 tool을 그대로 보게 된다.
2. 사용자는 tool이 읽기 전용인지, 쓰기/삭제/실행 권한을 갖는지 알기 어렵다.
3. target MCP가 업데이트되며 위험 tool을 추가해도 등록 사용자는 즉시 알기 어렵다.
4. 단순 scanner는 경고만 할 뿐 실제 `tools/call`을 막지 못한다.
5. 팀/기업 환경에서는 누가 어떤 tool을 왜 호출했는지 감사 로그가 필요하다.

따라서 이 프로젝트는 두 단계의 사용자 여정을 지원한다.

1. 공개 PlayMCP 사용자는 **Hosted Preflight MCP**를 호출해 target MCP를 연결하기 전 판단 근거를 받는다.
2. 관리형 runtime 사용자는 target MCP를 직접 등록하는 대신, **Gateway만 MCP client에 등록하고 target MCP는 Gateway 뒤에 둔다.**

```text
Claude / Codex / ChatGPT MCP Client
  -> MCP Runtime Policy Gateway
      -> Target MCP A
      -> Target MCP B
      -> Target MCP C
```

Hosted Preflight MCP는 target MCP의 `tools/call`을 실행하지 않는다. Runtime Gateway는 target MCP의 `tools/list`를 수집하고 정책에 맞는 tool만 upstream client에 노출한다. `tools/call` 시점에는 target 호출 전에 policy engine이 `allow`, `block`, `approval_required`, `rewrite`, `limited_alias` 결정을 내린다.

## 4. Core Differentiation

이 프로젝트의 차별점은 "MCP 보안 검사 리포트" 하나가 아니다.

PlayMCP/Kakao 안착을 위한 1차 차별점:

> 사용자가 target MCP를 연결하기 전에, PlayMCP 안에서 바로 호출할 수 있는 MCP-native preflight tool surface를 제공한다.

Runtime/managed 환경의 2차 차별점:

> 대상 MCP의 tool 호출 경로에 inline으로 들어가 실제 실행 전에 정책을 집행한다.

| 약한 제품 | 이 프로젝트의 강한 제품 경계 |
|---|---|
| 사람이 읽는 scanner/report만 제공 | PlayMCP에서 호출 가능한 `search/preflight/explain` MCP tools 제공 |
| "위험할 수 있음" 경고만 제공 | deterministic risk label, decision, recommended Gateway action, operator handoff 제공 |
| public listing에서 target 실행까지 노출 | public mode는 target call을 하지 않고 판단 지원만 제공 |
| 관리형 환경에서도 경고만 제공 | runtime mode에서는 filtered MCP surface와 call-time policy enforcement 제공 |
| 모든 보안을 보장한다고 주장 | static preflight와 managed runtime enforcement의 claim boundary를 분리 |

## 5. Product Scope

### In Scope: Hosted Registration MVP (P1)

| 영역 | 포함 |
|---|---|
| PlayMCP Preflight | PlayMCP inventory 기반 search/preflight/explain tool, risk label, decision mapping, operator handoff |
| Hosted Public Inbound | PlayMCP 등록용 Streamable HTTP `/mcp` endpoint와 `public-preflight` allowlist |
| Public Tool Surface | public `tools/list`는 `gateway_search_playmcp`, `gateway_preflight_mcp`, `gateway_explain_mcp_risk`만 노출 |
| Hosted Health | `gateway_health`가 아니라 HTTP `/healthz`로 liveness 제공 |
| Hosted Controls | Origin validation, body size limit, query length limit, rate/abuse throttling, bounded response size |
| Hosted Privacy | raw prompt/credential/private endpoint 저장 금지, 최소 metadata retention, deletion/security contact |
| PlayMCP Registration Smoke | developer console information load, temporary registration, AI Chat call smoke |

### In Scope: Runtime Gateway MVP

| 영역 | 포함 |
|---|---|
| Target Registry | target MCP endpoint/process/package/repo 등록 |
| Target Adapter | stdio target MCP initialize, `tools/list`, `tools/call` |
| Capability Catalog | target tool name, description, inputSchema, outputSchema, hash 저장 |
| Tool Filtering | allow된 tool만 upstream `tools/list`에 노출 |
| Call Enforcement | denied/unknown tool은 target 호출 없이 block |
| Filtered Alias Surface | `gateway_call_tool` router 외에 최소 1개 target tool alias를 실제 MCP tool처럼 upstream `tools/list`에 노출 |
| Policy DSL | allow, block, approval_required, rewrite, limited_alias, injected arguments, exact args hash, policy/schema/rewrite hash binding |
| Limited Alias | target이 지원하는 `dryRun`/preview 모드를 강제한 제한 tool 별칭 |
| MVP Identity | stdio MVP는 config로 지정된 단일 principal만 증명하며 per-actor/team enforcement는 authenticated transport 이후 완성 |
| Target Registration Trust | target 등록은 privileged config 또는 승인된 operator action으로만 취급하고 executable/endpoint allowlist를 적용 |
| Reverse Capability Boundary | sampling/elicitation/roots/progress 같은 target->client 역방향 capability는 MVP에서 advertise하지 않고 fail-closed |
| Approval Store | TTL, exact args hash, policy version, observation id, schema hash, rewrite hash, approval id, user/tenant scope, atomic one-time consume |
| Output Policy | allowed `tools/call` 결과도 redaction/egress/resource-link allowlist 정책을 거친 뒤 반환 |
| Audit Log | allow/block/approval/call/error 이벤트 저장 |
| Evidence Snapshot | paginated `tools/list` 전체 수집 snapshot, schema hash, diff 근거 저장 |
| Manual Rescan/Diff | `tools/list` pagination, `nextCursor`, `notifications/tools/list_changed`를 고려한 재관측과 changed tool default-deny |

### In Scope: Later Phases

| 영역 | 포함 |
|---|---|
| Streamable HTTP Target Adapter | HTTP/SSE target MCP 연결 |
| Multi Target Namespace | `target.tool` 안정 alias, name collision 방지 |
| Version Diff Watch | tool added/removed/schema changed 감지 |
| Dashboard | approval, policy edit, audit search |
| Resource/Prompt Policy | read-only resource/prompt 노출 검토 |
| GitHub/Package Provenance | repo/package/manifest evidence 연결 |
| Team Policy | tenant/team allowlist, policy versioning |

### Out Of Scope

| 제외 | 이유 |
|---|---|
| 전역 MCP 방화벽 | MCP에는 다른 MCP 연결을 가로채는 표준 interceptor가 없다. |
| 악성 MCP 완전 탐지 | 정적/동적 분석으로 100% 보장 불가. |
| prompt injection 완전 방지 | 완화 가능하지만 보장 불가. |
| data exfiltration 완전 차단 | egress/redaction 정책으로 완화 가능하지만 우회 가능. |
| 로컬 stdio MCP sandbox | 순수 MCP가 아니라 OS sandbox/container/network policy 영역. |
| 브라우저/API/paywall 우회 수집 | 약관, 라이선스, rate limit, anti-bot, 인증/권한 우회를 목적으로 하는 target은 지원하지 않는다. |
| Android Fleet control product | Android/AudioFX/Fleet은 샘플 target일 뿐 주력 제품이 아니다. |
| 공공데이터/생활정보 MCP | Skill 또는 일반 앱/데이터 서비스 영역이다. |

## 6. Required Deployment Rule

진짜 차단이 되려면 다음 배치가 필수다.

```text
Allowed:
  MCP Client -> Runtime Policy Gateway -> Target MCP

Not Protected:
  MCP Client -> Runtime Policy Gateway
  MCP Client -> Target MCP
```

사용자가 target MCP를 client에 직접 등록하면 Gateway는 그 호출을 막을 수 없다.

따라서 제품 문서와 구현은 다음 원칙을 따라야 한다.

1. Client에는 Gateway MCP만 등록한다.
2. Target MCP credentials/endpoints는 Gateway 또는 Control Plane만 가진다.
3. Target MCP 직접 호출은 운영 구성에서 차단하거나 unsupported로 둔다.
4. 모든 보안 주장은 이 배치 조건 안에서만 말한다.
5. Target credentials는 policy YAML, command args, env dump, audit/evidence, tool schema에 저장하지 않는다.
6. Target은 공식 API, 명시적 권한, 또는 사용자가 보유한 합법적 라이선스 범위 안에서만 등록한다.

MVP 포지셔닝:

- 개인 개발자에게는 hygiene, tool surface 축소, 로컬 감사 편의를 제공한다.
- 팀/플랫폼 enforcement 주장은 Gateway-only 등록을 managed config, MDM, workspace policy 등으로 강제할 수 있는 운영 환경에서만 말한다.
- stdio MVP의 `tenantId`/`clientId`/`actorId`는 config에서 주입되는 단일 principal 값이다. 호출자별 승인/감사는 authenticated HTTP transport 또는 관리형 control plane 이후의 범위다.

## 7. Canonical Tool Surface

Hosted Preflight public surface:

| Tool | 목적 |
|---|---|
| `gateway_search_playmcp` | PlayMCP inventory 후보 검색 |
| `gateway_preflight_mcp` | 연결 전 decision/risk/handoff 반환 |
| `gateway_explain_mcp_risk` | risk label과 decision rationale 설명 |

Runtime Gateway local/managed surface:

| Tool | 목적 |
|---|---|
| `gateway_health` | local/runtime liveness와 configured identity 확인 |
| `gateway_list_targets` | 등록된 target MCP 목록 조회 |
| `gateway_inspect_target` | target capabilities/tools snapshot 조회 |
| `gateway_list_exposed_tools` | 현재 정책상 upstream에 노출되는 tool 목록 조회 |
| `gateway_call_tool` | 정책 평가 후 target tool 호출 |
| `gateway_request_approval` | approval fallback 생성 또는 상태 조회 |
| `gateway_get_audit_event` | tenant RBAC와 read-side redaction을 거친 최소 audit metadata 조회 |
| `gateway_diff_target` | 이전 snapshot 대비 tool/schema 변경 조회 |

Upstream client에는 target tool을 직접 pass-through할 수도 있지만, MVP에서는 `gateway_call_tool` router가 구현 난도를 낮춘다. 다만 공개 demo와 acceptance에서는 최소 1개 이상의 target tool alias를 실제 filtered MCP tool처럼 upstream `tools/list`에 노출해야 한다. 이것이 일반 프록시 함수와 MCP Runtime Policy Gateway를 가르는 제품 차별점이다.

## 8. Legacy Asset Rule

이 저장소의 기존 CoreAudioFX, Android Fleet, ADB, Web Dashboard 자산은 다음처럼 재분류한다.

| 자산 | 새 역할 |
|---|---|
| CoreAudioFX MCP tools | policy gateway의 첫 번째 local target fixture |
| `apply_profile`, `bypass`, `rollback` | destructive/mutation approval 정책 데모 대상 |
| `dryRun` 지원 | limited alias 데모 대상 |
| Android 앱/GUI | 주력 제품 아님. legacy 검증 자산 또는 target MCP vertical sample |
| Android Fleet Control Plane 계획 | 일부 policy/audit/control-plane 개념만 흡수 |
| ADB bridge/E2E | 제품 경로 아님. legacy/debug/test asset |
| Public Data reports | 폐기된 아이디어 검토 근거 |

## 9. Success Criteria

Hosted Preflight 성공 조건:

1. public HTTPS `/mcp` endpoint가 PlayMCP에서 등록/임시 테스트 가능하다.
2. public `tools/list`에는 `gateway_search_playmcp`, `gateway_preflight_mcp`, `gateway_explain_mcp_risk`만 노출된다.
3. public mode는 target MCP를 등록, spawn, 호출하지 않는다.
4. PlayMCP inventory 기반으로 decision, risk labels, representative risky tools, recommended Gateway action, operator handoff를 반환한다.
5. unknown/high-risk MCP가 기본 `usable`로 떨어지지 않는다.
6. 문서와 응답은 정적 사전검증과 판단 지원으로 표현하고 완전한 안전이나 Kakao/PlayMCP 공식 보안 승인을 주장하지 않는다.

Runtime Gateway MVP 성공 조건:

1. target MCP를 등록할 수 있다.
2. Gateway가 paginated target `tools/list` 전체를 수집하고 complete snapshot hash를 저장한다.
3. 정책상 허용된 tool만 upstream에 노출한다.
4. 숨겨진/차단된 tool을 직접 call해도 target에 전달하지 않는다.
5. mutation/destructive tool은 approval 없이는 실행되지 않는다.
6. target이 `dryRun`을 지원하면 제한 alias로 노출할 수 있고 사용자가 강제 인자를 덮어쓸 수 없다.
7. 모든 allow/block/approval/call/error에 audit id가 생긴다.
8. tool 추가/삭제/schema 변경을 diff로 감지하고 changed tool은 default-deny 또는 재승인 필요 상태가 된다.
9. 문서와 UI가 "완전 보안"이 아니라 "정책 집행과 감사"라고 말한다.
10. allowed `tools/call` 결과도 반환 전 redaction/egress/resource-link allowlist 정책을 통과한다.
11. 브라우저 자동화, 비공식 API, paywall, 약관, rate limit, anti-bot, 인증/권한 우회를 목적으로 하는 target을 demo나 제품 경로로 사용하지 않는다.

## 10. Forbidden Claims

제품, README, 마케팅, 개발 계획에서 다음 표현은 금지한다.

- 모든 MCP 공격을 막는다.
- 악성 MCP를 완전히 탐지한다.
- prompt injection을 방지한다.
- data exfiltration을 막는다.
- MCP를 안전하게 sandbox한다.
- target MCP를 직접 등록해도 보호된다.
- 이 MCP는 안전하다고 보증한다.
- 브라우저를 통해 유료/API 제한 데이터를 무료로 우회 수집한다.
- paywall, rate limit, anti-bot, 약관 제한을 우회한다.

허용 표현:

> MCP Runtime Policy Gateway는 등록된 target MCP의 tool 노출과 호출을 정책으로 통제하고, 정책상 차단 또는 승인 대상으로 분류된 호출을 target에 전달하지 않으며, 모든 결정의 근거와 감사 로그를 남긴다.

## 11. Authoritative References In This Repo

이 문서가 프로젝트 목적의 정본이다.

보조 실행 문서:

- [handoff/README.md](handoff/README.md)
- [handoff/12-decisions-and-open-questions.md](handoff/12-decisions-and-open-questions.md)
- [handoff/07-security-boundaries-and-threats.md](handoff/07-security-boundaries-and-threats.md)

기존 Android Fleet/CoreAudioFX 문서나 외부 feasibility report가 별도로 보존되어 있더라도 legacy/reference snapshot으로 본다. 충돌 시 이 문서가 우선한다.
