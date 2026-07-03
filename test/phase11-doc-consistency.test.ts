import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLIENT_GATEWAY_TOOL_NAMES,
  GATEWAY_TOOLS,
  OPERATOR_GATEWAY_TOOL_NAMES,
} from "../src/upstream/tools";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function sectionBetween(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

function jsonBlockAfter(text: string, marker: string): string {
  const markerIndex = text.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const blockStart = text.indexOf("```json", markerIndex);
  expect(blockStart).toBeGreaterThan(markerIndex);
  const contentStart = blockStart + "```json".length;
  const blockEnd = text.indexOf("```", contentStart);
  expect(blockEnd).toBeGreaterThan(contentStart);
  return text.slice(contentStart, blockEnd).trim();
}

function removeSection(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) return text;
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (endIndex < 0) return text.slice(0, startIndex);
  return text.slice(0, startIndex) + text.slice(endIndex);
}

describe("documentation consistency (Phase 11)", () => {
  it("keeps README expanded verification gate aligned with package verify:mvp", () => {
    const readme = read("README.md");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const commands = pkg.scripts["verify:mvp"]!.split(" && ");

    for (const command of commands) {
      expect(readme, command).toContain(command);
    }
  });

  it("documents every implemented Gateway tool in the API handoff", () => {
    const api = read("handoff/06-api-and-tool-surface.md");

    for (const tool of GATEWAY_TOOLS) {
      expect(api, tool.name).toContain(tool.name);
    }
  });

  it("documents the client and operator surface split", () => {
    const api = read("handoff/06-api-and-tool-surface.md");

    expect(api).toContain("`client`");
    expect(api).toContain("`operator`");
    for (const name of CLIENT_GATEWAY_TOOL_NAMES) {
      expect(api, `client surface missing ${name}`).toContain(name);
    }
    for (const name of OPERATOR_GATEWAY_TOOL_NAMES) {
      expect(api, `operator surface missing ${name}`).toContain(name);
    }
  });

  it("rejects stale tool schema examples", () => {
    const api = read("handoff/06-api-and-tool-surface.md");
    const exposed = sectionBetween(
      api,
      "### 3.5 `gateway_list_exposed_tools`",
      "### 3.6 `gateway_call_tool`",
    );
    const exposedInput = jsonBlockAfter(exposed, "Input:");

    expect(api).not.toContain("includeHidden");
    expect(exposedInput).toBe("{}");
    expect(exposedInput).not.toContain("targetId");
    expect(api).not.toMatch(/gateway\.(health|list|inspect|rescan|call|request|diff|get|search|preflight|explain)/);
  });

  it("keeps user-facing and handoff docs away from product-guarantee claims", () => {
    const playMcpPublicDoc = removeSection(
      read("docs/playmcp-public-hosted-preflight.md"),
      "Do not claim:",
      "Allowed wording:",
    );
    const projectDirection = removeSection(
      read("PROJECT_DIRECTION.md"),
      "## 10. Forbidden Claims",
      "## 11. Authoritative References In This Repo",
    );
    const apiSurface = removeSection(
      read("handoff/06-api-and-tool-surface.md"),
      "PlayMCP 기반 사전검증은",
      "### 2.1 `gateway_search_playmcp`",
    );
    const docs = [
      read("README.md"),
      projectDirection,
      read("docs/user-scenario-uat.md"),
      playMcpPublicDoc,
      apiSurface,
      read("handoff/08-testing-and-acceptance.md"),
    ].join("\n");
    const forbiddenProductClaims = [
      "이 MCP는 안전하다",
      "안전 보증",
      "sandbox를 제공한다",
      "guarantees security",
      "guarantees safety",
      "blocks all attacks",
      "detects every malicious MCP",
      "Kakao or PlayMCP endorsement",
      "all PlayMCP MCPs are safe to connect",
    ];

    for (const claim of forbiddenProductClaims) {
      expect(docs).not.toContain(claim);
    }
  });

  it("keeps testing acceptance docs aligned with current scripts", () => {
    const testing = read("handoff/08-testing-and-acceptance.md");

    for (const command of ["config:client", "config:validate", "smoke:mcp-client-preflight", "assessment:playmcp", "verify:mvp"]) {
      expect(testing, command).toContain(command);
    }
  });

  it("keeps the managed client deployment boundary documented", () => {
    const docs = [
      read("README.md"),
      read("handoff/02-architecture.md"),
      read("docs/deployment-managed-client.md"),
    ].join("\n");

    for (const required of ["config:validate", "self-managed", "validated-local", "managed-enforced"]) {
      expect(docs, required).toContain(required);
    }
  });

  it("documents the PlayMCP hosted public preflight boundary", () => {
    const docs = [
      read("README.md"),
      read("docs/playmcp-public-hosted-preflight.md"),
      read("docs/adr/ADR-018.md"),
      read("handoff/06-api-and-tool-surface.md"),
      read("handoff/08-testing-and-acceptance.md"),
    ].join("\n");

    for (const required of [
      "public-preflight",
      "gateway_search_playmcp",
      "gateway_preflight_mcp",
      "gateway_explain_mcp_risk",
      "gateway_call_tool",
      "/healthz",
      "Streamable HTTP",
    ]) {
      expect(docs, required).toContain(required);
    }

    expect(read("docs/adr/ADR-017.md")).toContain("downstream outbound HTTP targets");
  });

  it("documents the hosted Streamable HTTP contract required for PlayMCP registration", () => {
    const docs = [
      read("docs/playmcp-public-hosted-preflight.md"),
      read("docs/adr/ADR-018.md"),
      read("handoff/02-architecture.md"),
      read("handoff/08-testing-and-acceptance.md"),
    ].join("\n");

    for (const required of [
      "Accept: application/json, text/event-stream",
      "202 Accepted",
      "GET /mcp",
      "DELETE /mcp",
      "Mcp-Session-Id",
      "MCP-Protocol-Version",
      "400 Bad Request",
    ]) {
      expect(docs, required).toContain(required);
    }
  });

  it("keeps hosted registration as the P1 product target", () => {
    const docs = [
      read("README.md"),
      read("PROJECT_DIRECTION.md"),
      read("handoff/01-product-requirements.md"),
      read("handoff/02-architecture.md"),
    ].join("\n");

    for (const required of [
      "Hosted Registration MVP",
      "P1",
      "public-preflight",
      "PlayMCP registration",
      "inbound Streamable HTTP",
    ]) {
      expect(docs, required).toContain(required);
    }
  });
});
