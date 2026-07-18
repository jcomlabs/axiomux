import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLog } from "../src/audit.js";
import { SuperAgent } from "../src/agent.js";
import { MemoryStore } from "../src/memory/store.js";
import { SkillManager } from "../src/skills/manager.js";
import { SourceHub } from "../src/sources.js";
import { TaskSupervisor } from "../src/runtime/supervisor.js";
import { canonicalWorkspaceRoot, createWorkspaceIdentity } from "../src/runtime/project-boundary.js";
import { WORKSPACE_HOST_TOOL_NAMES } from "../src/tools/names.js";
import type { HostTool, SuperAIConfig } from "../src/types.js";

const config: SuperAIConfig = {
  model: "fake/multi-project",
  fallbackModels: [],
  thinkingLevel: "high",
  ompExecutable: "unused",
  ompProfile: "",
  ompTools: ["read", "grep", "glob", "web_search", "todo"],
  ompEnvAllowlist: [],
  ompIsolation: { mode: "strict", rejectUntrustedExtensions: true },
  approvalMode: "always-ask",
  autoLearn: false,
  persona: { intensity: 0 },
  selfEvaluation: { enabled: false, retentionDays: 365 },
  memory: { recallLimit: 8, maxContextCharacters: 12_000, halfLifeDays: 120, episodic: { enabled: false, retentionDays: 365, maxCharacters: 2_000 } },
  fusion: { enabled: false, mode: "fusion", models: [], synthesisModel: "", maxParallel: 2, candidateTimeoutMs: 30_000 },
  adapters: {
    browserUse: { enabled: false, command: "", envAllowlist: [], allowedDomains: [] },
    computerUse: { enabled: false, command: "", envAllowlist: [] },
  },
};

