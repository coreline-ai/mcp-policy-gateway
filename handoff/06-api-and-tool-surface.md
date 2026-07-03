# 06. API And Tool Surface

이 문서는 현재 구현 기준의 Gateway MCP tool surface와 PlayMCP hosted
registration을 위한 planned public surface를 설명한다. Current source of
truth는 `src/upstream/tools.ts`의 `GATEWAY_TOOLS`, `CLIENT_GATEWAY_TOOL_NAMES`,
`OPERATOR_GATEWAY_TOOL_NAMES`와 `src/upstream/gateway.ts`의 dispatch 동작이다.

## 1. Current Gateway Tool Surface

Gateway는 현재 두 가지 구현 surface mode를 가진다. PlayMCP public listing에는
세 번째 planned mode인 `public-preflight`가 필요하다.

| Mode | 목적 | 노출 도구 |
|---|---|---|
| `client` | 일반 MCP client에 기본 노출되는 사용자/런타임 surface | `gateway_health`, `gateway_search_playmcp`, `gateway_preflight_mcp`, `gateway_explain_mcp_risk`, `gateway_call_tool`, `gateway_list_exposed_tools`, `gateway_request_approval` |
| `operator` | target 등록/관측/감사 확인을 수행하는 trusted operator surface | client surface 전체 + `gateway_list_targets`, `gateway_inspect_target`, `gateway_rescan_target`, `gateway_diff_target`, `gateway_get_audit_event` |
| `public-preflight` | PlayMCP/Kakao hosted registration용 public decision-support surface | `gateway_search_playmcp`, `gateway_preflight_mcp`, `gateway_explain_mcp_risk` |

`client` mode의 의도는 비전문 사용자가 Claude, Codex CLI, desktop MCP client의 프롬프트 창에서 먼저 Gateway MCP를 등록하고 target MCP 연결 전 사전검증을 받을 수 있게 하는 것이다. `operator` mode는 target registry와 catalog를 직접 다루는 운영자 전용 surface다.

`public-preflight` mode는 아직 구현되지 않은 hosted inbound mode다. 이 mode는
PlayMCP에서 public Remote MCP로 등록하기 위한 surface이며 target registry,
target adapter, approval store, audit read, dynamic target aliases를 노출하지 않는다.

## 2. Pre-Use Assessment Tools

PlayMCP 기반 사전검증은 inventory 기반 정적 판단 지원이다. 실제 remote MCP의 `tools/call`을 자동 호출하지 않으며, "안전 보장"이나 악성 MCP 완전 탐지를 주장하지 않는다.

For hosted public registration, these are the only MCP tools that should appear
in `tools/list`. Operational health should move to HTTP `/healthz`, not
`gateway_health`.

### 2.1 `gateway_search_playmcp`

Input:

```json
{
  "query": "카카오맵",
  "limit": 5
}
```

Output:

```json
{
  "status": "found",
  "query": "카카오맵",
  "candidates": [
    {
      "id": "playmcp-id",
      "name": "카카오맵",
      "category": "생활/로컬/교통"
    }
  ]
}
```

### 2.2 `gateway_preflight_mcp`

Input:

```json
{
  "query": "카카오맵 MCP 연결해도 돼?",
  "includeCandidates": true,
  "reasonForUse": "길찾기와 장소 검색"
}
```

선택 input:

```json
{
  "id": "playmcp-id",
  "name": "카카오맵",
  "homepageOrPackageUrl": "https://example.com/mcp",
  "declaredTools": ["search_place", "route_find"]
}
```

Output:

```json
{
  "status": "assessed",
  "item": {
    "id": "playmcp-id",
    "name": "카카오맵",
    "decision": "usable_with_approval",
    "labels": ["location", "external_network"],
    "representativeRiskyTools": ["route_find"],
    "recommendedGatewayAction": "approval_required for location-sensitive tools",
    "userNextAction": "operator handoff를 검토한 뒤 Gateway 뒤에 target을 등록",
    "operatorHandoff": "MCP=카카오맵 ...",
    "operatorHandoffStructured": {
      "mcpName": "카카오맵",
      "decision": "usable_with_approval",
      "requiredReviewChecks": ["tool surface", "auth scope", "location data handling"]
    }
  }
}
```

