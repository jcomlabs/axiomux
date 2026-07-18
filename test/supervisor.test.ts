import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurnOptions, AgentTurnResult, SuperAgent } from "../src/agent.js";
import { TaskSupervisor, classifyUserUpdate } from "../src/runtime/supervisor.js";

test("steering classifier never interprets a negated Portuguese continue request as a stop", () => {
  assert.equal(classifyUserUpdate("não pares, acrescenta testes"), "steer"); // language-audit: allow-portuguese-input
  assert.equal(classifyUserUpdate("para agora"), "stop"); // language-audit: allow-portuguese-input
  assert.equal(classifyUserUpdate("/next documenta isto"), "follow_up"); // language-audit: allow-portuguese-input
  assert.equal(classifyUserUpdate("como vai?"), "status"); // language-audit: allow-portuguese-input
});

test("supervisor queues early input and steers without cancelling work", async () => {
  const steered: string[] = [];
  let preparedTaskId = "";
  let agentTaskId = "";
  const fake = {
    prepareTask(taskId: string): void {
      preparedTaskId = taskId;
    },
    async runTurn(_prompt: string, options: AgentTurnOptions): Promise<AgentTurnResult> {
      agentTaskId = options.taskId ?? "";
      await new Promise((resolve) => setTimeout(resolve, 20));
      options.onControl?.({
        turnId: "turn-1",
        steer: async (message) => {
          steered.push(message);
        },
        followUp: async () => undefined,
        stop: async () => undefined,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      options.onDelta?.("finished");
      options.onTrace?.({ at: new Date().toISOString(), kind: "verification", phase: "completed", label: "verified" });
      options.onControl?.(undefined);
      return {
        text: "finished",
        model: "fake/model",
        sessionId: options.sessionId ?? "session",
        recalledMemoryIds: [],
        toolCalls: 0,
        trace: [],
        turnId: "turn-1",
        ...(options.taskId ? { taskId: options.taskId } : {}),
      };
    },
  } as unknown as SuperAgent;
  const supervisor = new TaskSupervisor(fake);
  supervisor.subscribe(() => {
    throw new Error("UI listener failure");
  });
  const task = supervisor.start("work", { sessionId: "session-1" });
  assert.throws(
    () => supervisor.start("unsafe parallel edit", { sessionId: "session-2" }),
    /project already has active task/,
    "one project must not run two potentially mutating agents concurrently",
  );
  const update = await supervisor.send(task.id, "não pares, acrescenta testes"); // language-audit: allow-portuguese-input
  assert.equal(update.classification, "steer");
  assert.match(update.acknowledgement, /work continues/i);
  const result = await supervisor.wait(task.id);
  assert.equal(result.text, "finished");
  assert.deepEqual(steered, ["não pares, acrescenta testes"]); // language-audit: allow-portuguese-input
  assert.equal(supervisor.get(task.id)?.status, "completed");
  assert.equal(preparedTaskId, task.id);
  assert.equal(agentTaskId, task.id, "the supervisor and agent must share one task ID");
});

test("follow-up becomes a real subsequent task instead of being lost with the OMP process", async () => {
  const prompts: string[] = [];
  const prepared: Array<{ id: string; prompt: string }> = [];
  let resolveSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    resolveSecond = resolve;
  });
  const fake = {
    prepareTask(id: string, _sessionId: string, prompt: string): void {
      prepared.push({ id, prompt });
    },
    async runTurn(prompt: string, options: AgentTurnOptions): Promise<AgentTurnResult> {
      prompts.push(prompt);
      if (prompts.length === 2) resolveSecond();
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        text: prompt,
        model: "fake/model",
        sessionId: options.sessionId ?? "session",
        recalledMemoryIds: [],
        toolCalls: 0,
        trace: [],
        turnId: `turn-${prompts.length}`,
      };
    },
  } as unknown as SuperAgent;
  const supervisor = new TaskSupervisor(fake);
  const first = supervisor.start("first");
  const update = await supervisor.send(first.id, "/next second");
  assert.equal(update.classification, "follow_up");
  assert.deepEqual(
    prepared.map((item) => item.prompt),
    ["first", "second"],
    "the follow-up must be durably queued before the active task finishes",
  );
  await supervisor.wait(first.id);
  await secondStarted;
  assert.deepEqual(prompts, ["first", "second"]);
});

test("persisted task snapshots are visible after restart but never resumed", async () => {
  let runCalls = 0;
  const fake = {
    listPersistedTasks: () => [
      {
        id: "persisted-task",
        projectId: "project-1",
        sessionId: "session-old",
        title: "Interrupted work",
        prompt: "finish the interrupted work",
        status: "failed",
        output: "partial output",
        model: "fake/model",
        error: "Interrupted by process restart; execution was not resumed.",
        startedAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:01:00.000Z",
        completedAt: "2026-07-17T00:01:00.000Z",
      },
    ],
    async runTurn(): Promise<AgentTurnResult> {
      runCalls += 1;
      throw new Error("must not run");
    },
  } as unknown as SuperAgent;
  const supervisor = new TaskSupervisor(fake);

  const persisted = supervisor.listPersisted();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.id, "persisted-task");
  assert.equal(persisted[0]?.output, "partial output");
  assert.equal(supervisor.get("persisted-task")?.status, "failed");
  const status = await supervisor.send("persisted-task", "/status");
  assert.equal(status.classification, "status");
  await assert.rejects(supervisor.wait("persisted-task"), /not resumed after restart/);
  await assert.rejects(supervisor.send("persisted-task", "continue"), /not resumed after restart/);
  assert.equal(runCalls, 0);
});