test("two linked projects run concurrently while OMP and host tools stay in their selected roots", async () => {
  const installationRoot = mkdtempSync(join(tmpdir(), "superai-installation-"));
  const workspaceA = join(installationRoot, "fixtures", "workspace-a");
  const workspaceB = join(installationRoot, "fixtures", "workspace-b");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  seedPromptFiles(installationRoot);
  writeFileSync(join(workspaceA, "workspace.txt"), "alpha workspace", "utf8");
  writeFileSync(join(workspaceB, "workspace.txt"), "beta workspace", "utf8");
  const memory = new MemoryStore(join(installationRoot, ".superai", "state.db"));
  const skills = new SkillManager(installationRoot);
  const audit = new AuditLog(join(installationRoot, ".superai", "audit.jsonl"));
  const canonicalA = realpathSync.native(workspaceA);
  const canonicalB = realpathSync.native(workspaceB);
  const cwdSeen = new Set<string>();
  const isolationRoots = new Set<string>();
  let crossProjectResult = "";
  let arrived = 0;
  let release!: () => void;
  const rendezvous = new Promise<void>((resolve) => {
    release = resolve;
  });

  const makeAgent = (workspaceRoot: string, forbiddenRoot: string): SuperAgent =>
    new SuperAgent(
      installationRoot,
      config,
      "unused",
      memory,
      skills,
      new SourceHub(memory, workspaceRoot),
      audit,
      (options) => {
        cwdSeen.add(options.cwd);
        if (options.isolation) isolationRoots.add(options.isolation.agentDir);
        let tools: HostTool[] = [];
        return {
          approvedConsequentialAction: false,
          turnActive: false,
          start: async () => undefined,
          stop: async () => undefined,
          registerTools: async (value) => {
            tools = value;
          },
          prompt: async () => {
            arrived += 1;
            if (arrived === 2) release();
            await rendezvous;
            const read = tools.find((tool) => tool.name === WORKSPACE_HOST_TOOL_NAMES.read);
            assert.ok(read);
            const own = await read.execute({ path: "workspace.txt" }, { toolCallId: `read-${arrived}`, signal: new AbortController().signal });
            await assert.rejects(
              read.execute({ path: join(forbiddenRoot, "workspace.txt") }, { toolCallId: `escape-${arrived}`, signal: new AbortController().signal }),
              /escapes the workspace|outside the workspace|denied/i,
            );
            if (options.cwd === canonicalB) {
              const globalSearch = tools.find((tool) => tool.name === "project_search");
              assert.ok(globalSearch, "the explicitly global TUI option must expose cross-project search");
              crossProjectResult =
                (await globalSearch.execute({ query: "marsupial", limit: 10 }, { toolCallId: "cross-project-search", signal: new AbortController().signal }))
                  .content[0]?.text ?? "";
            }
            return { text: own.content[0]?.text ?? "", toolCalls: 1, consequentialApproval: false };
          },
          steer: async () => undefined,
          followUp: async () => undefined,
          abort: async () => undefined,
        };
      },
      { workspaceRoot },
    );

  const agentA = makeAgent(canonicalA, canonicalB);
  const agentB = makeAgent(canonicalB, canonicalA);
  assert.throws(
    () =>
      new SuperAgent(installationRoot, config, "unused", memory, skills, new SourceHub(memory, canonicalB), audit, undefined, { workspaceRoot: canonicalA }),
    /SourceHub workspace does not match/,
  );
  const supervisorA = new TaskSupervisor(agentA, agentA.projectId);
  const supervisorB = new TaskSupervisor(agentB, agentB.projectId);
  try {
    assert.equal(canonicalWorkspaceRoot(installationRoot, installationRoot), realpathSync.native(installationRoot));
    assert.equal(canonicalWorkspaceRoot(installationRoot, workspaceA), canonicalA);
    assert.throws(() => canonicalWorkspaceRoot(installationRoot, join(installationRoot, ".superai")), /private state|control\/state/i);
    assert.throws(() => canonicalWorkspaceRoot(installationRoot, tmpdir()), /cannot be a parent of the Axiomux installation/i);

    const privateMemoryId = memory.addMemory({
      content: "alpha-only project decision marsupial",
      kind: "evidence",
      reviewStatus: "approved",
      scope: agentA.memoryScope,
      sourceUri: "test://alpha-project",
      sourceLabel: "alpha",
    });
    const globalMemoryId = memory.addMemory({
      content: "global shared decision lighthouse",
      kind: "evidence",
      reviewStatus: "approved",
      scope: "global",
      sourceUri: "test://global",
      sourceLabel: "global",
    });
    assert.ok(memory.recall("marsupial", "scope-a", 10, agentA.memoryScope, false).some((item) => item.id === privateMemoryId));
    assert.equal(
      memory.recall("marsupial", "scope-b", 10, agentB.memoryScope, false).some((item) => item.id === privateMemoryId),
      false,
    );
    assert.ok(memory.recall("lighthouse", "scope-b", 10, agentB.memoryScope, false).some((item) => item.id === globalMemoryId));

    const taskA = supervisorA.start("read alpha", { sessionId: "session-alpha", crossProjectSearch: true });
    const taskB = supervisorB.start("read beta", { sessionId: "session-beta", crossProjectSearch: true });
    const [resultA, resultB] = await Promise.all([supervisorA.wait(taskA.id), supervisorB.wait(taskB.id)]);

    assert.match(resultA.text, /alpha workspace/);
    assert.match(resultB.text, /beta workspace/);
    assert.match(crossProjectResult, /alpha-only project decision marsupial/);
    assert.notEqual(agentA.projectId, agentB.projectId);
    assert.equal(supervisorA.get(taskA.id)?.projectId, agentA.projectId);
    assert.equal(supervisorB.get(taskB.id)?.projectId, agentB.projectId);
    assert.deepEqual(cwdSeen, new Set([canonicalA, canonicalB]));
    assert.equal(isolationRoots.size, 1, "all projects must share the central isolated OMP vault/harness");
    assert.match([...isolationRoots][0] ?? "", /\.superai[\\/]omp-runtime[\\/]agent$/u);
  } finally {
    memory.close();
    rmSync(installationRoot, { recursive: true, force: true });
  }
});

