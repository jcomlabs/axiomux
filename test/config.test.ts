import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, saveConfig, validateConfig } from "../src/config.js";
import type { SuperAIConfig } from "../src/types.js";

const valid: SuperAIConfig = {
  model: "provider/model",
  fallbackModels: [],
  thinkingLevel: "high",
  ompExecutable: "omp",
  ompProfile: "",
  ompTools: ["read"],
  ompEnvAllowlist: [],
  ompIsolation: { mode: "strict", rejectUntrustedExtensions: true },
  approvalMode: "always-ask",
  autoLearn: true,
  persona: { intensity: 2 },
  selfEvaluation: { enabled: true, retentionDays: 365 },
  memory: { recallLimit: 8, maxContextCharacters: 12_000, halfLifeDays: 120, episodic: { enabled: true, retentionDays: 365, maxCharacters: 2_000 } },
  fusion: { enabled: false, mode: "fusion", models: [], synthesisModel: "", maxParallel: 3, candidateTimeoutMs: 180_000 },
  adapters: {
    browserUse: { enabled: false, command: "", envAllowlist: [], allowedDomains: [] },
    computerUse: { enabled: false, command: "", envAllowlist: [] },
  },
};

test("configuration rejects unsafe or malformed runtime values", () => {
  assert.equal(validateConfig(structuredClone(valid)).model, "provider/model");
  assert.throws(() => validateConfig({ ...structuredClone(valid), ompTools: [] }), /cannot be empty/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), ompTools: ["lsp"] }), /unknown or unsafe capability lsp/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), ompTools: ["browser"] }), /unknown or unsafe capability browser/);
  assert.throws(
    () => validateConfig({ ...structuredClone(valid), ompIsolation: { mode: "shared", rejectUntrustedExtensions: true } } as unknown as SuperAIConfig),
    /ompIsolation/,
  );
  assert.throws(() => validateConfig({ ...structuredClone(valid), ompIsolation: { mode: "strict", rejectUntrustedExtensions: false } }), /ompIsolation/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), approvalMode: "write" } as unknown as SuperAIConfig), /always-ask/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), approvalMode: "yolo" } as unknown as SuperAIConfig), /approvalMode/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), ompEnvAllowlist: ["*"] }), /invalid value/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), ompProfile: "personal" }), /must be empty/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), ompEnvAllowlist: ["PI_CONFIG_DIR"] }), /runtime-control variable/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), ompEnvAllowlist: ["NODE_OPTIONS"] }), /runtime-control variable/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), ompEnvAllowlist: ["HOME"] }), /runtime-control variable/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), ompEnvAllowlist: ["NEURALWATT_API_KEY"] }), /runtime-control variable/);
  assert.throws(
    () => validateConfig({ ...structuredClone(valid), fallbackModels: Array.from({ length: 9 }, (_, index) => `provider/fallback-${index}`) }),
    /at most 8/,
  );
  assert.throws(() => validateConfig({ ...structuredClone(valid), fallbackModels: [valid.model] }), /cannot repeat the primary model/);
  assert.throws(
    () =>
      validateConfig({ ...structuredClone(valid), fusion: { ...valid.fusion, models: Array.from({ length: 9 }, (_, index) => `provider/panel-${index}`) } }),
    /at most 8/,
  );
  assert.throws(() => validateConfig({ ...structuredClone(valid), fusion: { ...valid.fusion, synthesisModel: "not-a-selector" } }), /synthesisModel/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), memory: { ...valid.memory, halfLifeDays: 0 } }), /halfLifeDays/);
  assert.throws(
    () => validateConfig({ ...structuredClone(valid), memory: { ...valid.memory, episodic: { ...valid.memory.episodic, maxCharacters: 500 } } }),
    /episodic.maxCharacters/,
  );
  assert.throws(() => validateConfig({ ...structuredClone(valid), persona: { intensity: 4 } } as unknown as SuperAIConfig), /persona.intensity/);
  assert.throws(() => validateConfig({ ...structuredClone(valid), selfEvaluation: { enabled: true, retentionDays: 0 } }), /selfEvaluation.retentionDays/);
  assert.throws(
    () => validateConfig({ ...structuredClone(valid), adapters: { ...valid.adapters, computerUse: { enabled: true, command: "", envAllowlist: [] } } }),
    /command is required/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...structuredClone(valid),
        adapters: { ...valid.adapters, browserUse: { enabled: true, command: "browser", envAllowlist: [], allowedDomains: [] } },
      }),
    /at least one allowed domain/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...structuredClone(valid),
        adapters: { ...valid.adapters, browserUse: { enabled: true, command: "browser", envAllowlist: [], allowedDomains: ["127.0.0.1"] } },
      }),
    /invalid domain/,
  );
  const browser = structuredClone(valid);
  browser.adapters.browserUse = { enabled: true, command: "browser", envAllowlist: [], allowedDomains: ["example.com", "*.openai.com"] };
  assert.deepEqual(validateConfig(browser).adapters.browserUse.allowedDomains, ["example.com", "*.openai.com"]);
});

test("saving a change never persists temporary environment overrides", (context) => {
  const root = mkdtempSync(join(tmpdir(), "superai-config-env-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "default.json"), `${JSON.stringify(valid, null, 2)}\n`);
  context.after(() => {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const overrides = new Map([
    ["SUPERAI_MODEL", "temporary/model"],
    ["SUPERAI_FALLBACK_MODELS", "temporary/fallback"],
    ["SUPERAI_OMP", "temporary-omp"],
    ["SUPERAI_OMP_ENV_ALLOWLIST", "SAFE_TEMPORARY_VALUE"],
  ]);
  const previousEnvironment = new Map([...overrides].map(([name]) => [name, process.env[name]]));
  for (const [name, value] of overrides) process.env[name] = value;

  const effective = loadConfig(root);
  assert.equal(effective.model, "temporary/model");
  effective.persona.intensity = 3;
  saveConfig(effective, root);

  const persisted = JSON.parse(readFileSync(join(root, ".superai", "config.json"), "utf8")) as SuperAIConfig;
  assert.equal(persisted.model, valid.model);
  assert.deepEqual(persisted.fallbackModels, valid.fallbackModels);
  assert.equal(persisted.ompExecutable, valid.ompExecutable);
  assert.deepEqual(persisted.ompEnvAllowlist, valid.ompEnvAllowlist);
  assert.equal(persisted.persona.intensity, 3);
});
