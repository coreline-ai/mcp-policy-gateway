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
    const docs = [
      read("README.md"),
      read("docs/user-scenario-uat.md"),
      read("handoff/06-api-and-tool-surface.md"),
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
});
