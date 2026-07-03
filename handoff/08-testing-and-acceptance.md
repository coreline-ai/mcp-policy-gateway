# 08. Testing And Acceptance

이 문서는 현재 repo의 acceptance 기준을 설명한다. Core stdio MVP 검증은 유지하되, 현재 구현된 PlayMCP inventory 기반 사전검증, 사용자 onboarding, MCP protocol smoke, 문서 정합성 검증도 acceptance에 포함한다.

## 1. Test Pyramid

| Layer | 목적 |
|---|---|
| Unit | policy engine, canonical hash, name mapper, redaction, risk classifier |
| Contract | target adapter MCP message handling, URL egress guard, registry validation |
| Integration | Gateway upstream MCP + sample target MCP |
| Static Assessment | PlayMCP inventory 187개 row 파싱, risk label, decision mapping |
| Report Generation | PlayMCP HTML/JSON report 재생성, 금지 claim 방지 |
| Client Onboarding | Claude/Codex/generic client config 생성, target direct registration 방지 |
| Protocol Smoke | 실제 MCP SDK client가 Gateway stdio server의 `tools/list`와 `tools/call` 경로를 호출 |
| Security Regression | denied call not forwarded, approval replay blocked, high-risk MCP not default allow |
| Snapshot | tools/list normalization and diff |
| E2E | client -> Gateway -> target happy/error paths |
| Abuse Guardrail | no circumvention, credential leak, audit read leakage |
| Doc Consistency | README/handoff가 실제 scripts와 tool surface를 따라가는지 확인 |
| NFR Smoke | gateway overhead, timeout/cancel cleanup, audit durability |

## 2. Required Sample Targets

새 레포에는 최소 두 개의 sample target MCP가 필요하다.

| Target | 목적 |
|---|---|
| `safe-notes-mcp` | read-only list/get/search tool 검증 |
| `risky-actions-mcp` | write/delete/send/apply/rollback 같은 mutation tool 검증 |

`risky-actions-mcp`는 target으로 호출된 횟수와 인자를 테스트용 메모리에 기록해야 한다. Denied call이 target에 도달하지 않았는지 검증하기 위해서다.

## 3. Must-Pass Core Test Cases

| ID | Test | Expected |
|---|---|---|
| T1 | target 등록 | target registry에 저장 |
| T2 | tools/list observation | snapshot과 hash 생성 |
| T2a | paginated tools/list | `nextCursor` 끝까지 수집 전 incomplete, 완료 후 complete |
| T2b | tools/list_changed notification | changed tool default-deny 또는 재승인 필요 |
| T2c | incomplete snapshot call | target 호출 없이 block |
| T3 | default deny | upstream tools/list empty 또는 only Gateway tools |
| T4 | allow read-only | allowed tool만 upstream에 노출 |
| T4a | filtered target alias | 최소 1개 target alias가 실제 MCP tool로 upstream에 노출 |
| T5 | hidden tool direct call | target 호출 없이 block |
| T6 | mutation approval required | approval 없으면 target 호출 없음 |
| T7 | bound approval | RFC 8785 canonical post-rewrite args, policy, snapshot, schema, rewrite hash가 모두 같을 때만 실행 |
| T8 | approval replay changed args | block |
| T8a | approval concurrent replay | 같은 args 동시 재사용 block |
| T8b | approval TTL expired | block |
| T8c | stale schema approval | schema 변경 후 기존 approval block |
| T9 | limited alias dryRun injection | target에는 `dryRun:true` 전달 |
| T10 | user tries dryRun false on alias | `dryRun:true`로 강제 |
| T11 | target schema changed | diff 생성 |
| T12 | changed destructive tool | 재승인 필요 |
| T13 | audit event for allow | audit id 존재 |
| T14 | audit event for block | audit id 존재 |
| T15 | redaction | raw secret 저장 안 됨 |
| T16 | output text redaction | known token/key pattern redacted, 일반 DLP 보장 주장 없음 |
| T17 | resource_link allowlist | disallowed scheme/host/path block |
| T18 | embedded resource policy | embedded resource 기본 block |
| T19 | credential custody | secret not in YAML/command/env dump/audit/schema |
| T20 | audit read privacy | tenant RBAC/read-side redaction/HMAC hash 적용 |
| T21 | no circumvention docs/fixtures | paywall/API/rate-limit/anti-bot/권한 우회 demo 없음 |
| T22 | target registration trust | unapproved executable/endpoint 등록 block |
| T23 | unsupported reverse capability | sampling/elicitation/roots/progress 요구 시 fail-closed |
| T24 | canonical hash vectors | RFC 8785 key order/number/unicode/null-vs-missing 테스트 |
| T25 | policy version reproduction | audit event의 policyVersion으로 decision reason 재현 |
| T26 | target crash mid-call | Gateway process 유지, audit/error event 생성 |
| T27 | malformed or oversized JSON-RPC | target adapter가 block/close하고 Gateway crash 없음 |

