import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { WORKSPACE_HOST_TOOL_NAMES } from "../tools/names.js";
import { secureStateDirectory, writePrivateFileAtomic } from "./state.js";

export interface OmpIsolation {
  homeDir: string;
  agentDir: string;
  rejectUntrustedExtensions: boolean;
}

const executableSurfaces = ["extensions", "hooks", "tools", "commands", "plugins"] as const;
const modelConfigNames = ["models.yml", "models.yaml", "models.json"] as const;
const MAX_MODEL_CONFIG_BYTES = 4 * 1024 * 1024;
const configFamilies = [".omp", ".pi", ".claude", ".codex", ".gemini", ".cursor", ".opencode"] as const;
const disabledDiscoveryProviders = [
  "agents",
  "agents-md",
  "claude",
  "claude-plugins",
  "cline",
  "codex",
  "gemini",
  "github",
  "mcp-json",
  "native",
  "omp-plugins",
  "opencode",
  "ssh-json",
  "vscode",
  "windsurf",
] as const;
/**
 * The only OMP-native tools permitted across the strict boundary. Workspace,
 * process, browser and desktop capabilities are registered as Axiomux host
 * tools so their path checks, approval callbacks and effect ledger cannot be
 * bypassed by an OMP implementation with the same tool name.
 */
const allowedNativeTools = new Map<string, "allow" | "prompt">([
  ["todo", "allow"],
  ["web_search", "prompt"],
]);
const governedHostTools = [
  ...Object.values(WORKSPACE_HOST_TOOL_NAMES),
  "memory_recall",
  "memory_remember",
  "skill_propose",
  "source_ingest",
  "browser_task",
  "computer_use",
] as const;
const alwaysDeniedTools = [
  "browser",
  "debug",
  "generate_image",
  "init_experiment",
  "inspect_image",
  "launch",
  "learn",
  "lsp",
  "log_experiment",
  "manage_skill",
  "run_experiment",
  "task",
  "tts",
  "update_notes",
] as const;

export interface PreparedOmpIsolation {
  launchDir: string;
  safetyConfigPath: string;
}

export function prepareOmpIsolation(isolation: OmpIsolation, cwd: string, tools: readonly string[] = []): PreparedOmpIsolation {
  validateNativeTools(tools);
  mkdirSync(isolation.homeDir, { recursive: true });
  mkdirSync(isolation.agentDir, { recursive: true });
  for (const directory of [isolation.homeDir, isolation.agentDir]) {
    const security = secureStateDirectory(directory);
    if (!security.hardened) throw new Error(`OMP strict isolation could not secure ${directory}: ${security.detail}`);
  }
  const launchDir = join(isolation.homeDir, "launch");
  mkdirSync(launchDir, { recursive: true });
  if (!isolation.rejectUntrustedExtensions) throw new Error("OMP strict isolation cannot disable executable-surface checks");

  const roots = [
    isolation.agentDir,
    join(isolation.homeDir, ".omp"),
    ...configFamilies.map((name) => join(cwd, name)),
    ...configFamilies.filter((name) => name !== ".omp").map((name) => join(isolation.homeDir, name)),
    join(isolation.homeDir, ".config", "opencode"),
    join(isolation.homeDir, ".codeium", "windsurf"),
  ];
  for (const root of roots) inspectConfigRoot(root);
  inspectKnownMcpConfigs(cwd, isolation);
  for (const path of [join(isolation.homeDir, ".env"), join(isolation.homeDir, ".omp", ".env"), join(isolation.agentDir, ".env"), join(launchDir, ".env")]) {
    if (existsSync(path)) throw new Error(`Untrusted environment file detected inside isolated OMP runtime: ${path}`);
  }
  for (const path of [
    join(isolation.agentDir, "auth-broker.token"),
    join(isolation.homeDir, ".omp", "auth-broker.token"),
    join(isolation.homeDir, ".omp", "agent", "auth-broker.token"),
  ]) {
    if (existsSync(path)) throw new Error(`Untrusted OMP auth-broker token file detected: ${path}`);
  }

  const safetyOverlay = buildSafetyOverlay(tools);
  const overlayHash = createHash("sha256").update(safetyOverlay, "utf8").digest("hex").slice(0, 24);
  const safetyConfigPath = join(isolation.agentDir, `superai-safety-${overlayHash}.yml`);
  writePrivateFileAtomic(safetyConfigPath, safetyOverlay);
  return { launchDir, safetyConfigPath };
}

