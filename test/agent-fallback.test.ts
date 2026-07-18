import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentTurnFailedError, SuperAgent } from "../src/agent.js";
import { AuditLog } from "../src/audit.js";
import { MemoryStore } from "../src/memory/store.js";
import { SkillManager } from "../src/skills/manager.js";
import { SourceHub } from "../src/sources.js";
import { RuntimeStore } from "../src/runtime/store.js";
import type { AgentTraceEvent, HostTool, SuperAIConfig } from "../src/types.js";

const config: SuperAIConfig = {
  model: "fake/primary",
  fallbackModels: ["fake/fallback"],
  thinkingLevel: "high",
  ompExecutable: "unused-in-fault-test",
  ompProfile: "",
  ompTools: ["read"],
  ompEnvAllowlist: [],
  ompIsolation: { mode: "strict", rejectUntrustedExtensions: true },
  approvalMode: "always-ask",
  autoLearn: false,
  persona: { intensity: 2 },
  selfEvaluation: { enabled: false, retentionDays: 365 },
  memory: { recallLimit: 8, maxContextCharacters: 12_000, halfLifeDays: 120, episodic: { enabled: false, retentionDays: 365, maxCharacters: 2_000 } },
  fusion: { enabled: false, mode: "fusion", models: [], synthesisModel: "", maxParallel: 3, candidateTimeoutMs: 180_000 },
  adapters: {
    browserUse: { enabled: false, command: "", envAllowlist: [], allowedDomains: [] },
    computerUse: { enabled: false, command: "", envAllowlist: [] },
  },
};

