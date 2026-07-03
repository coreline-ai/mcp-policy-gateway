# Security Policy

This repository is an MVP/runtime-policy gateway prototype. Please do not include
live credentials, private target endpoints, raw audit payloads, or production
database files in reports.

For PlayMCP public hosted preflight, also avoid storing raw user prompts,
private target URLs, access tokens, or unredacted declared tool payloads unless a
separate hosted retention policy explicitly requires it.

Before public PlayMCP listing, the hosted deployment must publish:

- a security/contact channel for abuse, deletion, and vulnerability reports
- actual metadata retention windows
- the list of fields persisted by the hosted service
- the policy for redacting or rejecting credentials/private endpoints in user input

## Reporting

Report security issues through the repository owner or private project channel.
Include:

- affected commit or package version
- reproduction steps using sample targets or sanitized fixtures
- expected vs actual policy decision
- whether raw arguments, results, credentials, or private egress were exposed

## Current Scope

In scope:

- policy enforcement bypass in `MCP Client -> Gateway -> Target MCP`
- SSRF guard bypass for registered HTTP targets
- raw secret persistence in policy, target registry, audit, or evidence tables
- approval replay across actor/client/binding dimensions
- malformed stdio target output crashing the gateway process
- public hosted preflight exposing runtime/operator tools
- public hosted preflight calling or registering target MCPs
- hosted endpoint abuse that bypasses origin, body-size, or rate controls

Out of scope for this MVP:

- OS sandbox or container escape claims
- complete DLP or arbitrary PII detection
- per-user/team identity over stdio transport
- browser/paywall/rate-limit/anti-bot bypass targets
- true socket-IP pinning for HTTP targets until the follow-up transport hook lands
- Kakao/PlayMCP endorsement or public listing policy decisions
- per-user/team enforcement in public hosted preflight mode
