# 12. Decisions And Open Questions

## 1. Locked Decisions

| ID | Decision | Reason |
|---|---|---|
| D1 | 제품명은 MCP Runtime Policy Gateway로 시작한다. | Firewall보다 과장 위험이 적고 runtime policy 성격이 정확하다. |
| D2 | 새 프로젝트는 별도 레포에서 시작한다. | 기존 Android/AudioFX/Fleet 자산과 제품 목적이 다르다. |
| D3 | MVP는 `tools/list`와 `tools/call`만 다룬다. | resources/prompts는 leakage/prompt injection 위험과 구현 범위가 크다. |
| D4 | default deny를 기본 정책으로 둔다. | unknown tool 노출을 막아야 한다. |
| D5 | list filtering만으로 완료로 보지 않는다. | hidden tool direct call을 막으려면 call-time enforcement가 필요하다. |
| D6 | mutation/destructive tool은 approval 기본이다. | LLM 자동 호출 위험을 줄인다. |
| D7 | approval은 exact arguments hash, policy version, observation id, schema hash, rewrite hash에 묶고 atomic one-time consume한다. | 승인 후 인자 변경/replay/race/stale schema를 막는다. |
| D8 | target tool annotations는 신뢰하지 않는다. | target이 거짓 annotation을 줄 수 있다. |
| D9 | raw request/result 저장은 기본 금지다. | audit log 자체가 민감정보 저장소가 되는 것을 막는다. |
| D10 | Android/Fleet/CoreAudioFX는 sample target 소재로만 쓴다. | 주력 제품이 vertical 운영 서버로 회귀하는 것을 막는다. |
| D11 | 공개 MVP demo에는 최소 1개 filtered target alias를 upstream MCP tool로 노출한다. | `gateway_call_tool` 하나만 있으면 일반 프록시로 보인다. |
| D12 | `tools/list` pagination과 `notifications/tools/list_changed`를 MVP catalog 기준에 포함한다. | incomplete snapshot과 changed tool 누락을 막는다. |
| D13 | 브라우저/API/paywall/약관/rate-limit/anti-bot/인증 우회 target은 금지한다. | 제품이 우회 수집기로 오해되거나 악용되는 것을 막는다. |
| D14 | allowed output도 redaction/egress policy를 통과한다. | 허용된 read tool을 통한 secret/resource leakage를 줄인다. |
| D15 | stdio MVP identity는 config single principal로 둔다. | stdio는 caller identity를 제공하지 않으므로 per-actor enforcement를 과장하지 않는다. |
| D16 | team/platform enforcement는 managed Gateway-only 배포에서만 주장한다. | target 직접 등록을 운영상 막지 못하면 Gateway는 경고기에 가까워진다. |
| D17 | target registry write는 privileged config/operator action으로만 허용한다. | stdio target 등록은 Gateway host process execution 경계다. |
| D18 | unsupported reverse capabilities는 MVP에서 fail-closed한다. | sampling/elicitation/roots/progress proxy는 별도 threat model이 필요하다. |
| D19 | approval `argumentsHash`는 RFC 8785 canonical post-rewrite effective arguments에 tenant-scoped HMAC을 적용한다. | limited alias 강제 인자와 replay 방어를 명확히 한다. |
| D20 | policy 원문/version은 `mcp_policies`에 저장한다. | audit event로 decision reason을 재현하려면 policy content가 필요하다. |
| D21 | exposed target alias grammar는 `<target_slug>__<tool_slug>`로 시작한다. | dot/hyphen 혼동과 collision을 줄인다. |
| D22 | incomplete capability snapshot 상태에서는 target call을 default block한다. | 부분 관측 상태에서 hidden dangerous tool 호출이 열리는 것을 막는다. |
| D23 | output redaction은 best-effort로만 주장한다. | 일반 DLP 보장을 하지 않고 결정론적 guardrail만 테스트한다. |
| D24 | 새 레포 구조는 루트 `src/` 기반 단일 패키지로 시작한다. | MVP에서는 workspace/package 분리보다 단순한 bootstrap이 낫다. |