test("a cached agent and SourceHub reject a workspace replaced by a junction", async () => {
  const installationRoot = mkdtempSync(join(tmpdir(), "superai-root-swap-"));
  const workspace = join(installationRoot, "workspace");
  const replacement = join(installationRoot, "replacement");
  mkdirSync(workspace);
  mkdirSync(replacement);
  seedPromptFiles(installationRoot);
  writeFileSync(join(workspace, "visible.txt"), "original workspace", "utf8");
  writeFileSync(join(replacement, "visible.txt"), "replacement workspace must stay hidden", "utf8");
  const memory = new MemoryStore(join(installationRoot, ".superai", "state.db"));
  const skills = new SkillManager(installationRoot);
  const audit = new AuditLog(join(installationRoot, ".superai", "audit.jsonl"));
  const sources = new SourceHub(memory, workspace);
  let providerStarted = false;
  const agent = new SuperAgent(
    installationRoot,
    config,
    "unused",
    memory,
    skills,
    sources,
    audit,
    () => ({
      approvedConsequentialAction: false,
      turnActive: false,
      start: async () => {
        providerStarted = true;
      },
      stop: async () => undefined,
      registerTools: async () => undefined,
      prompt: async () => ({ text: "unexpected", toolCalls: 0, consequentialApproval: false }),
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
    }),
    { workspaceRoot: workspace },
  );
  agent.prepareTask("root-swap-task", "root-swap-session", "read visible.txt");

  try {
    rmSync(workspace, { recursive: true, force: true });
    symlinkSync(replacement, workspace, process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(sources.ingestFile("visible.txt"), /symbolic link|junction|identity changed|different physical path/i);
    await assert.rejects(
      agent.runTurn("read visible.txt", { taskId: "root-swap-task", sessionId: "root-swap-session" }),
      /symbolic link|junction|identity changed|different physical path/i,
    );
    assert.equal(providerStarted, false, "OMP must not start after the registered workspace identity changes");
    assert.equal(agent.getPersistedTask("root-swap-task")?.status, "failed", "a prepared task must not remain wedged after identity rejection");
  } finally {
    memory.close();
    rmSync(installationRoot, { recursive: true, force: true });
  }
});

test("project roots reject reserved control segments at every depth", () => {
  const installationRoot = mkdtempSync(join(tmpdir(), "superai-sensitive-root-"));
  try {
    for (const reserved of [".git", ".superai", "node_modules"]) {
      const candidate = join(installationRoot, "fixtures", reserved, "nested-project");
      mkdirSync(candidate, { recursive: true });
      assert.throws(() => canonicalWorkspaceRoot(installationRoot, candidate), new RegExp(`${reserved.replace(".", "\\.")}.*control/state segment`, "i"));
    }
  } finally {
    rmSync(installationRoot, { recursive: true, force: true });
  }
});

test("an npm-installed harness may bootstrap at its exact node_modules root only", () => {
  const packageParent = mkdtempSync(join(tmpdir(), "superai-package-root-"));
  const installationRoot = join(packageParent, "node_modules", "axiomux-agent");
  const nestedProject = join(installationRoot, "examples", "nested-project");
  mkdirSync(nestedProject, { recursive: true });
  try {
    const identity = createWorkspaceIdentity(installationRoot, installationRoot);
    assert.equal(identity.rootPath, realpathSync.native(installationRoot));
    assert.equal(canonicalWorkspaceRoot(installationRoot, installationRoot), identity.rootPath);
    assert.throws(() => canonicalWorkspaceRoot(installationRoot, nestedProject), /node_modules.*control\/state segment/i);
  } finally {
    rmSync(packageParent, { recursive: true, force: true });
  }
});

function seedPromptFiles(root: string): void {
  const directory = join(root, "agent");
  mkdirSync(directory, { recursive: true });
  for (const name of ["IDENTITY.md", "SOUL.md", "AGENTS.md", "TOOLS.md", "USER.md", "MEMORY_POLICY.md", "persona.md"]) {
    writeFileSync(join(directory, name), `# ${name}\nFixture.\n`, "utf8");
  }
}
