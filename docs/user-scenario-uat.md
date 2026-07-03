# User Scenario UAT

This checklist verifies the intended user workflow for `mcp-policy-gateway`.

## Scope

There are two user-facing paths:

1. **Hosted PlayMCP path**: the operator has already deployed and registered
   `MCP Policy Gateway Preflight` as a public Remote MCP. The user starts in
   PlayMCP, Toolbox, Claude, ChatGPT, or another PlayMCP-connected client and
   asks whether a target MCP should be connected.
2. **Local prompt-window path**: a developer or operator registers this Gateway
   MCP in Claude, Codex CLI, or another desktop MCP client for local validation.

Target MCP registration remains an operator/config action behind the Gateway.
Public hosted preflight does not auto-register or call the target MCP.

## Preconditions

Hosted path:

- Public HTTPS `/mcp` endpoint has been deployed.
- PlayMCP temporary registration can load `tools/list`.
- Public `tools/list` exposes only:
  - `gateway_search_playmcp`
  - `gateway_preflight_mcp`
  - `gateway_explain_mcp_risk`
- `/healthz` exists outside the MCP tool surface.

Local path:

- `npm install` completed.
- `npm run typecheck` passes.
- `PLAYMCP_INVENTORY_CSV` points to the PlayMCP inventory snapshot, or the default local snapshot exists.
- The MCP client config contains only `mcp-policy-gateway` for this workflow.

## Hosted PlayMCP Checks

Ask:

```text
카카오맵 MCP 연결해도 돼?
```

Expected:

- The answer identifies the matching MCP candidate.
- The answer includes a decision, risk labels, representative risky tools,
  Gateway policy recommendation, and next action.
- The answer includes `operatorHandoffStructured` or equivalent handoff text.
- The answer includes inventory freshness information when available.
- The hosted server does not register, initialize, spawn, or call the target MCP.

Ask:

```text
카카오톡 선물하기 MCP는 어떤 승인이 필요해?
```

Expected:

- The answer does not recommend automatic target execution.
- The handoff includes commerce-related review checks.
- The Gateway recommendation includes approval or constrained alias handling.

Ask:

```text
처음 보는 새 MCP를 연결해도 돼?
```

Expected:

- Unknown MCP is handled as manual review or stronger.
- The answer asks for source URL/package id, tools/list or tool names, auth
  scopes, expected data use, and workflow reason.
- No network fetch or target `tools/call` is required for this static intake step.

## Config Generation

Local path only.

Run:

```bash
npm run config:client -- claude-desktop
npm run config:client -- codex-cli
npm run config:client -- generic-json
```

Expected:

- Each output registers `mcp-policy-gateway`.
- The command points to `node_modules/.bin/tsx`.
- The args point to `src/index.ts`.
- `GATEWAY_TOOL_SURFACE_MODE` is `client`.
- `GATEWAY_HMAC_SECRET` is a replacement placeholder, not a real secret.
- No target MCP server is registered in the generated config.

## Protocol Smoke

Local stdio smoke:

Run:

```bash
npm run smoke:mcp-client-preflight
```

Expected:

- Gateway starts as an MCP stdio server.
- MCP SDK client `tools/list` includes:
  - `gateway_search_playmcp`
  - `gateway_preflight_mcp`
  - `gateway_explain_mcp_risk`
- Client mode does not expose:
  - `gateway_list_targets`
  - `gateway_rescan_target`
  - `gateway_get_audit_event`
- MCP SDK client `tools/call` on `gateway_preflight_mcp` returns a structured result.

## Prompt Window Checks

Local path checks:

Ask:

```text
카카오맵 MCP 연결해도 돼?
```

Expected:

- The answer identifies the matching MCP candidate.
- The answer includes a decision, risk labels, representative risky tools, Gateway policy recommendation, and next action.
- The answer includes `operatorHandoffStructured`.
- The answer includes inventory freshness information.

Ask:

```text
카카오톡 선물하기 MCP는 어떤 승인이 필요해?
```

Expected:

- The answer does not recommend direct client registration.
- The handoff includes commerce-related review checks.
- The Gateway recommendation includes approval or constrained alias handling.

Ask:

```text
처음 보는 새 MCP를 연결해도 돼?
```

Expected:

- Unknown MCP is handled as manual review or stronger.
- The answer asks for source URL/package id, tools/list or tool names, auth scopes, expected data use, and workflow reason.
- No network fetch is required for this static intake step.

## Operator Handoff Checks

Expected structured fields:

- `mcpId`
- `mcpName`
- `decision`
- `riskLabels`
- `representativeRiskyTools`
- `recommendedGatewayAction`
- `requiredReviewChecks`
- `registrationBoundary`
- `policyDraftHint`

The handoff is a review artifact, not an automatic target registration command.

## Failure Checks

- If the MCP client is configured with both Gateway and a target MCP directly, this workflow is not protected by Gateway policy.
- If the inventory snapshot is old, treat preflight as a decision aid and re-run tools/list behind the Gateway before exposure.
- If a target MCP requests broad credentials, review scopes before registration.

## Completion Criteria

- A hosted PlayMCP user can select the registered Preflight MCP, ask a preflight question, and understand the decision aid.
- A local developer/operator can generate config, register Gateway, ask a preflight question, and pass the handoff to an operator.
- The operator can use the handoff to decide whether to register the target behind the Gateway.
- The user-facing flow does not add target auto-registration or remote tool calls.
