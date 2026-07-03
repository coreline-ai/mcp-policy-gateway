# 11. AGENTS.md Template

아래 내용을 새 프로젝트 루트의 `AGENTS.md`로 복사한다.

````md
# MCP Runtime Policy Gateway Agent Guide

## Project Purpose

이 저장소의 목적은 MCP Runtime Policy Gateway를 만드는 것이다.

MCP Runtime Policy Gateway는 LLM client와 target MCP server 사이에 위치해, target MCP의 tool을 그대로 노출하지 않고 정책에 따라 축소, 별칭, 승인 대기, 차단하며, 모든 호출 결정과 근거를 감사 가능하게 남기는 MCP 실행 정책 게이트웨이다.

## Product Boundary

보호되는 배치:

```text
MCP Client -> Runtime Policy Gateway -> Target MCP Server
```

보호되지 않는 배치:

```text
MCP Client -> Runtime Policy Gateway
MCP Client -> Target MCP Server
```

필수 원칙:

1. MCP client에는 Gateway만 등록한다.
2. target MCP endpoint/process/credential은 Gateway만 보유한다.
3. target MCP를 client에 직접 등록하면 Gateway는 보호할 수 없다.
4. 모든 보안 주장은 위 배치 조건 안에서만 말한다.
5. stdio MVP의 tenant/client/actor identity는 config single principal이다.
6. per-user/team enforcement는 authenticated transport 또는 managed deployment 이후에만 주장한다.
7. target registration은 privileged config/operator boundary이며 arbitrary runtime user input으로 열지 않는다.

## MVP Scope

- target registry
- stdio target adapter
- paginated target `tools/list`
- capability snapshot and hash
- filtered upstream `tools/list`
- at least one filtered target alias exposed as MCP tool
- call-time policy enforcement
- default deny policy
- approval store
- exact arguments hash plus policy/snapshot/schema/rewrite hash binding
- atomic one-time approval consume
- limited alias with injected dry-run
- output redaction and resource_link allowlist
- audit/evidence event store
- policy version store
- incomplete snapshot fail-closed
- unsupported reverse capabilities fail-closed
- target executable allowlist

## Out Of Scope

- global MCP firewall
- complete malicious MCP detection
- complete prompt injection prevention
- complete data exfiltration prevention
- OS sandbox guarantee
- Android Fleet control product
- public data or lifestyle API wrapper MCP
- browser/API/paywall/rate-limit/anti-bot/auth bypass target
- per-user enforcement in stdio MVP
- reverse capability proxying without explicit design

## Forbidden Claims

Do not claim:

- 모든 MCP 공격을 막는다.
- 악성 MCP를 완전히 탐지한다.
- prompt injection을 방지한다.
- data exfiltration을 막는다.
- MCP를 안전하게 sandbox한다.
- target MCP를 직접 등록해도 보호된다.
- 이 MCP는 안전하다고 보증한다.
- 브라우저를 통해 유료/API 제한 데이터를 무료로 우회 수집한다.
- paywall, rate limit, anti-bot, 약관 제한을 우회한다.

Allowed claim:

MCP Runtime Policy Gateway는 등록된 target MCP의 tool 노출과 호출을 정책으로 통제하고, 정책상 차단 또는 승인 대상으로 분류된 호출을 target에 전달하지 않으며, 모든 결정의 근거와 감사 로그를 남긴다.

## Implementation Order

1. Target Adapter
2. Capability Catalog
3. Policy Engine
4. Filtered Tools List
5. Call Enforcement
6. Approval Store
7. Audit/Evidence Store
8. Output Policy
9. Diff Watch

## Testing Gate

No feature is complete unless tests prove:

1. denied tool is not exposed in `tools/list`
2. denied direct `tools/call` is not forwarded to target
3. approval requires exact arguments hash plus policy/snapshot/schema/rewrite hash
4. limited alias enforces injected arguments
5. every decision has audit id
6. output policy handles deterministic token/resource_link cases without claiming complete DLP
7. no browser/API/paywall/rate-limit/anti-bot/auth bypass demo exists
8. incomplete snapshot calls fail closed
9. unsupported reverse capabilities fail closed
10. target registration requires privileged config/operator path
11. RFC 8785 post-rewrite arguments hash vectors pass
````

## Template Usage Notes

새 레포에서 실제 코드가 생긴 뒤에는 다음을 추가한다.

- local setup commands
- test commands
- package manager rule
- storage migration rule
- sample target runbook
- release checklist
