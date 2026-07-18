import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SuperAgent } from "../src/agent.js";
import { AuditLog } from "../src/audit.js";
import { MemoryStore } from "../src/memory/store.js";
import { SkillManager } from "../src/skills/manager.js";
import { SourceHub } from "../src/sources.js";
import { WORKSPACE_HOST_TOOL_NAMES } from "../src/tools/names.js";
import type { AgentTraceEvent, HostTool, SuperAIConfig } from "../src/types.js";

const config: SuperAIConfig = {
  model: "fake/host-tools",
  fallbackModels: [],
  thinkingLevel: "high",
  ompExecutable: "unused",
  ompProfile: "",
  ompTools: ["read", "grep", "glob", "edit", "write", "bash", "python", "web_search", "todo", "browser_task"],
  ompEnvAllowlist: [],
  ompIsolation: { mode: "strict", rejectUntrustedExtensions: true },
  approvalMode: "always-ask",
  autoLearn: false,
  persona: { intensity: 2 },
  selfEvaluation: { enabled: true, retentionDays: 365 },
  memory: { recallLimit: 8, maxContextCharacters: 12_000, halfLifeDays: 120, episodic: { enabled: false, retentionDays: 365, maxCharacters: 2_000 } },
  fusion: { enabled: false, mode: "fusion", models: [], synthesisModel: "", maxParallel: 3, candidateTimeoutMs: 180_000 },
  adapters: {
    browserUse: { enabled: false, command: "", envAllowlist: [], allowedDomains: [] },
    computerUse: { enabled: false, command: "", envAllowlist: [] },
  },
};

