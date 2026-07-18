import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SuperAIConfig } from "./types.js";
import { isModelSelector, MAX_FALLBACK_MODELS, MAX_FUSION_PARTICIPANTS } from "./fusion/catalog.js";
import type { OmpIsolation } from "./security/omp-isolation.js";
import { managedOmpExecutablePath } from "./security/omp-runtime.js";
import { isKnownSuperAIToolCapability } from "./tools/workspace-tools.js";
import { resolveTrustedExecutable } from "./security/executable.js";
import { writePrivateFileAtomic } from "./security/state.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function findProjectRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "config", "default.json")) && existsSync(join(current, "agent", "SOUL.md"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(moduleDir, "..", "..");
    current = parent;
  }
}

export interface ProjectPaths {
  root: string;
  stateDir: string;
  database: string;
  config: string;
  workflows: string;
  auditLog: string;
  ompSessions: string;
  ompRuntime: string;
  ompHome: string;
  ompAgentDir: string;
}

export function getPaths(root = findProjectRoot()): ProjectPaths {
  const stateDir = join(root, ".superai");
  return {
    root,
    stateDir,
    database: join(stateDir, "state.db"),
    config: join(stateDir, "config.json"),
    workflows: join(stateDir, "workflows"),
    auditLog: join(stateDir, "audit.jsonl"),
    ompSessions: join(stateDir, "omp-sessions"),
    ompRuntime: join(stateDir, "omp-runtime"),
    ompHome: join(stateDir, "omp-runtime", "home"),
    ompAgentDir: join(stateDir, "omp-runtime", "agent"),
  };
}

function mergeConfig(base: SuperAIConfig, override: Partial<SuperAIConfig>): SuperAIConfig {
  return {
    ...base,
    ...override,
    fallbackModels: override.fallbackModels ?? base.fallbackModels,
    ompTools: override.ompTools ?? base.ompTools,
    ompEnvAllowlist: override.ompEnvAllowlist ?? base.ompEnvAllowlist,
    ompIsolation: {
      ...base.ompIsolation,
      ...override.ompIsolation,
    },
    persona: {
      ...base.persona,
      ...override.persona,
    },
    selfEvaluation: {
      ...base.selfEvaluation,
      ...override.selfEvaluation,
    },
    memory: {
      recallLimit: override.memory?.recallLimit ?? base.memory.recallLimit,
      maxContextCharacters: override.memory?.maxContextCharacters ?? base.memory.maxContextCharacters,
      halfLifeDays: override.memory?.halfLifeDays ?? base.memory.halfLifeDays,
      episodic: {
        ...base.memory.episodic,
        ...override.memory?.episodic,
      },
    },
    fusion: {
      ...base.fusion,
      ...override.fusion,
      models: override.fusion?.models ?? base.fusion.models,
    },
    adapters: {
      browserUse: {
        ...base.adapters.browserUse,
        ...override.adapters?.browserUse,
        envAllowlist: override.adapters?.browserUse?.envAllowlist ?? base.adapters.browserUse.envAllowlist,
        allowedDomains: override.adapters?.browserUse?.allowedDomains ?? base.adapters.browserUse.allowedDomains,
      },
      computerUse: {
        ...base.adapters.computerUse,
        ...override.adapters?.computerUse,
        envAllowlist: override.adapters?.computerUse?.envAllowlist ?? base.adapters.computerUse.envAllowlist,
      },
    },
  };
}

export function loadConfig(root = findProjectRoot()): SuperAIConfig {
  return validateConfig(applyEnvironment(loadPersistedConfig(root)));
}

function loadPersistedConfig(root: string): SuperAIConfig {
  const paths = getPaths(root);
  const defaults = JSON.parse(readFileSync(join(root, "config", "default.json"), "utf8")) as SuperAIConfig;
  if (!existsSync(paths.config)) return validateConfig(defaults);
  const local = JSON.parse(readFileSync(paths.config, "utf8")) as Partial<SuperAIConfig>;
  return validateConfig(mergeConfig(defaults, local));
}

function applyEnvironment(config: SuperAIConfig): SuperAIConfig {
  if (process.env.SUPERAI_OMP_ISOLATION && process.env.SUPERAI_OMP_ISOLATION !== "strict") {
    throw new Error("SUPERAI_OMP_ISOLATION only accepts strict; shared isolation is not supported");
  }
  return {
    ...config,
    model: process.env.SUPERAI_MODEL ?? config.model,
    fallbackModels: process.env.SUPERAI_FALLBACK_MODELS
      ? process.env.SUPERAI_FALLBACK_MODELS.split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : config.fallbackModels,
    ompExecutable: process.env.SUPERAI_OMP ?? config.ompExecutable,
    ompEnvAllowlist: process.env.SUPERAI_OMP_ENV_ALLOWLIST
      ? process.env.SUPERAI_OMP_ENV_ALLOWLIST.split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : config.ompEnvAllowlist,
  };
}