## 2. Defaults To Apply Before Implementation

아래 항목은 bootstrap 전에 기본값을 적용한다. 새로운 근거가 없으면 locked decision으로 승격한다.

| ID | Question | Recommended Default |
|---|---|---|
| Q1 | 첫 storage는 SQLite인가 Postgres인가? | SQLite MVP, logical schema는 Postgres-compatible로 유지 |
| Q2 | upstream transport는 stdio부터인가 HTTP부터인가? | stdio 먼저, caller identity는 config principal |
| Q3 | target adapter는 stdio만 먼저인가? | stdio only in MVP |
| Q4 | approval UX는 어디서 처리하나? | `gateway_request_approval` fallback first |
| Q5 | pass-through alias를 MVP에 넣나? | limited alias와 read-only filtered alias만 |
| Q6 | multi-tenant를 MVP에 넣나? | schema에는 tenant_id, runtime은 single configured tenant |
| Q7 | raw evidence를 저장하나? | off by default, encrypted TTL store later |
| Q8 | 정책 DSL은 JSON인가 YAML인가? | YAML authoring + JSON schema validation |
| Q9 | sample target은 무엇으로 하나? | safe-notes + risky-actions |
| Q10 | CI에서 forbidden claims를 검사하나? | yes, docs grep test |
| Q11 | secret store는 MVP에서 실제 KMS인가 local encrypted store인가? | local encrypted store abstraction, KMS later |
| Q12 | audit read UI/API를 MVP에 열 것인가? | 최소 metadata only, dashboard later |
| Q13 | target executable 등록은 누가 하나? | privileged config/operator only |
| Q14 | HTTP target SSRF 방어는 언제 넣나? | HTTP target later 전 egress allowlist와 private IP block 필수 |

## 3. Decisions That Must Not Be Reopened Casually

아래 결정은 제품 정체성과 직결되므로 새 정보가 없으면 다시 열지 않는다.

- Android Fleet control product로 돌아가지 않는다.
- 공공데이터/생활정보 MCP로 돌아가지 않는다.
- scanner-only 보안 리포트 도구로 축소하지 않는다.
- 전역 MCP 방화벽이라고 주장하지 않는다.
- 완전 보안 제품이라고 주장하지 않는다.
- 브라우저/API/paywall/약관/rate-limit/anti-bot/인증 우회 수집기로 만들지 않는다.
- `gateway_call_tool` router 하나만으로 공개 demo를 끝내지 않는다.
- stdio MVP에서 per-user/team enforcement가 완성됐다고 주장하지 않는다.
- target registry를 임의 사용자 입력으로 열지 않는다.

## 4. First Technical ADR Candidates

새 레포 생성 후 `docs/adr/`에 아래 ADR을 작성한다.

| ADR | Title |
|---|---|
| ADR-001 | Use MCP Runtime Policy Gateway As Product Definition |
| ADR-002 | Start With Tools-Only Mediation |
| ADR-003 | Default Deny Policy |
| ADR-004 | Approval Bound To Exact Arguments Hash |
| ADR-005 | Store Redacted Audit Metadata By Default |
| ADR-006 | Use Stdio Target Adapter For MVP |
| ADR-007 | Require Filtered Target Alias In Public MVP |
| ADR-008 | Treat Tool List Pagination And List Changed As Catalog Requirements |
| ADR-009 | Prohibit Circumvention Targets |
| ADR-010 | Apply Output Policy To Allowed Tool Results |
| ADR-011 | Use Config Single Principal For Stdio MVP |
| ADR-012 | Treat Target Registration As Privileged Execution Boundary |
| ADR-013 | Use RFC 8785 Canonical Effective Arguments For Approval Hash |
| ADR-014 | Persist Policy Versions For Audit Reproduction |
| ADR-015 | Fail Closed For Unsupported Reverse Capabilities |
