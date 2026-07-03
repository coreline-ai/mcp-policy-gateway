# 07. Security Boundaries And Threats

## 1. Allowed Claims

제품이 말할 수 있는 것:

> MCP Runtime Policy Gateway는 등록된 target MCP의 tool 노출과 호출을 정책으로 통제하고, 정책상 차단 또는 승인 대상으로 분류된 호출을 target에 전달하지 않으며, 모든 결정의 근거와 감사 로그를 남긴다.

PlayMCP hosted preflight mode가 말할 수 있는 것:

> Hosted Preflight MCP는 PlayMCP inventory와 선언된 tool surface를 바탕으로 target MCP 연결 전 정적 판단 지원, risk label, 권장 정책, 운영자 handoff를 제공한다.

## 2. Forbidden Claims

제품이 말하면 안 되는 것:

- 모든 MCP 공격을 막는다.
- 악성 MCP를 완전히 탐지한다.
- prompt injection을 방지한다.
- data exfiltration을 막는다.
- MCP를 안전하게 sandbox한다.
- target MCP를 직접 등록해도 보호된다.
- zero false positive / zero false negative.
- 이 MCP는 안전하다고 보증한다.
- 브라우저를 통해 유료/API 제한 데이터를 무료로 우회 수집한다.
- paywall, rate limit, anti-bot, 약관 제한을 우회한다.
- Kakao 또는 PlayMCP가 보안상 공식 보증했다.
- 모든 PlayMCP MCP를 연결해도 된다.
- public hosted mode에서 per-user/team enforcement를 제공한다.
- public hosted mode가 remote MCP의 live behavior를 모두 검증했다.
- public hosted mode가 target MCP 직접 등록을 보호한다.

## 3. Security Boundary

Gateway가 통제할 수 있는 것:

| 통제 가능 | 방법 |
|---|---|
| upstream에 보이는 tool 목록 | filtered `tools/list` |
| target 호출 여부 | call-time policy enforcement |
| approval 요구 | exact args hash + TTL |
| limited alias | injected arguments |
| audit trail | append-only events |
| target 변경 감지 | capability snapshot diff |
| target credential client 비노출 | secret store/KMS와 scoped auth profile |
| audit read 최소화 | RBAC, read-side redaction, retention/TTL |
| target 등록 권한 | privileged config/operator action과 executable/endpoint allowlist |
| public preflight answer | inventory metadata, risk labels, deterministic decision mapping |

Gateway가 단독으로 통제할 수 없는 것:

| 통제 불가 | 이유 |
|---|---|
| client가 target MCP를 직접 등록 | Gateway 경로 밖의 호출 |
| target process의 OS-level 행위 | OS sandbox 영역 |
| prompt injection 완전 차단 | model/context 문제 |
| data exfiltration 완전 차단 | output/content 우회 가능 |
| 악성 MCP 완전 판별 | 정적/동적 분석 한계 |
| 약관/라이선스가 금지한 데이터 접근 정당화 | Gateway는 권한을 새로 부여하지 않는다. |
| paywall/rate-limit/anti-bot 우회 | 제품 경로에서 금지한다. |
| stdio 호출자별 신원 확인 | stdio transport는 caller identity를 제공하지 않는다. |
| 임의 target process의 OS-level 격리 | target 등록 자체가 실행 경계이며 OS sandbox가 필요하다. |
| public hosted 사용자의 target MCP 실행 경로 | public-preflight mode는 target을 호출하지 않는다. |

## 3.1 Public Hosted Boundary

`public-preflight` mode는 PlayMCP/Kakao public registration 전용 surface다.

Allowed public tools:

- `gateway_search_playmcp`
- `gateway_preflight_mcp`
- `gateway_explain_mcp_risk`

Not public:

- `gateway_health` as an MCP tool
- `gateway_call_tool`
- `gateway_request_approval`
- `gateway_list_exposed_tools`
- target registry, rescan, diff, audit read, operator tools
- dynamic target aliases

Hosted public mode may process user queries, MCP names, URLs, declared tool names,
and reason-for-use text. Hosted operation must document retention, deletion,
abuse handling, and security contact before public listing.

## 4. Identity And Deployment Assumptions

MVP stdio transport에서는 upstream caller identity가 없다.

따라서 MVP의 `tenantId`, `clientId`, `actorId`는 runtime config에서 주입되는 단일 principal 값이다. 이 값은 audit correlation과 local approval binding에는 사용할 수 있지만, 여러 사용자 사이의 책임 분리나 per-actor approval enforcement를 증명하지 않는다.

팀/플랫폼 persona에 대한 강한 enforcement 주장은 다음 배포 조건에서만 말한다.

1. client에는 Gateway만 등록한다.
2. target MCP endpoint/process/credential은 Gateway 또는 control plane만 가진다.
3. target 직접 등록은 managed config, MDM, workspace policy, network policy 등으로 운영상 차단한다.
4. authenticated HTTP transport 또는 control plane이 도입되기 전까지 per-user/team RBAC는 later scope다.

개인 개발자 persona에는 "완전 차단"이 아니라 tool surface hygiene, approval 습관화, 로컬 감사 편의로 포지셔닝한다.

