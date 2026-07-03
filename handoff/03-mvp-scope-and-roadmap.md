# 03. MVP Scope And Roadmap

> 현재 상태 참고: 이 문서는 최초 stdio MVP cut line과 phase roadmap을 고정한 역사/범위 문서다. 현재 repo에는 PlayMCP inventory 기반 pre-use assessment, MCP client onboarding smoke, ADR-017 guarded HTTP target surface가 추가되어 있다. 다만 full remote HTTP MCP E2E, true socket-IP pinning, dashboard, OS sandbox, authenticated per-user/team enforcement는 여전히 후속 제품화 항목이다.

## 1. MVP Definition

MVP는 target MCP의 tools를 정책으로 중재하는 최소 제품이다.

MVP에 포함되는 것:

1. target MCP 등록
2. stdio target adapter
3. paginated target `tools/list` complete snapshot 저장
4. filtered upstream `tools/list`와 최소 1개 target alias 노출
5. call-time allow/block enforcement
6. approval-required decision
7. policy/snapshot/schema/rewrite hash에 묶인 exact args hash approval
8. target preview/dry-run 모드를 강제한 제한 alias
9. output redaction/egress policy
10. audit/evidence event 저장
11. manual rescan/diff와 changed tool default-deny
12. stdio config single principal identity
13. target registration privileged config/operator boundary
14. incomplete snapshot과 unsupported reverse capability fail-closed
15. policy version 저장과 decision reproduction

MVP에 포함하지 않는 것:

- dashboard
- remote HTTP target
- resources/prompts policy
- OS sandbox
- 완전 자동 위험 탐지
- multi-tenant billing/account
- authenticated per-user/team enforcement
- reverse capability proxying

## 2. Phase Plan

### Phase 0. Project Bootstrap

목표:

- 새 레포 생성
- TypeScript MCP server 기본 실행
- storage, logger, config skeleton 작성
- config single principal identity 작성
- policy version store skeleton 작성

완료 기준:

- `npm test`, `npm run typecheck`, `npm start` 통과
- empty Gateway가 `gateway_health` 또는 `gateway_list_targets`를 응답
- runtime config에서 tenant/client/actor single principal을 로드

### Phase 1. Static Target + Catalog

목표:

- target registry
- stdio target adapter
- target session state machine
- target initialize and initialized notification
- target paginated `tools/list`
- capability complete snapshot/hash 저장
- `notifications/tools/list_changed` 수신 처리

완료 기준:

- sample target MCP를 등록할 수 있다.
- `gateway_inspect_target`이 target tools snapshot을 반환한다.
- 같은 snapshot은 같은 normalized hash를 만든다.
- `nextCursor`가 있는 target tools를 끝까지 수집하기 전 snapshot status는 incomplete다.
- incomplete snapshot 상태에서는 target call이 default block된다.

### Phase 2. Filtered Tools + Call Enforcement

목표:

- default deny policy
- allow read-only rules
- upstream filtered `tools/list`
- hidden/denied direct call block
- unsupported reverse capability fail-closed

완료 기준:

- upstream client에는 allow된 tool만 노출된다.
- 최소 1개 target tool alias가 실제 filtered MCP tool로 upstream `tools/list`에 노출된다.
- 숨겨진 tool 이름으로 직접 호출해도 target에 전달되지 않는다.
- block result에 audit id가 포함된다.
- target이 sampling/elicitation/roots/progress를 요구하면 target 호출은 fail-closed되고 audit event가 남는다.

### Phase 3. Approval + Limited Alias

목표:

- approval store
- exact arguments hash
- policy version, observation id, schema hash, rewrite hash binding
- RFC 8785 canonical post-rewrite effective arguments hash
- TTL approval
- atomic one-time consume
- `dryRun` injected limited alias
- mutation tool approval

완료 기준:

- `danger.apply`는 approval 없이는 실행되지 않는다.
- `danger.preview` alias는 `dryRun: true`를 강제한다.
- approval 이후 policy/snapshot/schema/rewrite hash와 args hash가 모두 일치할 때만 1회 실행된다.
- 같은 args 동시 재사용, TTL 만료, schema 변경 후 stale approval은 차단된다.
- 활성 policy 원문이 `mcp_policies`에 저장되어 audit event의 decision reason을 재현할 수 있다.

### Phase 4. Audit / Evidence Hardening

목표:

- event schema 고정
- redaction 기본값 적용
- raw evidence TTL 분리
- call result metadata 저장
- output redaction/egress/resource-link allowlist
- audit read-side RBAC와 redaction
- target registration audit event와 executable allowlist

완료 기준:

- allow/block/approval/call/error 모두 audit event를 만든다.
- 민감 원문은 기본 저장되지 않는다.
- audit event로 policy decision reason을 재현할 수 있다.
- allowed tool result가 text, structuredContent, resource_link, embedded resource를 포함해도 반환 전 정책을 통과한다.
- `gateway_get_audit_event`는 최소 metadata만 반환하고 tenant scope를 벗어나지 않는다.
- output redaction은 best-effort로만 주장하고 결정론적 패턴/allowlist 테스트로 검증한다.

### Phase 5. Diff / Watch

목표:

- tools/list 재관측
- manual rescan
- tool added/removed/schema changed diff
- changed tool policy invalidation

완료 기준:

- target tool schema가 바뀌면 snapshot diff가 생긴다.
- 변경된 mutation tool은 재승인 전 upstream에 노출되지 않는다.
- `notifications/tools/list_changed` 수신 시 다음 call 전에 catalog 재검증 또는 changed tool block이 일어난다.

## 3. MVP Acceptance Criteria

| ID | Criteria |
|---|---|
| A1 | Gateway만 MCP client에 등록해도 sample target의 allowed tool을 호출할 수 있다. |
| A2 | denied tool은 upstream tools/list에 나오지 않는다. |
| A3 | denied tool을 직접 tools/call해도 target process로 전달되지 않는다. |
| A4 | mutation tool은 approval 없이는 실행되지 않는다. |
| A5 | approval은 target, tool, user/client, policy version, observation id, schema hash, rewrite hash, exact arguments hash, TTL에 묶이고 atomic one-time consume된다. |
| A6 | 제한 alias는 사용자가 `dryRun:false`를 넣어도 true로 강제한다. |
| A7 | 모든 decision은 audit id를 반환한다. |
| A8 | target schema 변경은 diff로 남고 policy 재평가가 필요하다. |
| A9 | allowed tool result는 반환 전 output redaction/egress/resource-link allowlist를 통과한다. |
| A10 | 브라우저 자동화, 비공식 API, paywall, 약관, rate limit, anti-bot, 인증/권한 우회 target은 demo와 acceptance에 쓰지 않는다. |
| A11 | stdio MVP는 config single principal identity로만 audit/approval scope를 설명한다. |
| A12 | incomplete snapshot 상태에서는 target call이 전달되지 않는다. |
| A13 | unsupported reverse capability는 fail-closed된다. |
| A14 | policy version 원문 또는 content ref가 저장되어 decision reason을 재현할 수 있다. |
| A15 | target registration은 privileged config/operator boundary와 executable allowlist를 통과한다. |

## 4. Cut Line

첫 공개 가능한 MVP는 Phase 1~4와 Phase 5의 최소 기능인 manual rescan, schema diff, changed tool default-deny까지다.

주기 watch 전체 자동화는 beta 품질로 미룰 수 있다. 하지만 수동 재관측과 diff invalidation은 MVP 필수다.
