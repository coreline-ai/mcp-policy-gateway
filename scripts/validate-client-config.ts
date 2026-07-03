import fs from "node:fs";
import {
  DEFAULT_ALLOWED_CLIENT_SERVER_NAMES,
  validateClientConfigContent,
  type ClientConfigValidationResult,
} from "../src/onboarding/client-config-validator";
import { SUPPORTED_CLIENT_CONFIG_TARGETS } from "../src/onboarding/client-config";

const args = parseArgs(process.argv.slice(2));

try {
  const content = fs.readFileSync(args.path, "utf8");
  const result = validateClientConfigContent({
    target: args.target,
    content,
    allowedServerNames: args.allowedServerNames,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanResult(result, args.path);
  }
  if (result.status !== "pass") process.exitCode = 1;
} catch (err) {
  if (args.json) {
    console.log(JSON.stringify({ status: "fail", error: String(err instanceof Error ? err.message : err) }, null, 2));
  } else {
    console.error(String(err instanceof Error ? err.message : err));
  }
  process.exitCode = 1;
}

function parseArgs(argv: string[]): {
  target: string;
  path: string;
  json: boolean;
  allowedServerNames: readonly string[];
} {
  let json = false;
  const positional: string[] = [];
  let allowedServerNames: string[] = [...DEFAULT_ALLOWED_CLIENT_SERVER_NAMES];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--allowed-server") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error("missing value for --allowed-server");
      allowedServerNames = [next];
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    positional.push(arg);
  }

  const target = positional[0];
  const path = positional[1];
  if (!target || !path) {
    printUsage();
    throw new Error("missing required arguments: <target> <config-path>");
  }

  return { target, path, json, allowedServerNames };
}

function printHumanResult(result: ClientConfigValidationResult, configPath: string): void {
  const header = result.status === "pass"
    ? "PASS: client config registers only the Gateway MCP."
    : "FAIL: client config is not Gateway-only.";

  console.log(header);
  console.log(`target: ${result.target}`);
  console.log(`path: ${configPath}`);
  console.log(`protectionLevel: ${result.protectionLevel}`);
  console.log(`allowedServers: ${result.allowedServerNames.join(", ") || "(none)"}`);
  console.log(`detectedServers: ${result.serverNames.join(", ") || "(none)"}`);

  if (result.violations.length > 0) {
    console.log("violations:");
    for (const violation of result.violations) {
      const suffix = violation.serverName ? ` [server=${violation.serverName}]` : "";
      console.log(`- ${violation.code}: ${violation.message}${suffix}`);
    }
  }
  if (result.warnings.length > 0) {
    console.log("warnings:");
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }

  console.log(
    "note: config validation detects direct MCP registration drift; it is not an OS/MDM-level lock.",
  );
}

function printUsage(): void {
  console.error("Usage: npm run config:validate -- <target> <config-path> [--json]");
  console.error(`Targets: ${SUPPORTED_CLIENT_CONFIG_TARGETS.join(", ")}`);
  console.error("Example: npm run config:validate -- claude-desktop ~/.config/Claude/claude_desktop_config.json");
}