export function saveConfig(config: SuperAIConfig, root = findProjectRoot()): void {
  const paths = getPaths(root);
  const safe = structuredClone(validateConfig(config));
  const persisted = loadPersistedConfig(root);
  if (process.env.SUPERAI_MODEL) safe.model = persisted.model;
  if (process.env.SUPERAI_FALLBACK_MODELS) safe.fallbackModels = persisted.fallbackModels;
  if (process.env.SUPERAI_OMP) safe.ompExecutable = persisted.ompExecutable;
  if (process.env.SUPERAI_OMP_ENV_ALLOWLIST) safe.ompEnvAllowlist = persisted.ompEnvAllowlist;
  writePrivateFileAtomic(paths.config, `${JSON.stringify(validateConfig(safe), null, 2)}\n`);
}

export function validateConfig(config: SuperAIConfig): SuperAIConfig {
  if (!isModelSelector(config.model)) throw new Error("Config model must be provider/model");
  validateStringArray(config.fallbackModels, "fallbackModels", /^[^\s/]+\/.{1,220}$/u);
  if (config.fallbackModels.some((model) => !isModelSelector(model))) throw new Error("Config fallbackModels contains an invalid provider/model selector");
  if (config.fallbackModels.length > MAX_FALLBACK_MODELS) throw new Error(`Config fallbackModels accepts at most ${MAX_FALLBACK_MODELS} models`);
  if (config.fallbackModels.includes(config.model)) throw new Error("Config fallbackModels cannot repeat the primary model");
  const thinking = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
  if (!thinking.has(config.thinkingLevel)) throw new Error("Config thinkingLevel is invalid");
  if (typeof config.ompExecutable !== "string" || !config.ompExecutable.trim()) throw new Error("Config ompExecutable is required");
  if (config.ompProfile !== "") {
    throw new Error("Config ompProfile must be empty: named OMP profiles bypass the isolated agent directory");
  }
  validateStringArray(config.ompTools, "ompTools", /^[a-z][a-z0-9_-]{0,80}$/);
  if (config.ompTools.length === 0) throw new Error("Config ompTools cannot be empty for agent turns");
  const unknownTool = config.ompTools.find((tool) => !isKnownSuperAIToolCapability(tool));
  if (unknownTool) throw new Error(`Config ompTools contains unknown or unsafe capability ${unknownTool}`);
  validateEnvironmentNames(config.ompEnvAllowlist, "ompEnvAllowlist");
  const unsafeOmpEnvironment = config.ompEnvAllowlist.find(isUnsafeOmpEnvironmentName);
  if (unsafeOmpEnvironment) {
    throw new Error(`Config ompEnvAllowlist cannot expose OMP runtime-control variable ${unsafeOmpEnvironment}`);
  }
  if (config.ompIsolation?.mode !== "strict" || config.ompIsolation.rejectUntrustedExtensions !== true) {
    throw new Error("Config ompIsolation is invalid");
  }
  if (config.approvalMode !== "always-ask")
    throw new Error("Config approvalMode must be always-ask so every mutating OMP tool is visible to the approval boundary");
  if (typeof config.autoLearn !== "boolean") throw new Error("Config autoLearn must be boolean");
  assertInteger(config.persona?.intensity, "persona.intensity", 0, 3);
  if (!config.selfEvaluation || typeof config.selfEvaluation.enabled !== "boolean") throw new Error("Config selfEvaluation is invalid");
  assertInteger(config.selfEvaluation.retentionDays, "selfEvaluation.retentionDays", 1, 3_650);
  assertInteger(config.memory.recallLimit, "memory.recallLimit", 1, 50);
  assertInteger(config.memory.maxContextCharacters, "memory.maxContextCharacters", 2_000, 100_000);
  assertInteger(config.memory.halfLifeDays, "memory.halfLifeDays", 1, 3_650);
  if (!config.memory.episodic || typeof config.memory.episodic.enabled !== "boolean") throw new Error("Config memory.episodic is invalid");
  assertInteger(config.memory.episodic.retentionDays, "memory.episodic.retentionDays", 1, 3_650);
  assertInteger(config.memory.episodic.maxCharacters, "memory.episodic.maxCharacters", 600, 4_000);
  if (!config.fusion || typeof config.fusion.enabled !== "boolean") throw new Error("Config fusion is invalid");
  if (!["moa", "fusion"].includes(config.fusion.mode)) throw new Error("Config fusion.mode is invalid");
  validateStringArray(config.fusion.models, "fusion.models", /^[^\s/]+\/.{1,220}$/u);
  if (config.fusion.models.some((model) => !isModelSelector(model))) throw new Error("Config fusion.models contains an invalid provider/model selector");
  if (config.fusion.models.length > MAX_FUSION_PARTICIPANTS) throw new Error(`Config fusion.models accepts at most ${MAX_FUSION_PARTICIPANTS} participants`);
  if (config.fusion.enabled && config.fusion.models.length < 2) throw new Error("Enabled Fusion requires at least two consultant models");
  if (typeof config.fusion.synthesisModel !== "string" || (config.fusion.synthesisModel && !isModelSelector(config.fusion.synthesisModel)))
    throw new Error("Config fusion.synthesisModel is invalid");
  assertInteger(config.fusion.maxParallel, "fusion.maxParallel", 1, MAX_FUSION_PARTICIPANTS);
  assertInteger(config.fusion.candidateTimeoutMs, "fusion.candidateTimeoutMs", 10_000, 900_000);
  validateAdapter(config.adapters.browserUse, "adapters.browserUse");
  validateBrowserDomains(config.adapters.browserUse.allowedDomains, config.adapters.browserUse.enabled);
  validateAdapter(config.adapters.computerUse, "adapters.computerUse");
  return config;
}