결정값은 `usable`, `usable_with_approval`, `manual_review`, `not_recommended`, `blocked` 중 하나다. 알 수 없는 MCP는 자동 allow로 떨어지지 않고 `manual_review` 이상의 intake 경로로 보낸다.

### 2.3 `gateway_explain_mcp_risk`

Input:

```json
{
  "query": "카카오톡 선물하기",
  "labels": ["commerce", "messaging"]
}
```

Output:

```json
{
  "status": "explained",
  "labels": ["commerce", "messaging"],
  "explanations": [
    {
      "label": "commerce",
      "meaning": "구매/결제/주문과 연결될 수 있어 승인 또는 수동 검토가 필요"
    }
  ]
}
```

### 2.4 Public Hosted Exclusion Rules

PlayMCP public listing must hide every runtime/operator tool:

| Tool or group | Public status | Reason |
|---|---:|---|
| `gateway_health` | Hidden as MCP tool | Use HTTP `/healthz`; do not expose tenant/runtime metadata to the model. |
| `gateway_call_tool` | Hidden | It routes real target calls and belongs only to runtime Gateway mode. |
| `gateway_list_exposed_tools` | Hidden | It reveals policy-filtered runtime alias surface. |
| `gateway_request_approval` | Hidden | It creates approval state and belongs to managed/local runtime flows. |
| `gateway_list_targets`, `gateway_inspect_target`, `gateway_rescan_target`, `gateway_diff_target`, `gateway_get_audit_event` | Hidden | Trusted operator-only controls. |
| Dynamic target aliases | Hidden | Public preflight is not a target proxy. |

## 3. Runtime And Operator Tools

### 3.1 `gateway_health`

Input:

```json
{}
```

Output:

```json
{
  "status": "ok",
  "tenantId": "local-tenant"
}
```

### 3.2 `gateway_list_targets`

Operator surface only.

Input:

```json
{
  "status": "active"
}
```

Output:

```json
{
  "targets": [
    {
      "id": "risky-actions",
      "name": "Risky Actions Target",
      "kind": "stdio",
      "status": "active",
      "lastObservationHash": "sha256:..."
    }
  ]
}
```

### 3.3 `gateway_inspect_target`

Operator surface only.

Input:

```json
{
  "targetId": "risky-actions"
}
```

Output:

```json
{
  "targetId": "risky-actions",
  "observationId": "uuid",
  "completeness": "complete",
  "callable": true,
  "listChangedAt": null,
  "tools": [
    {
      "targetTool": "actions.list_runs",
      "exposureStatus": "exposed",
      "schemaHash": "hmac-sha256:..."
    }
  ]
}
```

`callable`이 false인 snapshot은 target call을 fail-closed한다.

### 3.4 `gateway_rescan_target`

Operator surface only.

Input:

```json
{
  "targetId": "risky-actions"
}
```

Output:

```json
{
  "targetId": "risky-actions",
  "observationId": "uuid",
  "completeness": "complete",
  "toolCount": 4,
  "normalizedHash": "hmac-sha256:...",
  "callable": true,
  "diff": {
    "added": [],
    "removed": [],
    "changed": []
  }
}
```

새로 추가되거나 schema가 바뀐 tool은 review 전까지 fail-closed 상태가 된다.

### 3.5 `gateway_list_exposed_tools`

Input:

```json
{}
```

Output:

```json
{
  "exposedTools": [
    {
      "exposedName": "risky_actions__preview_profile",
      "targetId": "risky-actions",
      "targetName": "Risky Actions Target",
      "targetTool": "actions.apply_profile",
      "effect": "limited_alias"
    }
  ]
}
```

이 tool은 현재 policy-filtered target alias surface 전체를 반환한다. 특정 target만 조회하는 input은 현재 구현에 없다.

### 3.6 `gateway_call_tool`

Input:

```json
{
  "targetId": "risky-actions",
  "tool": "actions.apply_profile",
  "arguments": {
    "profileId": "night_mode",
    "dryRun": false
  }
}
```

Approval-required output:

```json
{
  "isError": true,
  "decision": "approval_required",
  "auditEventId": "uuid",
  "approval": {
    "approvalId": "uuid",
    "expiresAt": "2026-06-30T10:00:00Z",
    "argumentsHash": "hmac-sha256:...",
    "binding": {
      "policyVersion": "hmac-sha256:...",
      "observationId": "uuid",
      "schemaHash": "hmac-sha256:...",
      "rewriteHash": "hmac-sha256:..."
    }
  }
}
```

Allowed output:

```json
{
  "isError": false,
  "decision": "allow",
  "auditEventId": "uuid",
  "targetResult": {
    "content": []
  },
  "outputPolicy": {
    "status": "passed",
    "redacted": false
  }
}
```

Allowed result는 반환 전 output policy를 통과해야 한다. Text, `structuredContent`, `resource_link`, embedded resource, image/audio content는 각각 best-effort redaction, allowlist, size limit, metadata stripping 정책을 적용한다.

### 3.7 `gateway_request_approval`

Input:

```json
{
  "targetId": "risky-actions",
  "tool": "actions.apply_profile",
  "arguments": {
    "profileId": "night_mode",
    "dryRun": false
  },
  "reason": "operator reviewed one dry-run-bound mutation"
}
```

Output:

```json
{
  "approvalId": "uuid",
  "status": "pending",
  "expiresAt": "2026-06-30T10:00:00Z",
  "binding": {
    "argumentsHash": "hmac-sha256:...",
    "policyVersion": "hmac-sha256:...",
    "observationId": "uuid",
    "schemaHash": "hmac-sha256:...",
    "rewriteHash": "hmac-sha256:..."
  },
  "auditEventId": "uuid"
}
```

MVP에서는 upstream client elicitation에 의존하지 않고 이 fallback tool을 pending approval 생성 경로로 둔다. Approval grant/reject는 운영자 CLI 또는 별도 운영 채널에서 처리한다.

### 3.8 `gateway_diff_target`

Operator surface only.

Input:

```json
{
  "targetId": "risky-actions",
  "fromObservationId": "uuid",
  "toObservationId": "uuid"
}
```

Output:

```json
{
  "targetId": "risky-actions",
  "from": "uuid",
  "to": "uuid",
  "added": [],
  "removed": [],
  "changed": [
    {
      "tool": "actions.apply_profile",
      "change": "input_schema_changed",
      "newExposureStatus": "hidden_until_review"
    }
  ]
}
```

### 3.9 `gateway_get_audit_event`

Operator surface only.

Input:

```json
{
  "auditEventId": "uuid",
  "purpose": "debug policy decision"
}
```

Output:

```json
{
  "auditEventId": "uuid",
  "eventType": "approval_required",
  "targetId": "risky-actions",
  "targetTool": "actions.apply_profile",
  "exposedTool": null,
  "decision": "approval_required",
  "ruleId": "approve-mutations",
  "reason": "approval required",
  "actorId": "agent-local",
  "clientId": "local-client",
  "policyVersion": "hmac-sha256:...",
  "policyContentAvailable": true,
  "observationId": "uuid",
  "argumentsHash": "hmac-sha256:...",
  "resultHash": null,
  "approvalId": "uuid",
  "outputPolicyStatus": null,
  "redacted": true,
  "rawArgumentsStored": false,
  "rawResultStored": false
}
```

Audit read는 tenant scope, purpose, read-side redaction을 적용하고 `audit_event_read` event를 새로 남긴다. 반환값은 decision 재현에 필요한 rule id, policy version, observation id, HMAC evidence만 포함하며 raw arguments/results 또는 policy 원문은 반환하지 않는다.

## 4. Policy-Filtered Target Aliases

Gateway는 admin tool 외에 policy-filtered target alias를 실제 MCP tool처럼 upstream `tools/list`에 노출한다.

예:

| Target tool | Exposed tool | 정책 |
|---|---|---|
| `notes.list` | `safe_notes__notes_list` | allow |
| `actions.apply_profile` | `risky_actions__preview_profile` | `dryRun: true` injected limited alias |
| `actions.delete_all` | hidden | direct call block |

Target alias grammar는 `<target_slug>__<tool_slug>`다. Slug는 lowercase `[a-z0-9_]+`이며 original target/tool name 역매핑은 audit event에 저장한다.

중요한 경계:

- `tools/list` filtering은 사용자 경험 surface이고, 보안 제어는 call-time enforcement다.
- 숨겨진 tool을 `gateway_call_tool`로 직접 호출해도 정책과 snapshot 상태를 다시 평가한다.
- Incomplete/stale snapshot 또는 review 대기 tool은 target 호출 없이 fail-closed한다.
- Limited alias의 rewrite는 사용자 입력보다 우선한다.

## 5. Target Adapter Interface

```ts
export interface TargetAdapter {
  initialize(target: TargetConfig): Promise<TargetSession>;
  sendInitialized(session: TargetSession): Promise<void>;
  listToolsPage(session: TargetSession, cursor?: string): Promise<TargetToolListPage>;
  listToolsComplete(session: TargetSession): Promise<TargetToolList>;
  callTool(
    session: TargetSession,
    request: TargetToolCall
  ): Promise<TargetToolResult>;
  cancel(session: TargetSession, requestId: string): Promise<void>;
  close(session: TargetSession): Promise<void>;
  kill(session: TargetSession): Promise<void>;
}
```

Adapter 구현 요구:

- protocol version/capability negotiation
- newline-delimited JSON-RPC stdio framing
- stdout/stderr 분리
- request id correlation
- timeout/cancel
- SIGTERM/SIGKILL shutdown escalation
- crash isolation
- `notifications/tools/list_changed` handling
- HTTP target의 경우 ADR-017 egress guard와 per-request revalidation

## 6. Policy Engine Interface

```ts
export interface PolicyEngine {
  evaluateList(input: ListPolicyInput): ListPolicyDecision[];
  evaluateCall(input: CallPolicyInput): CallPolicyDecision;
}

export type CallPolicyDecision =
  | { type: "allow"; ruleId: string }
  | { type: "block"; ruleId: string; reason: string }
  | { type: "approval_required"; ruleId: string; reason: string }
  | { type: "rewrite"; ruleId: string; rewrittenArguments: unknown }
  | { type: "limited_alias"; ruleId: string; rewrittenArguments: unknown; rewriteHash: string };
```

## 7. Error Semantics

권장:

- malformed request는 protocol error
- policy block은 tool result with `isError: true`
- approval_required는 tool result with `isError: true`와 approval binding metadata
- target execution failure는 tool result with `isError: true`
- gateway internal failure는 target 호출 전이면 protocol/internal error, target 호출 후 sanitization 실패면 tool result with `isError:true`
- timeout/cancel은 target forwarding 여부와 cleanup 결과를 audit metadata에 남김
- incomplete snapshot, unsupported reverse capability, registry authz failure는 fail-closed tool result 또는 protocol error로 반환하되 target call은 하지 않음

모든 에러는 `auditEventId`를 포함해야 한다.

## 8. Hash And Approval Semantics

Approval request는 다음 값을 포함해야 한다.

```json
{
  "targetId": "risky-actions",
  "toolName": "actions.apply_profile",
  "policyVersion": "hmac-sha256:...",
  "observationId": "uuid",
  "schemaHash": "hmac-sha256:...",
  "rewriteHash": "hmac-sha256:...",
  "argumentsHash": "hmac-sha256:...",
  "consume": "one-time-atomic"
}
```

위 값 중 하나라도 변경되면 기존 approval은 stale로 처리한다.

`argumentsHash`는 RFC 8785로 canonicalize한 post-rewrite effective arguments에 tenant-scoped HMAC-SHA-256을 적용한 값이다. raw user arguments가 아니라 target에 실제 전송되는 값을 기준으로 한다.