## 4. Must-Pass Preflight And Report Test Cases

현재 구현의 사용자 시나리오 테스트는 Phase 8 user preflight, Phase 9 user onboarding, Phase 10 MCP protocol preflight smoke, Phase 12 client config guard로 나뉜다.

| ID | Test | Expected |
|---|---|---|
| PM-T01 | PlayMCP inventory 파싱 | 187개 row, id uniqueness 유지 |
| PM-T02 | category coverage | 12개 category 포함 |
| PM-T03 | risk label assignment | 모든 MCP가 1개 이상 risk label 보유 |
| PM-T04 | decision assignment | 모든 MCP가 supported decision 1개 보유 |
| PM-T05 | high-risk default allow 방지 | mutation/messaging/calendar_write/commerce/code_execution/destructive_control은 `usable`로 떨어지지 않음 |
| PM-T06 | 대표 Kakao services 포함 | 카카오톡 나챗방, 톡캘린더, 카카오맵, 카카오톡 선물하기, 멜론 평가 포함 |
| PM-T07~PM-T13 | static sample checks | report phase checks PASS |
| PM-T14~PM-T18 | Gateway -> target pre-use smoke | filtered alias, denied forwarding 0, approval replay block, diff/audit 확인 |
| PM-T19 | HTML/JSON report 생성 | MCP별 상세 결과, Gateway 권장 정책, 187개 card 포함 |
| PM-T20 | forbidden product claim 방지 | report framing은 판단 지원/정책 권장으로 제한 |
| PM-U01 | client surface tools 노출 | preflight 3개 tool이 `client` mode에 노출 |
| PM-U02 | operator surface split | operator-only tools는 `client` mode에 노출되지 않음 |
| PM-U03 | query preflight | "카카오맵 MCP 연결해도 돼?"가 decision과 handoff 반환 |
| PM-U04 | risk explanation | label rationale를 plain language로 반환 |
| PM-U05 | unknown MCP intake | unknown MCP는 manual review 또는 stronger path로 이동 |
| PM-U06 | client config render | Claude Desktop, Codex CLI, generic JSON config 생성 |
| PM-U07 | direct target registration 방지 | config 예시는 Gateway만 등록 |
| PM-U08 | user-facing forbidden claim 방지 | README/UAT/tool output에 제품 보장형 claim 없음 |
| PM-P01 | MCP protocol smoke | 실제 MCP SDK client가 `gateway_preflight_mcp` 호출 |
| PM-C01 | Gateway-only config validation | `config:validate`가 Gateway-only Claude/generic JSON과 Codex TOML을 pass |
| PM-C02 | direct target registration detection | Gateway 외 MCP server가 있으면 `config:validate`가 fail하고 server name을 반환 |
| PM-C03 | malformed config detection | invalid JSON 또는 unsupported TOML section은 fail |
| PM-C04 | managed deployment boundary docs | self-managed / validated-local / managed-enforced claim boundary 문서화 |

## 5. Core Acceptance Script

첫 MVP demo는 아래 시나리오를 자동화해야 한다.

