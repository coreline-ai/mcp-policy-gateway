# 01. Product Requirements

## 1. Problem

LLM client가 MCP server를 등록하면 server가 제공하는 tools를 발견하고 호출할 수 있다. 이때 사용자는 다음을 판단하기 어렵다.

1. 어떤 tool이 읽기 전용인지 쓰기/삭제/실행 권한을 갖는지
2. target MCP가 업데이트되며 새 위험 tool을 추가했는지
3. 특정 호출이 왜 허용 또는 차단되었는지
4. 팀 환경에서 누가 어떤 tool을 어떤 인자로 호출했는지
5. mutation/destructive 작업 전에 승인 절차가 있었는지

## 2. Product Goal

MCP Runtime Policy Gateway는 target MCP를 대신 등록하는 MCP server다. target MCP는 Gateway 뒤에 위치하고, LLM client는 Gateway만 등록한다.

목표:

- target MCP의 tool 노출을 정책으로 축소한다.
- 모든 `tools/call` 전에 정책을 평가한다.
- 정책상 차단 또는 승인 대상으로 분류된 호출은 target에 전달하지 않는다.
- 제한 alias로 target이 제공하는 preview/dry-run 모드만 강제 노출할 수 있다.
- tool snapshot과 diff를 저장한다.
- 모든 정책 결정에 audit/evidence를 남긴다.
- allowed tool 결과도 반환 전 output redaction/egress/resource-link allowlist 정책을 거친다.
- 브라우저 자동화, 비공식 API, paywall, 약관, rate limit, anti-bot, 인증/권한 우회를 목적으로 하는 target은 지원하지 않는다.

MVP identity 전제:

- stdio MVP는 호출자 신원을 transport에서 얻지 못하므로 config로 지정된 단일 principal을 `tenantId`/`clientId`/`actorId`로 사용한다.
- 호출자별 approval/audit과 팀 단위 enforcement는 authenticated HTTP transport 또는 관리형 배포가 들어온 뒤 완성한다.
- 개인 개발자에게는 hygiene와 로컬 감사 편의로 설명하고, 팀/플랫폼 강제 효과는 Gateway-only 등록을 운영 정책으로 강제할 수 있는 환경에서만 주장한다.

## 3. Primary Users

| 사용자 | 필요 |
|---|---|
| 개인 개발자 | MCP server의 tool surface를 줄이고 위험 호출을 감사하면서 실험하고 싶다. |
| 팀 리드 | managed config 안에서 팀원이 쓰는 MCP tool surface를 표준화하고 감사하고 싶다. |
| 보안/플랫폼 담당자 | MCP 도입 시 Gateway-only 등록, allowlist, approval, audit 기준을 강제하고 싶다. |
| MCP server 개발자 | 자신의 MCP가 어떤 권한 정책 아래 노출되는지 검증하고 싶다. |

## 4. Core User Stories

| ID | User Story | Acceptance |
|---|---|---|
| US-01 | 사용자는 target MCP를 Gateway에 등록한다. | target id, kind, command/url, auth profile이 저장된다. |
| US-02 | 사용자는 target tool 목록을 확인한다. | Gateway가 target `tools/list` snapshot과 hash를 저장한다. |
| US-03 | 사용자는 허용된 tool만 client에 노출한다. | upstream `tools/list`에는 allow된 tool만 나온다. |
| US-04 | 사용자는 숨겨진 tool 직접 호출을 막는다. | hidden/denied tool은 target 호출 없이 block된다. |
| US-05 | 사용자는 mutation tool에 approval을 요구한다. | approval id, exact args hash, TTL 없이는 실행되지 않는다. |
| US-06 | 사용자는 제한 alias를 노출한다. | target이 `dryRun`을 지원할 때 alias가 강제 인자를 주입하고 사용자가 덮어쓸 수 없다. |
| US-07 | 사용자는 모든 결정을 감사한다. | allow/block/approval/call/error마다 audit event가 생성된다. |
| US-08 | 사용자는 target 변경을 감지한다. | tool added/removed/schema changed diff가 기록된다. |
| US-09 | 사용자는 target secret custody를 Gateway로 제한한다. | secret은 policy YAML, command args, env dump, audit/evidence, tool schema에 저장되지 않는다. |
| US-10 | 사용자는 합법적 target만 등록한다. | 공식 API, 명시적 권한, 또는 보유 라이선스 범위 밖 target 등록은 unsupported다. |

## 5. In Scope: MVP

| 영역 | 포함 |
|---|---|
| Target Registry | stdio target 등록, metadata 저장 |
| Target Adapter | initialize, `tools/list`, `tools/call` |
| Capability Catalog | paginated tool snapshot, schema hash, normalized hash, `list_changed` handling |
| Policy Engine | allow, block, approval_required, rewrite, limited_alias, injected arguments |
| Filtered Tools | upstream `tools/list` 축소 노출 + 최소 1개 filtered target alias |
| Call Enforcement | call-time 최종 차단 |
| Approval Store | approval id, TTL, exact args hash, policy/snapshot/schema/rewrite hash, atomic consume |
| Identity Scope | stdio MVP는 config 기반 단일 principal, per-actor enforcement는 later |
| Target Registration Trust | privileged config/operator만 target 등록, executable allowlist |
| Output Policy | returned text, structuredContent, resource link, embedded resource redaction/egress |
| Audit/Evidence | event log, redacted snapshot, decision reason, read-side redaction |

## 6. Later Scope

| 영역 | 포함 |
|---|---|
| Streamable HTTP target | remote target MCP 연결 |
| Multi target namespace | `target.tool` alias, collision 방지 |
| Diff watch | 주기적 tools/list observation |
| Dashboard | approval, audit search, policy editing |
| Resource/Prompt policy | read-only resource/prompt 검토 |
| Team policy | tenant/team/user scope |

## 7. Explicit Non-Goals

| 제외 | 이유 |
|---|---|
| 전역 MCP 방화벽 | MCP 표준에는 모든 MCP 연결을 가로채는 interceptor가 없다. |
| 악성 MCP 완전 탐지 | 정적/동적 분석만으로 확정 불가하다. |
| prompt injection 완전 방지 | 완화 가능하지만 보장할 수 없다. |
| data exfiltration 완전 차단 | redaction/egress 정책으로 완화 가능하지만 우회 가능하다. |
| OS sandbox 보장 | MCP gateway가 아니라 OS/container/network policy 영역이다. |
| stdio MVP의 per-user enforcement | stdio에는 caller identity가 없으므로 config principal만 감사 가능하다. |
| 브라우저/API/paywall 우회 | 약관, 라이선스, rate limit, anti-bot, 인증/권한 우회를 목적으로 하는 target은 지원하지 않는다. |
| Android Fleet control | 기존 Android/Fleet은 sample target이지 주력 제품이 아니다. |
| 공공데이터/생활정보 MCP | Skill/API wrapper 영역에 가깝다. |
