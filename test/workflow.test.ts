import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { UnknownWorkflowEffectError, WorkflowEngine, hashWorkflowDefinition, type WorkflowDefinition } from "../src/workflow.js";

test("workflow persists a pause and resumes without repeating completed work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-workflow-"));
  let agentCalls = 0;
  let approvals = 0;
  try {
    const runtime = {
      runAgent: async (prompt: string) => {
        agentCalls += 1;
        return `done:${prompt}`;
      },
      requestApproval: async () => {
        approvals += 1;
        return approvals > 1;
      },
      remember: async () => 42,
    };
    const definition: WorkflowDefinition = {
      id: "durable",
      title: "Durable test",
      steps: [
        { id: "inspect", type: "agent", prompt: "inspect" },
        { id: "gate", type: "approval", prompt: "continue?" },
        { id: "record", type: "memory", content: "verified", label: "test" },
      ],
    };
    const first = await new WorkflowEngine(directory, runtime).run(definition);
    assert.equal(first.status, "paused");
    assert.equal(first.cursor, 1);
    const second = await new WorkflowEngine(directory, runtime).run(definition);
    assert.equal(second.status, "completed");
    assert.equal(agentCalls, 1);
    assert.deepEqual(second.outputs.record, { memoryId: 42 });
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("workflow file lock prevents concurrent engines from duplicating an agent effect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-workflow-lock-"));
  let effectCalls = 0;
  let announceStarted!: () => void;
  let releaseEffect!: () => void;
  const started = new Promise<void>((resolveStarted) => {
    announceStarted = resolveStarted;
  });
  const hold = new Promise<void>((resolveHold) => {
    releaseEffect = resolveHold;
  });
  const definition: WorkflowDefinition = {
    id: "exclusive-run",
    title: "Exclusive workflow run",
    steps: [{ id: "effect", type: "agent", prompt: "perform once", retries: 0 }],
  };
  const runtime = {
    runAgent: async () => {
      effectCalls += 1;
      announceStarted();
      await hold;
      return "done";
    },
    requestApproval: async () => true,
    remember: async () => 1,
  };
  try {
    const first = new WorkflowEngine(directory, runtime).run(definition);
    await started;
    await assert.rejects(new WorkflowEngine(directory, runtime).run(definition), /already locked by active process/);
    assert.equal(effectCalls, 1);
    releaseEffect();
    assert.equal((await first).status, "completed");
    assert.equal(effectCalls, 1);
    assert.equal(existsSync(join(directory, "exclusive-run.lock")), false);
  } finally {
    releaseEffect?.();
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("workflow does not silently skip a step after its retry budget is exhausted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-workflow-"));
  let calls = 0;
  try {
    const engine = new WorkflowEngine(directory, {
      runAgent: async () => {
        calls += 1;
        throw new Error("still broken");
      },
      requestApproval: async () => true,
      remember: async () => 1,
    });
    const definition: WorkflowDefinition = {
      id: "exhausted",
      title: "Exhausted retry",
      steps: [{ id: "fragile", type: "agent", prompt: "run", retries: 1 }],
    };
    assert.equal((await engine.run(definition)).status, "failed");
    const resumed = await engine.run(definition);
    assert.equal(resumed.status, "failed");
    assert.match(resumed.error ?? "", /Retry budget exhausted/);
    assert.equal(calls, 2);
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("workflow ids reject path-like names instead of normalizing collisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-workflow-"));
  try {
    const engine = new WorkflowEngine(directory, {
      runAgent: async () => "ok",
      requestApproval: async () => true,
      remember: async () => 1,
    });
    await assert.rejects(engine.run({ id: "../collision", title: "Bad", steps: [{ id: "x", type: "agent", prompt: "run" }] }), /Workflow id/);
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("workflow binds a canonical definition hash and rejects drift without mutating state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-workflow-"));
  let calls = 0;
  try {
    const engine = new WorkflowEngine(directory, {
      runAgent: async () => {
        calls += 1;
        return "ok";
      },
      requestApproval: async () => true,
      remember: async () => 1,
    });
    const definition: WorkflowDefinition = {
      id: "definition-drift",
      title: "Bound definition",
      steps: [{ id: "work", type: "agent", prompt: "original", retries: 0 }],
    };
    const completed = await engine.run(definition);
    assert.equal(completed.definitionHash, hashWorkflowDefinition(definition));
    assert.match(completed.definitionHash ?? "", /^[a-f0-9]{64}$/);
    const statePath = join(directory, "definition-drift.json");
    const persistedBeforeDrift = readFileSync(statePath, "utf8");

    await assert.rejects(engine.run({ ...definition, steps: [{ id: "work", type: "agent", prompt: "changed", retries: 0 }] }), /definition drift detected/i);
    assert.equal(readFileSync(statePath, "utf8"), persistedBeforeDrift);
    assert.equal(calls, 1);
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("a process crash after an agent effect leaves started journal state and never auto-replays", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-workflow-"));
  const effectMarker = join(directory, "agent-effect.txt");
  const definition: WorkflowDefinition = {
    id: "agent-crash-window",
    title: "Agent crash window",
    steps: [{ id: "danger", type: "agent", prompt: "perform effect", retries: 1 }],
  };
  try {
    const moduleUrl = pathToFileURL(resolve("src/workflow.ts")).href;
    const childScript = `
      import { writeFileSync } from "node:fs";
      import { WorkflowEngine } from ${JSON.stringify(moduleUrl)};
      const definition = ${JSON.stringify(definition)};
      const engine = new WorkflowEngine(${JSON.stringify(directory)}, {
        runAgent: async () => {
          writeFileSync(${JSON.stringify(effectMarker)}, "effect happened", "utf8");
          process.exit(86);
        },
        requestApproval: async () => true,
        remember: async () => 1,
      });
      await engine.run(definition);
    `;
    const crashed = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "--input-type=module", "-e", childScript], {
      cwd: resolve("."),
      encoding: "utf8",
    });
    assert.equal(crashed.status, 86, crashed.stderr);
    assert.equal(readFileSync(effectMarker, "utf8"), "effect happened");

    let replayCalls = 0;
    const engine = new WorkflowEngine(directory, {
      runAgent: async () => {
        replayCalls += 1;
        return "unsafe replay";
      },
      requestApproval: async () => true,
      remember: async () => 1,
    });
    const paused = await engine.run(definition);
    assert.equal(paused.status, "paused");
    assert.equal(replayCalls, 0);
    assert.match(paused.error ?? "", /effect is unknown.*automatic replay is blocked/i);
    assert.equal(paused.journal?.danger?.at(-1)?.status, "started");

    const recovered = engine.resolveUnknownStep(definition, "danger", {
      action: "complete",
      output: "verified by operator",
    });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.cursor, 1);
    assert.equal(recovered.outputs.danger, "verified by operator");
    assert.equal(recovered.journal?.danger?.at(-1)?.status, "recovered_completed");
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("an explicit operator retry is required after a runtime reports an unknown agent effect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-workflow-"));
  const definition: WorkflowDefinition = {
    id: "operator-retry",
    title: "Operator retry",
    steps: [{ id: "effect", type: "agent", prompt: "run", retries: 1 }],
  };
  let calls = 0;
  try {
    const engine = new WorkflowEngine(directory, {
      runAgent: async () => {
        calls += 1;
        if (calls === 1) throw new UnknownWorkflowEffectError("provider process disappeared");
        return "recovered";
      },
      requestApproval: async () => true,
      remember: async () => 1,
    });
    assert.equal((await engine.run(definition)).status, "paused");
    assert.equal((await engine.run(definition)).status, "paused");
    assert.equal(calls, 1);

    const authorized = engine.resolveUnknownStep(definition, "effect", { action: "retry" });
    assert.equal(authorized.journal?.effect?.at(-1)?.status, "retry_authorized");
    const completed = await engine.run(definition);
    assert.equal(completed.status, "completed");
    assert.equal(completed.attempts.effect, 2);
    assert.equal(completed.outputs.effect, "recovered");
    assert.equal(calls, 2);
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("a memory crash retries with the exact same durable idempotency key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-workflow-"));
  const keyMarker = join(directory, "memory-key.txt");
  const definition: WorkflowDefinition = {
    id: "memory-crash-window",
    title: "Memory crash window",
    steps: [{ id: "record", type: "memory", content: "durable fact", label: "test" }],
  };
  try {
    const moduleUrl = pathToFileURL(resolve("src/workflow.ts")).href;
    const childScript = `
      import { writeFileSync } from "node:fs";
      import { WorkflowEngine } from ${JSON.stringify(moduleUrl)};
      const definition = ${JSON.stringify(definition)};
      const engine = new WorkflowEngine(${JSON.stringify(directory)}, {
        runAgent: async () => "unused",
        requestApproval: async () => true,
        remember: async (_content, _label, key) => {
          writeFileSync(${JSON.stringify(keyMarker)}, String(key), "utf8");
          process.exit(87);
        },
      });
      await engine.run(definition);
    `;
    const crashed = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "--input-type=module", "-e", childScript], {
      cwd: resolve("."),
      encoding: "utf8",
    });
    assert.equal(crashed.status, 87, crashed.stderr);
    const firstKey = readFileSync(keyMarker, "utf8");
    assert.match(firstKey, /^wf_[a-f0-9]{64}$/);

    let calls = 0;
    let resumedKey = "";
    const resumed = await new WorkflowEngine(directory, {
      runAgent: async () => "unused",
      requestApproval: async () => true,
      remember: async (_content, _label, key) => {
        calls += 1;
        resumedKey = key ?? "";
        return 42;
      },
    }).run(definition);
    assert.equal(resumed.status, "completed");
    assert.equal(calls, 1);
    assert.equal(resumedKey, firstKey);
    assert.deepEqual(resumed.outputs.record, { memoryId: 42 });
    assert.deepEqual(
      resumed.journal?.record?.map((entry) => entry.status),
      ["started", "completed"],
    );
    assert.equal(new Set(resumed.journal?.record?.map((entry) => entry.idempotencyKey)).size, 1);
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("a post-effect validation failure preserves the prior started marker instead of enabling replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-workflow-"));
  const definition: WorkflowDefinition = {
    id: "invalid-effect-output",
    title: "Invalid effect output",
    steps: [{ id: "effect", type: "agent", prompt: "return invalid state", retries: 1 }],
  };
  let effectCalls = 0;
  try {
    const engine = new WorkflowEngine(directory, {
      runAgent: async () => {
        effectCalls += 1;
        return 1n as unknown as string;
      },
      requestApproval: async () => true,
      remember: async () => 1,
    });
    await assert.rejects(engine.run(definition), /could not durably save/i);
    assert.equal(effectCalls, 1);

    let replayCalls = 0;
    const paused = await new WorkflowEngine(directory, {
      runAgent: async () => {
        replayCalls += 1;
        return "must not run";
      },
      requestApproval: async () => true,
      remember: async () => 1,
    }).run(definition);
    assert.equal(paused.status, "paused");
    assert.equal(replayCalls, 0);
    assert.equal(paused.journal?.effect?.at(-1)?.status, "started");
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("workflow refuses to persist a state larger than its own reload limit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-workflow-"));
  const definition: WorkflowDefinition = {
    id: "oversized-state",
    title: "Oversized state",
    steps: [{ id: "large", type: "agent", prompt: "large", retries: 0 }],
  };
  let effects = 0;
  try {
    const engine = new WorkflowEngine(directory, {
      runAgent: async () => {
        effects += 1;
        return "x".repeat(17 * 1024 * 1024);
      },
      requestApproval: async () => true,
      remember: async () => 1,
    });
    await assert.rejects(engine.run(definition), /Workflow state exceeds 16777216 bytes|Could not durably save/i);
    assert.equal(effects, 1);
    const files = readdirSync(directory);
    assert.equal(
      files.some((name) => name.endsWith(".tmp")),
      false,
    );
    const state = readFileSync(join(directory, "oversized-state.json"), "utf8");
    assert.ok(Buffer.byteLength(state) <= 16 * 1024 * 1024);
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("progressed legacy state requires explicit adoption while pristine state migrates safely", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-workflow-"));
  try {
    const runtime = {
      runAgent: async (prompt: string) => `done:${prompt}`,
      requestApproval: async () => true,
      remember: async () => 1,
    };
    const pristineDefinition: WorkflowDefinition = {
      id: "legacy-pristine",
      title: "Pristine",
      steps: [{ id: "work", type: "agent", prompt: "work", retries: 0 }],
    };
    writeFileSync(
      join(directory, "legacy-pristine.json"),
      JSON.stringify({
        workflowId: "legacy-pristine",
        status: "paused",
        cursor: 0,
        attempts: {},
        outputs: {},
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const migrated = await new WorkflowEngine(directory, runtime).run(pristineDefinition);
    assert.equal(migrated.status, "completed");
    assert.equal(migrated.definitionHash, hashWorkflowDefinition(pristineDefinition));

    const progressedDefinition: WorkflowDefinition = {
      id: "legacy-progressed",
      title: "Progressed",
      steps: [
        { id: "first", type: "agent", prompt: "first", retries: 0 },
        { id: "second", type: "memory", content: "fact", label: "legacy" },
      ],
    };
    writeFileSync(
      join(directory, "legacy-progressed.json"),
      JSON.stringify({
        workflowId: "legacy-progressed",
        status: "paused",
        cursor: 1,
        attempts: { first: 1 },
        outputs: { first: "done:first" },
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const progressedEngine = new WorkflowEngine(directory, runtime);
    await assert.rejects(progressedEngine.run(progressedDefinition), /adoptLegacyState/);
    const adopted = progressedEngine.adoptLegacyState(progressedDefinition);
    assert.equal(adopted.status, "paused");
    assert.equal(adopted.definitionHash, hashWorkflowDefinition(progressedDefinition));
    const completed = await progressedEngine.run(progressedDefinition);
    assert.equal(completed.status, "completed");
    assert.equal(completed.outputs.first, "done:first");
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});