function validateAdapter(adapter: { enabled: boolean; command: string; envAllowlist: string[] }, name: string): void {
  if (!adapter || typeof adapter.enabled !== "boolean" || typeof adapter.command !== "string") throw new Error(`Config ${name} is invalid`);
  if (adapter.enabled && !adapter.command.trim()) throw new Error(`Config ${name}.command is required when enabled`);
  validateEnvironmentNames(adapter.envAllowlist, `${name}.envAllowlist`);
}

function validateBrowserDomains(domains: string[], enabled: boolean): void {
  if (!Array.isArray(domains) || domains.length > 100 || new Set(domains).size !== domains.length)
    throw new Error("Config adapters.browserUse.allowedDomains is invalid");
  const pattern = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
  if (domains.some((domain) => typeof domain !== "string" || !pattern.test(domain)))
    throw new Error("Config adapters.browserUse.allowedDomains contains an invalid domain");
  if (enabled && domains.length === 0) throw new Error("Browser Use requires at least one allowed domain");
}

function validateEnvironmentNames(value: string[], name: string): void {
  validateStringArray(value, name, /^[A-Za-z_][A-Za-z0-9_()]{0,127}$/);
}

function isUnsafeOmpEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return (
    ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"].includes(normalized) ||
    normalized === "NEURALWATT_API_KEY" ||
    normalized.startsWith("OMP_") ||
    normalized.startsWith("PI_") ||
    normalized.startsWith("NODE_") ||
    normalized.startsWith("BUN_")
  );
}

function validateStringArray(value: string[], name: string, pattern: RegExp): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !pattern.test(item)))
    throw new Error(`Config ${name} contains an invalid value`);
  if (new Set(value).size !== value.length) throw new Error(`Config ${name} contains duplicates`);
}

function assertInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Config ${name} must be an integer between ${minimum} and ${maximum}`);
}

export function resolveOmpExecutable(configured: string): string {
  const projectRoot = findProjectRoot();
  if (configured !== "auto") return resolveTrustedExecutable(configured, { rejectRoots: [projectRoot] });
  const env = process.env.OMP_BIN;
  if (env) return resolveTrustedExecutable(env, { rejectRoots: [projectRoot] });
  const managed = managedOmpExecutablePath(projectRoot);
  if (existsSync(managed)) return resolveTrustedExecutable(managed, { rejectRoots: [] });
  if (process.platform === "win32") {
    const local = join(homedir(), "AppData", "Local", "omp", "omp.exe");
    if (existsSync(local)) return resolveTrustedExecutable(local, { rejectRoots: [projectRoot] });
    return resolveTrustedExecutable("omp.exe", { rejectRoots: [projectRoot] });
  }
  return resolveTrustedExecutable("omp", { rejectRoots: [projectRoot] });
}

/**
 * Provider integration no longer loads executable OMP extensions. Neuralwatt
 * is bridged natively through a generated, credential-free models.yml file.
 */
export function getProviderRuntimeArgs(_root = findProjectRoot()): string[] {
  return [];
}

export function getOmpIsolation(config: SuperAIConfig, root = findProjectRoot()): OmpIsolation | undefined {
  const paths = getPaths(root);
  return {
    homeDir: paths.ompHome,
    agentDir: paths.ompAgentDir,
    rejectUntrustedExtensions: config.ompIsolation.rejectUntrustedExtensions,
  };
}