```text
1. Start risky-actions-mcp sample target.
2. Start Gateway with default-deny policy.
3. Register target from privileged config or operator path.
4. Observe target tools.
5. Attempt call while observation is incomplete and assert block.
6. Apply policy allowing only list/get tools.
7. Verify upstream tools/list exposes at least one filtered target alias and hides apply/delete.
8. Call hidden delete directly through gateway_call_tool.
9. Assert target invocation count is unchanged.
10. Request approval for apply.
11. Approve RFC 8785 post-rewrite exact args hash plus policy/snapshot/schema/rewrite hash.
12. Call apply with same binding and assert target invoked once.
13. Call apply with changed args and assert block.
14. Attempt same-args concurrent replay and assert block.
15. Change target schema and assert stale approval block.
16. Return a fake known token/resource_link from allowed tool and assert output policy applies.
17. Trigger unsupported reverse capability and assert fail-closed.
18. Verify audit events for every step and reproduce one decision from policyVersion.
```

## 6. Prompt Window Acceptance Script

일반 사용자 시나리오는 target MCP 사용 전 사전검증 흐름을 자동화해야 한다.

```text
1. Generate MCP client config with npm run config:client.
2. Validate the active client config with npm run config:validate.
3. Confirm the config registers only mcp-policy-gateway.
4. Start Gateway as an MCP stdio server in client surface mode.
5. List Gateway tools through a real MCP SDK client.
6. Confirm gateway_search_playmcp, gateway_preflight_mcp, gateway_explain_mcp_risk are visible.
7. Ask "카카오맵 MCP 연결해도 돼?" through gateway_preflight_mcp.
8. Confirm the result includes decision, risk labels, representative risky tools, recommended Gateway policy, user next action, and operatorHandoffStructured.
9. Confirm no target MCP is registered directly in the client config.
```

## 7. Definition Of Done

MVP 완료 조건:

- 모든 must-pass core test 통과
- PlayMCP 187개 inventory static assessment 통과
- `npm run assessment:playmcp`가 HTML/JSON report를 생성
- `npm run config:client`가 Claude Desktop, Codex CLI, generic JSON config를 생성
- `npm run config:validate`가 Gateway-only config를 pass하고 direct target config를 fail
- `npm run smoke:mcp-client-preflight` 통과
- `npm run verify:mvp` 통과
- target adapter crash가 Gateway를 죽이지 않음
- denied call forwarding 0회 증명
- audit id 없는 policy decision 없음
- raw secret 저장 테스트 통과
- README와 user-facing docs에 제품 보장형 forbidden claim 없음
- MCP client 등록 절차 문서화
- client에는 Gateway만 등록하고 target은 Gateway 뒤에 둔다는 deployment rule 문서화
- paginated `tools/list`와 `notifications/tools/list_changed` 테스트 통과
- incomplete snapshot call fail-closed 테스트 통과
- approval atomic consume/stale approval 테스트 통과
- output redaction/resource_link allowlist 테스트 통과
- credential custody regression 테스트 통과
- no-circumvention 문서/fixture grep 테스트 통과
- audit read RBAC/read-side redaction 테스트 통과
- target registration trust 테스트 통과
- reverse capability fail-closed 테스트 통과
- RFC 8785 canonical hash vector 테스트 통과
- policy version decision reproduction 테스트 통과
- malformed/oversized JSON-RPC와 target crash mid-call 테스트 통과

## 8. Current Verification Gate

`package.json`의 `verify:mvp`는 아래 expanded gate와 같은 의미여야 한다.

```bash
npm run typecheck
npm test
npm run smoke:preuse
npm run smoke:mcp-client-preflight
npm run assessment:playmcp
npm run demo:mvp
npm audit --omit=dev
```

## 9. Non-Testable Claims

아래는 테스트 완료로 주장하면 안 된다.

- 악성 MCP 완전 탐지
- prompt injection 완전 방지
- data exfiltration 완전 차단
- OS sandbox 보장
- 모든 MCP client 자동 보호
- paywall, 약관, rate limit, anti-bot 우회 가능

PlayMCP 사전검증은 inventory 기반 static assessment이며, 실제 remote MCP의 모든 동작을 보증하지 않는다.
