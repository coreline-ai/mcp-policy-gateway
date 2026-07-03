# Security Policy

This repository is an MVP/runtime-policy gateway prototype. Please do not include
live credentials, private target endpoints, raw audit payloads, or production
database files in reports.

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

Out of scope for this MVP:

- OS sandbox or container escape claims
- complete DLP or arbitrary PII detection
- per-user/team identity over stdio transport
- browser/paywall/rate-limit/anti-bot bypass targets
- true socket-IP pinning for HTTP targets until the follow-up transport hook lands
