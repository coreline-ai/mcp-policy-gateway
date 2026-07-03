import { renderClientConfig, SUPPORTED_CLIENT_CONFIG_TARGETS } from "../src/onboarding/client-config";

const { target, options } = parseArgs(process.argv.slice(2));

try {
  const rendered = renderClientConfig({ target, ...options });
  console.log(rendered.content);
  console.error(`\n# target=${rendered.target} format=${rendered.format}`);
  for (const note of rendered.notes) console.error(`# ${note}`);
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  console.error(`supported targets: ${SUPPORTED_CLIENT_CONFIG_TARGETS.join(", ")}`);
  process.exitCode = 1;
}

function parseArgs(argv: string[]): {
  target: string;
  options: {
    projectRoot?: string;
    dbPath?: string;
    policyPath?: string;
    inventoryPath?: string;
    tenantId?: string;
    clientId?: string;
    actorId?: string;
  };
} {
  const target = argv[0] ?? "generic-json";
  const options: ReturnType<typeof parseArgs>["options"] = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (!arg.startsWith("--")) continue;
    if (!next || next.startsWith("--")) throw new Error(`missing value for ${arg}`);
    i++;
    switch (arg) {
      case "--project-root":
        options.projectRoot = next;
        break;
      case "--db-path":
        options.dbPath = next;
        break;
      case "--policy-path":
        options.policyPath = next;
        break;
      case "--inventory-path":
        options.inventoryPath = next;
        break;
      case "--tenant-id":
        options.tenantId = next;
        break;
      case "--client-id":
        options.clientId = next;
        break;
      case "--actor-id":
        options.actorId = next;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return { target, options };
}