test("agent partitions native tools, governs host access and cannot ingest secrets through SourceHub", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-agent-host-tools-"));
  seedPromptFiles(root);
  writeFileSync(join(root, "public.txt"), "public workspace evidence", "utf8");
  writeFileSync(join(root, "credentials.json"), "SUPER_SECRET_DO_NOT_RECALL", "utf8");
  const memory = new MemoryStore(join(root, ".superai", "state.db"));
  const auditPath = join(root, ".superai", "audit.jsonl");
  let registered: HostTool[] = [];
  let providerPrompt = "";
  let nativeTools: string[] | undefined;
  const traces: AgentTraceEvent[] = [];
  let approvals = 0;
  const agent = new SuperAgent(root, config, "unused", memory, new SkillManager(root), new SourceHub(memory, root), new AuditLog(auditPath), (options) => {
    nativeTools = options.tools;
    return {
      approvedConsequentialAction: false,
      turnActive: false,
      start: async () => undefined,
      stop: async () => undefined,
      registerTools: async (tools) => {
        registered = tools;
      },
      prompt: async (message) => {
        providerPrompt = message;
        const read = requiredTool(registered, WORKSPACE_HOST_TOOL_NAMES.read);
        assert.match((await read.execute({ path: "public.txt" }, toolContext("read-public"))).content[0]?.text ?? "", /public workspace evidence/);

        const source = requiredTool(registered, "source_ingest");
        await assert.rejects(
          source.execute({ source: "https://example.com/path?payload=hidden" }, toolContext("source-hidden-query")),
          /refuses URL userinfo, query strings and fragments/,
        );
        await assert.rejects(source.execute({ source: "credentials.json" }, toolContext("source-secret")), /Sensitive path denied/i);
        const recall = requiredTool(registered, "memory_recall");
        const recalled = await recall.execute({ query: "SUPER_SECRET_DO_NOT_RECALL" }, toolContext("recall-secret"));
        assert.match(recalled.content[0]?.text ?? "", /No relevant memory found/);

        const remember = requiredTool(registered, "memory_remember");
        await assert.rejects(remember.execute({ content: "x", label: "x", unexpected: "flood" }, toolContext("extra-key")), /Unexpected tool argument/);
        await assert.rejects(recall.execute({ query: "x".repeat(4_001) }, toolContext("oversize-query")), /exceeds 4000/);
        return { text: "host boundary verified", toolCalls: 5, consequentialApproval: true };
      },
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
    };
  });

  try {
    const result = await agent.runTurn("verify host tools", {
      workflowIdempotencyKey: "workflow:host-boundary:1",
      approve: async () => {
        approvals += 1;
        return true;
      },
      onTrace: (event) => traces.push(event),
    });
    assert.equal(result.text, "host boundary verified");
    assert.equal(providerPrompt, "verify host tools", "workflow keys must never enter the provider prompt");
    assert.deepEqual(nativeTools, ["web_search", "todo"]);
    const names = registered.map((tool) => tool.name);
    for (const name of [...Object.values(WORKSPACE_HOST_TOOL_NAMES), "memory_recall", "memory_remember", "skill_propose", "source_ingest"]) {
      assert.ok(names.includes(name), `${name} must be a host tool`);
    }
    assert.equal(names.includes("browser_task"), false, "disabled adapters are not exposed even when their capability is selected");
    assert.equal(names.includes("computer_use"), false);
    assert.equal(approvals, 1, "source ingestion requires explicit approval before its governed read");
    const persistedMemories = memory.listMemories(undefined, 50);
    assert.equal(
      persistedMemories.some((item) => /SUPER_SECRET_DO_NOT_RECALL|credentials\.json/u.test(`${item.content}\n${item.sourceUri}`)),
      false,
      "secret ingestion and malformed mutation cannot persist memory",
    );
    assert.ok(
      persistedMemories.every((item) => item.sourceUri.startsWith("self-evaluation://")),
      "only the governed operational self-evaluation may be added by this turn",
    );
    assert.ok(traces.some((event) => event.detail?.includes("workflow_key=workflow:host-boundary:1")));
    const audit = readFileSync(auditPath, "utf8");
    assert.match(audit, /"action":"workspace.read"/);
    assert.match(audit, /workflow:host-boundary:1/);
    assert.doesNotMatch(audit, /public workspace evidence|SUPER_SECRET_DO_NOT_RECALL/);
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the read profile exposes recall but no persistent proposal tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-agent-read-profile-"));
  seedPromptFiles(root);
  const memory = new MemoryStore(join(root, ".superai", "state.db"));
  let names: string[] = [];
  const agent = new SuperAgent(
    root,
    { ...config, ompTools: ["read", "grep", "glob", "web_search", "todo"] },
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
      registerTools: async (tools) => {
        names = tools.map((tool) => tool.name);
      },
      prompt: async () => ({ text: "read profile checked", toolCalls: 0, consequentialApproval: false }),
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
    }),
  );
  try {
    await agent.runTurn("inspect only");
    assert.ok(names.includes("memory_recall"));
    for (const name of [
      "memory_remember",
      "skill_propose",
      "source_ingest",
      WORKSPACE_HOST_TOOL_NAMES.edit,
      WORKSPACE_HOST_TOOL_NAMES.write,
      WORKSPACE_HOST_TOOL_NAMES.bash,
      WORKSPACE_HOST_TOOL_NAMES.python,
    ]) {
      assert.equal(names.includes(name), false, `${name} must not be exposed by the read profile`);
    }
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function requiredTool(tools: HostTool[], name: string): HostTool {
  const result = tools.find((tool) => tool.name === name);
  assert.ok(result, `missing ${name}`);
  return result;
}

function toolContext(toolCallId: string): { toolCallId: string; signal: AbortSignal } {
  return { toolCallId, signal: new AbortController().signal };
}

function seedPromptFiles(root: string): void {
  const directory = join(root, "agent");
  mkdirSync(directory, { recursive: true });
  for (const name of ["IDENTITY.md", "SOUL.md", "AGENTS.md", "TOOLS.md", "USER.md", "MEMORY_POLICY.md", "persona.md"]) {
    writeFileSync(join(directory, name), `# ${name}\nTest fixture.\n`, "utf8");
  }
}
