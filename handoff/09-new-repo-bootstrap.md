# 09. New Repo Bootstrap

> 현재 상태 참고: 이 문서는 새 레포를 처음 만들 때 쓰는 초기 scaffold 참고 문서다. 아래 체크리스트는 현재 구현 완료 여부를 추적하는 현황판이 아니며, 현재 상태와 후속 항목은 README와 최신 `dev-plan/implement_*.md`를 기준으로 확인한다.

## 1. 새 레포 생성

추천 이름:

```text
mcp-runtime-policy-gateway
```

추천 초기 stack:

| 영역 | 선택 |
|---|---|
| Runtime | Node.js 22+ |
| Language | TypeScript |
| MCP SDK | official MCP TypeScript SDK |
| Test | Node test runner 또는 Vitest |
| Storage MVP | SQLite |
| Policy config | YAML |
| Formatting | Prettier + ESLint |
| Package manager | npm, committed lockfile |

SDK와 주요 dependency는 bootstrap 시점의 resolved exact version을 lockfile과 README에 기록한다. `package.json`에는 floating `latest`를 남기지 않는다.

## 2. Initial Directory Tree

```text
mcp-runtime-policy-gateway/
  README.md
  package.json
  tsconfig.json
  docs/
    architecture.md
    policy-model.md
    threat-model.md
    testing.md
  src/
    index.ts
    upstream/
      server.ts
      tools.ts
    targets/
      registry.ts
      stdio-adapter.ts
      target-session-state-machine.ts
      target-adapter.ts
    catalog/
      snapshot.ts
      normalize.ts
      diff.ts
    policy/
      engine.ts
      policy-schema.ts
      canonical-hash.ts
      policy-store.ts
    approval/
      approval-store.ts
    audit/
      audit-log.ts
    evidence/
      redaction.ts
      evidence-store.ts
    output/
      output-policy.ts
      resource-allowlist.ts
    secrets/
      secret-store.ts
      credential-custody.ts
    storage/
      db.ts
      migrations/
    config/
      load-config.ts
  sample-targets/
    safe-notes-mcp/
    risky-actions-mcp/
  test/
    policy/
    adapters/
    integration/
    security/
  scripts/
    demo-mvp.ts
  examples/
    policies/
      default-deny.yaml
      local-dev.yaml
```

## 3. First Sprint Checklist

Day 단위 약속이 아니라 phase 진입 체크리스트다. 각 phase는 테스트가 통과될 때만 다음 phase로 넘어간다.

### Phase Entry 1. Scaffold

- [ ] repository scaffold
- [ ] TypeScript strict config
- [ ] MCP server starts
- [ ] `gateway_list_targets` tool
- [ ] SQLite migration runner
- [ ] config single principal identity
- [ ] policy version store skeleton
- [ ] sample `safe-notes-mcp`

### Phase Entry 2. Target Catalog

- [ ] target registry
- [ ] privileged target registration path
- [ ] executable allowlist
- [ ] stdio target adapter
- [ ] target initialize
- [ ] initialized notification
- [ ] protocol/capability negotiation
- [ ] target paginated tools/list
- [ ] snapshot normalization/HMAC hash
- [ ] `notifications/tools/list_changed` handling
- [ ] incomplete snapshot call fail-closed

### Phase Entry 3. Policy Surface

- [ ] policy YAML parser
- [ ] default deny
- [ ] allow rule
- [ ] filtered tools/list
- [ ] at least one filtered target alias exposed as MCP tool
- [ ] call-time enforcement
- [ ] unsupported reverse capability fail-closed
- [ ] exposed tool name grammar `<target_slug>__<tool_slug>`

### Phase Entry 4. Approval

- [ ] approval store
- [ ] RFC 8785 canonical post-rewrite arguments hash
- [ ] policy/snapshot/schema/rewrite hash binding
- [ ] atomic one-time approval consume
- [ ] approval-required result
- [ ] exact hash approval pass/fail tests
- [ ] policy version decision reproduction test

### Phase Entry 5. Audit / Security / Demo

- [ ] audit event schema
- [ ] redaction
- [ ] output policy and resource_link allowlist
- [ ] credential custody checks
- [ ] denied call not forwarded test
- [ ] no-circumvention docs/fixture grep test
- [ ] target crash mid-call test
- [ ] malformed/oversized JSON-RPC test
- [ ] README quickstart
- [ ] MVP demo script

## 4. Initial Commands

```bash
npm init -y
npm pkg set type=module
npm install @modelcontextprotocol/sdk zod yaml better-sqlite3
npm install --save-dev typescript tsx vitest @types/node eslint prettier
```

Required scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "start": "tsx src/index.ts",
    "start:target:safe": "tsx sample-targets/safe-notes-mcp/index.ts",
    "start:target:risky": "tsx sample-targets/risky-actions-mcp/index.ts",
    "demo:mvp": "tsx scripts/demo-mvp.ts"
  }
}
```

Demo script must cover: start target, start Gateway, register target from privileged config, observe tools, apply policy, verify filtered alias, block hidden call, approve exact call, block replay/stale schema, apply output policy, verify audit events.

## 5. Copy From Current Repo

가져갈 문서:

- 이 `docs/handoff/` 전체
- [../PROJECT_DIRECTION.md](../PROJECT_DIRECTION.md)
- optional reference snapshot이 있으면 `docs/reference/` 아래에 복사하되 정본으로 취급하지 않는다.

가져가지 않을 것:

- Android 앱
- ADB bridge
- CoreAudioFX DSP 구현
- Web Dashboard mock 화면
- Android Fleet 전환 계획 본문

선택적으로 가져갈 것:

- CoreAudioFX MCP tools의 `dryRun`, `apply`, `rollback` 개념을 sample target으로 재구현
- 기존 C5 tool 테스트 아이디어를 Gateway integration test로 변환
- 이전 feasibility report는 `docs/reference/` snapshot으로만 보존

금지:

- 브라우저 자동화, 비공식 API, paywall, 약관, rate limit, anti-bot, 인증/권한 우회를 목적으로 하는 sample target 작성
- target credential을 YAML, command args, env dump, audit/evidence, tool schema에 저장

## 6. Initial README Outline

```md
# MCP Runtime Policy Gateway

Inline MCP policy proxy for target MCP servers.

## Why

LLM clients should not see or call every target MCP tool by default.

## Quickstart

1. Start sample target
2. Start Gateway
3. Register Gateway in Claude/Codex
4. Observe filtered tools
5. Try blocked mutation
6. Approve exact call
7. Verify changed schema invalidates approval
8. Verify output redaction

## MVP Identity

stdio MVP uses one configured principal for tenant/client/actor identity.
Per-user approval and team enforcement require authenticated transport or managed deployment.

## Deployment Rule

Register only Gateway in the MCP client. Keep target MCP endpoint/process/credentials behind Gateway.

## Non-Goals

- Not a global MCP firewall
- Not complete malicious MCP detection
- Not a sandbox
- Not a paywall/API/rate-limit/anti-bot bypass tool
```
