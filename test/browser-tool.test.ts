import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SuperAgent } from "../src/agent.js";
import { AuditLog } from "../src/audit.js";
import { MemoryStore } from "../src/memory/store.js";
import { SkillManager } from "../src/skills/manager.js";
import { SourceHub } from "../src/sources.js";
import type { HostTool, SuperAIConfig } from "../src/types.js";

test("browser sidecar receives the operator domain allowlist and requires approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-browser-tool-"));
  seedPromptFiles(root);
  const memory = new MemoryStore(join(root, ".superai", "state.db"));
  const fixture = resolve(process.cwd(), "test", "fixtures", "echo-adapter.mjs");
  const config: SuperAIConfig = {
    model: "fake/browser",
    fallbackModels: [],
    thinkingLevel: "high",
    ompExecutable: "unused",
    ompProfile: "",
    ompTools: ["read", "browser_task"],
    ompEnvAllowlist: [],
    ompIsolation: { mode: "strict", rejectUntrustedExtensions: true },
    approvalMode: "always-ask",
    autoLearn: false,
    persona: { intensity: 2 },
    selfEvaluation: { enabled: true, retentionDays: 365 },
    memory: { recallLimit: 8, maxContextCharacters: 12_000, halfLifeDays: 120, episodic: { enabled: false, retentionDays: 365, maxCharacters: 2_000 } },
    fusion: { enabled: false, mode: "fusion", models: [], synthesisModel: "", maxParallel: 3, candidateTimeoutMs: 180_000 },
    adapters: {
      browserUse: {
        enabled: true,
        command: `"${process.execPath}" "${fixture}"`,
        envAllowlist: ["BROWSER_USE_API_KEY", "OPENAI_API_KEY", "SUPERAI_BROWSER_MODEL"],
        allowedDomains: ["example.com", "*.openai.com"],
      },
      computerUse: { enabled: false, command: "", envAllowlist: [] },
    },
  };
  let tools: HostTool[] = [];
  let adapterPayload: Record<string, unknown> | undefined;
  let adapterEnvironment: Record<string, unknown> | undefined;
  let approvals = 0;
  const agent = new SuperAgent(
    root,
    config,
    "unused",
    memory,
    new SkillManager(root),
    new SourceHub(memory, root),
    new AuditLog(join(root, ".superai", "audit.jsonl")),
    () => ({
      approvedConsequentialAction: false,
      turnActive: false,
      start: async () => undefined,
      stop: async () => undefined,
      registerTools: async (registered) => {
        tools = registered;
      },
      prompt: async () => {
        const browser = tools.find((tool) => tool.name === "browser_task");
        assert.ok(browser);
        const result = await browser.execute({ task: "Read the public documentation" }, { toolCallId: "browser-call-1", signal: new AbortController().signal });
        adapterPayload = result.details?.received as Record<string, unknown>;
        adapterEnvironment = result.details?.environment as Record<string, unknown>;
        return { text: "browser complete", toolCalls: 1, consequentialApproval: true };
      },
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
    }),
  );

  try {
    const priorBrowserKey = process.env.BROWSER_USE_API_KEY;
    const priorOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.BROWSER_USE_API_KEY = "fake-browser-key";
    process.env.OPENAI_API_KEY = "fake-openai-key";
    try {
      const result = await agent.runTurn("Use the browser safely", {
        approve: async (description) => {
          approvals += 1;
          assert.match(description, /browser_task/);
          assert.match(description, /NOT AN OS SANDBOX/);
          assert.match(description, /Environment variable names exposed to the adapter=\["BROWSER_USE_API_KEY","SUPERAI_BROWSER_MODEL"\]/);
          assert.match(description, /domain allowlist is enforced by code you are trusting/i);
          assert.match(description, /example\.com.*openai\.com/);
          assert.ok(description.includes(process.execPath), "approval must show the pinned adapter executable");
          return true;
        },
      });
      assert.equal(result.text, "browser complete");
      assert.equal(approvals, 1);
      assert.deepEqual(adapterPayload?.allowed_domains, ["example.com", "*.openai.com"]);
      assert.equal(adapterPayload?.task, "Read the public documentation");
      assert.deepEqual(adapterEnvironment, { browserUseKey: "present", openAiKey: "absent" });
    } finally {
      if (priorBrowserKey === undefined) delete process.env.BROWSER_USE_API_KEY;
      else process.env.BROWSER_USE_API_KEY = priorBrowserKey;
      if (priorOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorOpenAiKey;
    }
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function seedPromptFiles(root: string): void {
  const directory = join(root, "agent");
  mkdirSync(directory, { recursive: true });
  for (const name of ["IDENTITY.md", "SOUL.md", "AGENTS.md", "TOOLS.md", "USER.md", "MEMORY_POLICY.md", "persona.md"]) {
    writeFileSync(join(directory, name), `# ${name}\nTest fixture.\n`, "utf8");
  }
}