function inspectConfigRoot(root: string): void {
  if (!existsSync(root)) return;
  for (const name of modelConfigNames) inspectModelConfig(join(root, name));
  inspectSettings(join(root, "settings.json"));
  inspectTextConfig(join(root, "config.yml"));
  inspectTextConfig(join(root, "config.yaml"));
  inspectTextConfig(join(root, "config.toml"));
  for (const surface of executableSurfaces) {
    const directory = join(root, surface);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      throw new Error(
        `Untrusted OMP executable surface detected: ${join(directory, entry.name)}. Strict isolation refuses all implicit extensions, hooks, plugins and custom tools.`,
      );
    }
  }
}

function inspectModelConfig(path: string): void {
  if (!existsSync(path)) return;
  const parsed = parseYamlConfig(path, "model configuration");
  inspectStructuredConfig(parsed, path, "model configuration");
}

function inspectStructuredConfig(parsed: unknown, path: string, label: string): void {
  const queue: Array<{ value: unknown; depth: number; keys: string[] }> = [{ value: parsed, depth: 0, keys: [] }];
  let nodes = 0;
  while (queue.length) {
    const current = queue.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > 100_000 || current.depth > 32) throw new Error(`OMP ${label} exceeds structural safety limits: ${path}`);
    if (typeof current.value === "string") {
      if (current.value.trimStart().startsWith("!")) {
        throw new Error(`OMP ${label} contains a command-backed value, which strict isolation refuses: ${path}`);
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const value of current.value) queue.push({ value, depth: current.depth + 1, keys: current.keys });
    } else if (current.value && typeof current.value === "object") {
      for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
        const normalizedKey = key.trim().toLowerCase();
        const keys = [...current.keys, normalizedKey];
        const dotted = keys.join(".");
        if (normalizedKey === "auth.broker" || normalizedKey.startsWith("auth.broker.") || dotted.includes("auth.broker")) {
          throw new Error(`OMP ${label} contains auth.broker configuration, which strict isolation refuses: ${path}`);
        }
        queue.push({ value: key, depth: current.depth + 1, keys }, { value, depth: current.depth + 1, keys });
      }
    }
  }
}

function inspectSettings(path: string): void {
  if (!existsSync(path)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readBoundedConfig(path, "settings")) as unknown;
  } catch (error) {
    throw new Error(`OMP settings cannot be safely parsed: ${path}`, { cause: error });
  }
  inspectStructuredConfig(parsed, path, "settings");
  const unsafeKey = findUnsafeConfigKey(parsed);
  if (unsafeKey) throw new Error(`OMP settings contain implicit executable discovery (${unsafeKey}): ${path}. Strict isolation refuses it.`);
}

function inspectTextConfig(path: string): void {
  if (!existsSync(path)) return;
  const text = readBoundedConfig(path, "configuration");
  if (/^\s*(?:extensions?|hooks?|plugins?|customTools?|toolPaths?|mcpServers?|mcp_servers)\s*[:=]/im.test(text)) {
    throw new Error(`OMP config may enable implicit executable discovery: ${path}. Strict isolation refuses it.`);
  }
  if (path.toLowerCase().endsWith(".toml")) {
    if (/\bauth\.broker\b/im.test(text) || /(?:=|\[|,)\s*["']?\s*!/m.test(text) || /\\(?:x21|u0021|u\{21\})/i.test(text)) {
      throw new Error(`OMP TOML config contains auth-broker or command-backed values, which strict isolation refuses: ${path}`);
    }
    return;
  }
  const parsed = parseYamlText(text, path, "configuration");
  inspectStructuredConfig(parsed, path, "configuration");
}

function parseYamlConfig(path: string, label: string): unknown {
  return parseYamlText(readBoundedConfig(path, label), path, label);
}

function parseYamlText(content: string, path: string, label: string): unknown {
  try {
    const document = parseDocument(content, { strict: true, uniqueKeys: true, prettyErrors: false });
    if (document.errors.length || document.warnings.length) {
      throw document.errors[0] ?? document.warnings[0] ?? new Error("invalid YAML");
    }
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`OMP ${label} cannot be safely parsed: ${path}`, { cause: error });
  }
}

function readBoundedConfig(path: string, label: string): string {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > MAX_MODEL_CONFIG_BYTES) {
      throw new Error("not a bounded regular file");
    }
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`OMP ${label} cannot be safely read: ${path}`, { cause: error });
  }
}

function findUnsafeConfigKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUnsafeConfigKey(item);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["extensions", "hooks", "plugins", "customTools", "toolPaths", "mcpServers", "mcp_servers"].includes(key) && isNonEmpty(child)) return key;
    const found = findUnsafeConfigKey(child);
    if (found) return found;
  }
  return undefined;
}

function isNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false && value !== "";
}

function inspectKnownMcpConfigs(cwd: string, isolation: OmpIsolation): void {
  const candidates = [
    join(cwd, ".mcp.json"),
    join(cwd, "mcp.json"),
    join(cwd, ".omp", "mcp.json"),
    join(cwd, ".omp", ".mcp.json"),
    join(cwd, ".claude", "mcp.json"),
    join(cwd, ".claude", ".mcp.json"),
    join(cwd, ".cursor", "mcp.json"),
    join(cwd, ".vscode", "mcp.json"),
    join(cwd, ".windsurf", "mcp_config.json"),
    join(cwd, "opencode.json"),
    join(cwd, "opencode.jsonc"),
    join(isolation.agentDir, "mcp.json"),
    join(isolation.agentDir, ".mcp.json"),
    join(isolation.homeDir, ".claude.json"),
    join(isolation.homeDir, ".claude", "mcp.json"),
    join(isolation.homeDir, ".cursor", "mcp.json"),
    join(isolation.homeDir, ".vscode", "mcp.json"),
    join(isolation.homeDir, ".codeium", "windsurf", "mcp_config.json"),
    join(isolation.homeDir, ".config", "opencode", "opencode.json"),
  ];
  const found = candidates.find(existsSync);
  if (found) throw new Error(`Untrusted MCP configuration detected: ${found}. Axiomux strict mode does not start discovered MCP code.`);
}

function buildSafetyOverlay(tools: readonly string[]): string {
  const approvals = new Map<string, "allow" | "prompt" | "deny">();
  // Host implementations enforce their own approval and effect policy. Letting
  // OMP invoke them avoids a second, weaker approval dialog at the RPC layer.
  for (const tool of governedHostTools) approvals.set(tool, "allow");
  for (const tool of tools) {
    const approval = allowedNativeTools.get(tool);
    if (!approval) throw new Error(`OMP tool ${tool} is not allowed by the strict isolation overlay`);
    approvals.set(tool, approval);
  }
  for (const tool of alwaysDeniedTools) approvals.set(tool, "deny");
  const lines = [
    "# Generated by Axiomux before every OMP process. Contains no credentials.",
    "disabledProviders:",
    ...disabledDiscoveryProviders.map((provider) => `  - ${provider}`),
    "mcp:",
    "  enableProjectConfig: false",
    "  notifications: false",
    "advisor:",
    "  enabled: false",
    "prewalk:",
    "  enabled: false",
    "autolearn:",
    "  enabled: false",
    "  autoContinue: false",
    "generate_image:",
    "  enabled: false",
    "speechgen:",
    "  enabled: false",
    "browser:",
    "  enabled: false",
    "tools:",
    "  approvalMode: always-ask",
    "  xdev: false",
    "  approval:",
    ...[...approvals].sort(([left], [right]) => left.localeCompare(right)).map(([tool, decision]) => `    ${tool}: ${decision}`),
    "",
  ];
  return lines.join("\n");
}

function validateNativeTools(tools: readonly string[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!allowedNativeTools.has(tool)) {
      throw new Error(`OMP strict isolation refuses native tool ${JSON.stringify(tool)}; only todo and web_search may cross the native tool boundary`);
    }
    if (seen.has(tool)) throw new Error(`OMP strict isolation refuses duplicate native tool ${JSON.stringify(tool)}`);
    seen.add(tool);
  }
}