test("provider fallback is blocked after a consequential host effect completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-effect-fault-"));
  seedPromptFiles(root);
  const memory = new MemoryStore(join(root, ".superai", "state.db"));
  const skills = new SkillManager(root);
  const sources = new SourceHub(memory, root);
  const audit = new AuditLog(join(root, ".superai", "audit.jsonl"));
  const attempts: string[] = [];
  const traces: AgentTraceEvent[] = [];
  let registeredTools: HostTool[] = [];
  const agent = new SuperAgent(root, { ...config, ompTools: ["read", "write"] }, "unused-in-fault-test", memory, skills, sources, audit, (options) => {
    const model = options.model ?? "";
    attempts.push(model);
    return {
      approvedConsequentialAction: false,
      turnActive: false,
      start: async () => undefined,
      stop: async () => undefined,
      registerTools: async (tools) => {
        registeredTools = tools;
      },
      prompt: async () => {
        if (model === "fake/fallback") {
          return { text: "unsafe replay", toolCalls: 0, consequentialApproval: false };
        }
        const remember = registeredTools.find((tool) => tool.name === "memory_remember");
        assert.ok(remember, "memory_remember must be registered before the provider prompt");
        await remember.execute(
          { content: "effect completed before provider crash", label: "fault injection" },
          { toolCallId: "effect-before-crash", signal: new AbortController().signal },
        );
        throw new Error("injected provider crash after host effect");
      },
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
    };
  });

  try {
    await assert.rejects(agent.runTurn("exercise the post-effect failure path", { onTrace: (event) => traces.push(event) }), (error) => {
      assert.ok(error instanceof AgentTurnFailedError);
      assert.equal(error.effectsMayHaveOccurred, true);
      assert.match(error.message, /injected provider crash after host effect/);
      return true;
    });
    assert.deepEqual(attempts, ["fake/primary"], "the fallback provider must never be constructed or called");
    assert.equal(memory.stats().total, 1, "the completed effect happened exactly once");
    assert.equal(memory.stats().pending, 1);
    assert.ok(traces.some((event) => event.kind === "provider" && event.phase === "failed" && /blocked by side-effect ledger/.test(event.detail ?? "")));
    const [persisted] = agent.listPersistedTasks();
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.prompt, "exercise the post-effect failure path");
    assert.equal(persisted?.model, "fake/primary");
    assert.match(persisted?.error ?? "", /injected provider crash after host effect/);
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent persists the supervisor task ID, streamed output and terminal result", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-persist-task-"));
  seedPromptFiles(root);
  const memory = new MemoryStore(join(root, ".superai", "state.db"));
  let providerAttempts = 0;
  const agent = new SuperAgent(
    root,
    config,
    "unused-in-persistence-test",
    memory,
    new SkillManager(root),
    new SourceHub(memory, root),
    new AuditLog(join(root, ".superai", "audit.jsonl")),
    () => {
      providerAttempts += 1;
      return {
        approvedConsequentialAction: false,
        turnActive: false,
        start: async () => undefined,
        stop: async () => undefined,
        registerTools: async () => undefined,
        prompt: async (_message, onDelta) => {
          onDelta?.("persisted ");
          onDelta?.("answer");
          return { text: "persisted answer", toolCalls: 0, consequentialApproval: false };
        },
        steer: async () => undefined,
        followUp: async () => undefined,
        abort: async () => undefined,
      };
    },
  );

  try {
    const taskId = "supervisor-task-1";
    const sessionId = "session-persistence";
    const prompt = "persist this complete task";
    agent.prepareTask(taskId, sessionId, prompt);
    assert.equal(agent.listPersistedTasks(sessionId)[0]?.status, "queued");

    const result = await agent.runTurn(prompt, {
      taskId,
      sessionId,
      onDelta: () => {
        throw new Error("observer delta failure");
      },
      onTrace: () => {
        throw new Error("observer trace failure");
      },
      onControl: () => {
        throw new Error("observer control failure");
      },
    });
    assert.equal(result.taskId, taskId);
    const [persisted] = agent.listPersistedTasks(sessionId);
    assert.equal(persisted?.id, taskId);
    assert.equal(persisted?.prompt, prompt);
    assert.equal(persisted?.output, "persisted answer");
    assert.equal(persisted?.model, "fake/primary");
    assert.equal(persisted?.status, "completed");
    assert.equal(persisted?.error, undefined);
    assert.ok(persisted?.turnId);
    assert.ok(persisted?.completedAt);
    assert.equal(providerAttempts, 1, "observer failures must never trigger fallback or replay");
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("response language guides provider prose without rewriting exact output", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-response-language-"));
  seedPromptFiles(root);
  const memory = new MemoryStore(join(root, ".superai", "state.db"));
  const systemPrompts: string[] = [];
  const exactProviderOutput = "Result: run `npm test`.\nERROR E42 at C:\\workspace\\app.ts";
  const agent = new SuperAgent(
    root,
    config,
    "unused-in-language-test",
    memory,
    new SkillManager(root),
    new SourceHub(memory, root),
    new AuditLog(join(root, ".superai", "audit.jsonl")),
    (options) => {
      systemPrompts.push(options.systemPrompt ?? "");
      return {
        approvedConsequentialAction: false,
        turnActive: false,
        start: async () => undefined,
        stop: async () => undefined,
        registerTools: async () => undefined,
        prompt: async () => ({ text: exactProviderOutput, toolCalls: 0, consequentialApproval: false }),
        steer: async () => undefined,
        followUp: async () => undefined,
        abort: async () => undefined,
      };
    },
  );

  try {
    const portuguese = await agent.runTurn("Explain the result", { sessionId: "language-pt", responseLanguage: "pt" });
    const english = await agent.runTurn("Explain the result", { sessionId: "language-en", responseLanguage: "en" });
    assert.equal(portuguese.text, exactProviderOutput);
    assert.equal(english.text, exactProviderOutput);
    assert.match(systemPrompts[0] ?? "", /European Portuguese \(pt-PT\)/u);
    assert.match(systemPrompts[0] ?? "", /Preserve code blocks/u);
    assert.match(systemPrompts[0] ?? "", /explicitly requests a different response language/u);
    assert.match(systemPrompts[1] ?? "", /natural-language prose in English/u);
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing Neuralwatt credential fails only that provider and permits a non-Neuralwatt fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-neuralwatt-fallback-"));
  const previousCredential = process.env.NEURALWATT_API_KEY;
  delete process.env.NEURALWATT_API_KEY;
  seedPromptFiles(root);
  const modelDirectory = join(root, ".superai", "omp-runtime", "agent");
  mkdirSync(modelDirectory, { recursive: true });
  writeFileSync(
    join(modelDirectory, "models.yml"),
    "# Generated by SUPERAI. Contains no credential; the key is supplied through an encrypted runtime vault.\nproviders: {}\n",
    "utf8",
  );
  const memory = new MemoryStore(join(root, ".superai", "state.db"));
  const attempts: Array<{ model: string; leakedKey: boolean }> = [];
  const neuralwattFirst: SuperAIConfig = {
    ...config,
    model: "neuralwatt/vendor-model",
    fallbackModels: ["fake/fallback"],
  };
  const agent = new SuperAgent(
    root,
    neuralwattFirst,
    "unused-in-neuralwatt-fallback-test",
    memory,
    new SkillManager(root),
    new SourceHub(memory, root),
    new AuditLog(join(root, ".superai", "audit.jsonl")),
    (options) => {
      attempts.push({ model: options.model ?? "", leakedKey: Boolean(options.environmentOverrides?.NEURALWATT_API_KEY) });
      return {
        approvedConsequentialAction: false,
        turnActive: false,
        start: async () => undefined,
        stop: async () => undefined,
        registerTools: async () => undefined,
        prompt: async () => ({ text: "fallback succeeded", toolCalls: 0, consequentialApproval: false }),
        steer: async () => undefined,
        followUp: async () => undefined,
        abort: async () => undefined,
      };
    },
  );

  try {
    const result = await agent.runTurn("use a safe fallback");
    assert.equal(result.model, "fake/fallback");
    assert.deepEqual(attempts, [{ model: "fake/fallback", leakedKey: false }]);
  } finally {
    if (previousCredential === undefined) delete process.env.NEURALWATT_API_KEY;
    else process.env.NEURALWATT_API_KEY = previousCredential;
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful turns persist a bounded reviewable self-evaluation without prompts or answers", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-self-evaluation-"));
  seedPromptFiles(root);
  const memory = new MemoryStore(join(root, ".superai", "state.db"));
  const agent = new SuperAgent(
    root,
    { ...config, selfEvaluation: { enabled: true, retentionDays: 30 } },
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
      registerTools: async () => undefined,
      prompt: async () => ({ text: "PRIVATE ANSWER MUST NOT BE STORED", toolCalls: 2, consequentialApproval: false }),
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
    }),
  );
  try {
    const result = await agent.runTurn("PRIVATE PROMPT MUST NOT BE STORED");
    const evaluationId = result.selfEvaluationMemoryId;
    assert.ok(evaluationId);
    const evaluation = memory.getMemory(evaluationId);
    assert.match(evaluation?.content ?? "", /What went well:/);
    assert.match(evaluation?.content ?? "", /What to improve:/);
    assert.doesNotMatch(evaluation?.content ?? "", /PRIVATE PROMPT|PRIVATE ANSWER/);
    assert.equal(evaluation?.reviewStatus, "pending");
    assert.match(evaluation?.sourceUri ?? "", /^self-evaluation:\/\/task\//);
    assert.ok(evaluation?.expiresAt);
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-evaluation sink failure never replays or invalidates an accepted response", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-self-evaluation-failure-"));
  seedPromptFiles(root);
  const memory = new MemoryStore(join(root, ".superai", "state.db"));
  let providerAttempts = 0;
  const agent = new SuperAgent(
    root,
    { ...config, selfEvaluation: { enabled: true, retentionDays: 30 } },
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
      registerTools: async () => undefined,
      prompt: async () => {
        providerAttempts += 1;
        return { text: "accepted", toolCalls: 0, consequentialApproval: false };
      },
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
    }),
  );
  const originalAdd = memory.addMemory.bind(memory);
  (memory as unknown as { addMemory: typeof memory.addMemory }).addMemory = () => {
    throw new Error("self-evaluation sink unavailable");
  };
  try {
    const result = await agent.runTurn("complete once");
    assert.equal(result.text, "accepted");
    assert.equal(result.selfEvaluationMemoryId, undefined);
    assert.equal(providerAttempts, 1);
  } finally {
    (memory as unknown as { addMemory: typeof memory.addMemory }).addMemory = originalAdd;
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepted turns create a bounded redacted project-scoped episodic summary without another model call", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-episodic-summary-"));
  seedPromptFiles(root);
  const memory = new MemoryStore(join(root, ".superai", "state.db"));
  let providerAttempts = 0;
  const syntheticSecret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
  const episodicConfig: SuperAIConfig = {
    ...config,
    memory: {
      ...config.memory,
      episodic: { enabled: true, retentionDays: 30, maxCharacters: 800 },
    },
  };
  const agent = new SuperAgent(
    root,
    episodicConfig,
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
      registerTools: async () => undefined,
      prompt: async () => {
        providerAttempts += 1;
        return { text: `EPISODIC_ANSWER ${"answer ".repeat(300)} ${syntheticSecret}`, toolCalls: 1, consequentialApproval: false };
      },
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
    }),
  );
  try {
    const result = await agent.runTurn(`EPISODIC_REQUEST ${"request ".repeat(300)} password=do-not-store-this`, { sessionId: "episodic-session" });
    assert.equal(providerAttempts, 1, "episodic extraction must not call a second model");
    const episodicMemoryId = result.episodicMemoryId;
    assert.ok(episodicMemoryId);
    const episode = memory.getMemory(episodicMemoryId);
    assert.equal(episode?.scope, agent.projectId);
    assert.equal(episode?.reviewStatus, "pending");
    assert.equal(episode?.kind, "evidence");
    assert.match(episode?.sourceUri ?? "", /^episodic:\/\/session\/episodic-session\/turn\//u);
    assert.match(episode?.content ?? "", /EPISODIC_REQUEST/u);
    assert.match(episode?.content ?? "", /EPISODIC_ANSWER/u);
    assert.doesNotMatch(episode?.content ?? "", /do-not-store-this|sk-proj-/u);
    assert.ok((episode?.content.length ?? Infinity) <= 800);
    assert.ok(episode?.expiresAt);
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session and request model choices are exact and never inherit global fallbacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-exact-routing-"));
  seedPromptFiles(root);
  const memory = new MemoryStore(join(root, ".superai", "state.db"));
  const runtime = new RuntimeStore(memory.database);
  const project = runtime.ensureProject(root);
  const sessionId = "session-exact-routing";
  runtime.attachSession(project.id, sessionId, "Exact routing");
  runtime.setSessionPreferredModel(sessionId, "fake/session-choice");
  const attempts: string[] = [];
  const traces: AgentTraceEvent[] = [];
  let fail = false;
  const exactRoutingConfig: SuperAIConfig = {
    ...config,
    fusion: {
      ...config.fusion,
      enabled: true,
      mode: "fusion",
      models: ["fake/panel-a", "neuralwatt/panel-b"],
      synthesisModel: "fake/judge",
    },
  };
  const agent = new SuperAgent(
    root,
    exactRoutingConfig,
    "unused",
    memory,
    new SkillManager(root),
    new SourceHub(memory, root),
    new AuditLog(join(root, ".superai", "audit.jsonl")),
    (options) => {
      attempts.push(options.model ?? "");
      return {
        approvedConsequentialAction: false,
        turnActive: false,
        start: async () => undefined,
        stop: async () => undefined,
        registerTools: async () => undefined,
        prompt: async () => {
          if (fail) throw new Error("exact route failed");
          return { text: "exact", toolCalls: 0, consequentialApproval: false };
        },
        steer: async () => undefined,
        followUp: async () => undefined,
        abort: async () => undefined,
      };
    },
  );
  try {
    assert.equal((await agent.runTurn("session route", { sessionId, onTrace: (event) => traces.push(event) })).model, "fake/session-choice");
    assert.equal(
      (await agent.runTurn("request route", { sessionId, model: "fake/request-choice", onTrace: (event) => traces.push(event) })).model,
      "fake/request-choice",
    );
    fail = true;
    await assert.rejects(agent.runTurn("do not fallback", { sessionId, onTrace: (event) => traces.push(event) }), /exact route failed/);
    assert.deepEqual(attempts, ["fake/session-choice", "fake/request-choice", "fake/session-choice"]);
    assert.ok(traces.some((event) => event.label === "Fusion skipped for exact model route"));
    assert.ok(!traces.some((event) => event.label === "Multi-model advisory panel completed"));
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function seedPromptFiles(root: string): void {
  const agentDirectory = join(root, "agent");
  mkdirSync(agentDirectory, { recursive: true });
  for (const name of ["IDENTITY.md", "SOUL.md", "AGENTS.md", "TOOLS.md", "USER.md", "MEMORY_POLICY.md", "persona.md"]) {
    writeFileSync(join(agentDirectory, name), `# ${name}\nTest fixture.\n`, "utf8");
  }
}