## 5. Reverse Capability Boundary

Gateway는 target 입장에서는 MCP client이므로 target이 server-to-client 요청이나 notification을 보낼 수 있다.

MVP 기본값:

- sampling, elicitation, roots, progress/log 중계 capability를 advertise하지 않는다.
- target이 unsupported reverse request를 보내면 target 호출을 fail-closed 처리하고 audit event를 남긴다.
- approval UX는 upstream client elicitation에 의존하지 않고 `gateway_request_approval` fallback을 기본 경로로 둔다.
- reverse capability proxying은 별도 설계와 threat model을 거친 later scope다.

## 6. Threat Model

### T1. Hidden Tool Direct Call

상황:

- `tools/list`에서는 숨겼지만 client가 tool name을 직접 `tools/call`한다.

대응:

- call-time policy enforcement 필수
- target 호출 전 block
- audit event 생성

### T2. Target Tool Update

상황:

- target MCP가 새 destructive tool을 추가하거나 schema를 변경한다.

대응:

- periodic `tools/list` observation
- snapshot diff
- changed tool은 approval 재요구

### T3. Misleading Tool Annotation

상황:

- target tool이 read-only annotation을 달았지만 실제로는 mutation을 수행한다.

대응:

- annotation을 신뢰하지 않는다.
- name/schema/known policy/manual review 기반 allowlist를 쓴다.
- sensitive target은 read-only credential 또는 target-side 권한 분리 필요.

### T4. Approval Replay

상황:

- 사용자가 승인한 호출과 다른 인자로 mutation을 실행하려 한다.

대응:

- canonical arguments hash
- exact hash match
- TTL
- single-use option

### T5. Audit Data Leakage

상황:

- audit log에 민감 request/result 원문이 저장된다.

대응:

- hash + redacted metadata 기본값
- raw evidence는 별도 encrypted store + short TTL
- access control 분리

### T6. Browser/API Circumvention

상황:

- target이 브라우저 자동화, 비공식 API, paywall, 약관, rate limit, anti-bot, 인증/권한 우회를 목적으로 등록된다.

대응:

- 공식 API, 명시적 권한, 또는 사용자가 보유한 합법적 라이선스 범위 안의 target만 지원한다.
- 우회 목적 target은 등록, 문서화, demo, sample target에서 금지한다.

### T7. Credential Leakage

상황:

- target secret이 policy YAML, command args, env dump, audit/evidence, tool schema 또는 client output으로 유출된다.

대응:

- 전용 secret store/KMS 사용
- tenant/target scoped least privilege
- read-only credential 우선
- rotation/revoke 지원
- client 비노출
- credential leak regression test 필수

### T8. Output Leakage

상황:

- allow된 tool이 text, structuredContent, resource_link, embedded resource, image/audio content로 secret 또는 민감 데이터를 반환한다.

대응:

- 반환 전 output redaction/egress policy 적용
- resource_link scheme/host/path allowlist
- embedded resource 기본 차단
- output policy event와 redaction report 저장

### T9. Audit Read Abuse

상황:

- `gateway_get_audit_event`가 민감 행동 기록, low-entropy hash, redacted 원문 일부를 과도하게 노출한다.

대응:

- 최소 metadata 반환
- tenant RBAC와 purpose-based access
- retention/TTL
- redact-on-write + redact-on-read
- bulk export 제한
- argumentsHash/resultHash는 tenant-scoped HMAC/salt 사용
- audit read 자체도 audit event로 기록

### T10. Target Registration Trust

상황:

- stdio target 등록은 Gateway host에서 process를 spawn하므로 등록 권한이 곧 임의 코드 실행 경계가 된다.
- later HTTP target 등록은 내부 metadata endpoint나 private network로 향하는 SSRF 경계가 된다.

대응:

- target registry write는 runtime 사용자 입력이 아니라 privileged config 또는 승인된 operator action으로만 허용한다.
- stdio executable은 allowlist 또는 package provenance check를 통과해야 한다.
- command args와 env에는 secret literal을 넣지 않고 secret ref만 둔다.
- child process env 주입은 auth profile/secret store를 통해 scoped 값만 주입한다.
- HTTP target은 egress allowlist, private IP/link-local 차단, DNS rebinding 방어를 별도 gate로 둔다.
- target registration, update, disable은 모두 audit event를 남긴다.

## 7. Required Security Defaults

- default deny
- target credentials는 Gateway만 보유
- raw request/result 저장 off
- mutation approval TTL 10분 이하
- approval exact args hash required
- approval policy/snapshot/schema/rewrite hash binding required
- approval atomic one-time consume required
- target tool annotations untrusted
- policy config versioned
- audit append-only
- denied call target forwarding prohibited
- browser/API/paywall/약관/rate-limit/anti-bot/인증 우회 target prohibited
- target secret in policy YAML, command args, env dump, audit/evidence, tool schema prohibited
- returned output redaction/egress policy required; arbitrary secret/PII redaction is best-effort and never a complete DLP guarantee
- audit read RBAC and read-side redaction required
- incomplete capability snapshot calls fail-closed
- unsupported reverse capabilities fail-closed
- target registration requires privileged config/operator authz
