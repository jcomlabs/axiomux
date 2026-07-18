import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "../src/memory/store.js";
import { RuntimeStore } from "../src/runtime/store.js";

function temporaryStore(): { memory: MemoryStore; runtime: RuntimeStore; root: string } {
  mkdirSync(join(process.cwd(), ".superai"), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), ".superai", "runtime-test-"));
  const memory = new MemoryStore(join(root, "state.db"));
  return { memory, runtime: new RuntimeStore(memory.database), root };
}

test("runtime store persists project, turn, events, effects and searchable sessions", () => {
  const { memory, runtime, root } = temporaryStore();
  try {
    const project = runtime.ensureProject(root, "Example");
    runtime.attachSession(project.id, "session-1", "Reliability work");
    runtime.setSessionPreferredModel("session-1", "provider/exact-model");
    assert.equal(runtime.sessionPreferredModel("session-1"), "provider/exact-model");
    assert.equal(runtime.listSessions(project.id)[0]?.preferredModel, "provider/exact-model");
    runtime.setSessionPreferredModel("session-1");
    assert.equal(runtime.sessionPreferredModel("session-1"), undefined);
    assert.throws(() => runtime.setSessionPreferredModel("session-1", "invalid"), /provider\/model/);
    memory.addMessage("session-1", "user", "Implement a durable circuit breaker");
    const turn = runtime.beginTurn("session-1", "Implement a durable circuit breaker");
    runtime.appendEvent("session-1", turn.id, { at: new Date().toISOString(), kind: "lifecycle", phase: "started", label: "started" });
    assert.equal(runtime.startEffect(turn.id, "tool-1", "computer_use", { task: "click" }), true);
    assert.equal(runtime.startEffect(turn.id, "tool-1", "computer_use", { task: "click" }), false);
    assert.throws(() => runtime.startEffect(turn.id, "tool-1", "computer_use", { task: "different" }), /conflicts/);
    assert.equal(runtime.hasConsequentialEffect(turn.id), true);
    runtime.finishEffect(turn.id, "tool-1", "completed", { ok: true });
    runtime.completeTurn(turn.id, "fake/model", "done");

    assert.equal(runtime.listProjects()[0]?.name, "Example");
    assert.equal(runtime.listSessions(project.id)[0]?.status, "idle");
    assert.equal(runtime.listEvents("session-1")[0]?.label, "started");
    assert.equal(runtime.searchMessages("circuit breaker")[0]?.sessionId, "session-1");
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider health opens and recovers a circuit", () => {
  const { memory, runtime, root } = temporaryStore();
  try {
    runtime.recordProviderFailure("fake/model", "network", "socket failed");
    runtime.recordProviderFailure("fake/model", "network", "socket failed");
    runtime.recordProviderFailure("fake/model", "network", "socket failed");
    assert.equal(runtime.circuitOpen("fake/model"), true);
    runtime.recordProviderSuccess("fake/model", 42);
    assert.equal(runtime.circuitOpen("fake/model"), false);
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime task snapshots persist complete data and interrupted work fails closed on restart", () => {
  mkdirSync(join(process.cwd(), ".superai"), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), ".superai", "runtime-restart-test-"));
  const databasePath = join(root, "state.db");
  let memory: MemoryStore | undefined = new MemoryStore(databasePath);
  try {
    const runtime = new RuntimeStore(memory.database);
    const project = runtime.ensureProject(root, "Restart test");
    for (const name of ["queued-project", "waiting-project", "completed-project"]) mkdirSync(join(root, name), { recursive: true });
    const queuedProject = runtime.ensureProject(join(root, "queued-project"), "Queued project");
    const waitingProject = runtime.ensureProject(join(root, "waiting-project"), "Waiting project");
    const completedProject = runtime.ensureProject(join(root, "completed-project"), "Completed project");
    runtime.attachSession(project.id, "session-restart", "Interrupted work");
    runtime.attachSession(queuedProject.id, "session-queued", "Queued work");
    runtime.attachSession(waitingProject.id, "session-waiting", "Waiting work");
    runtime.attachSession(completedProject.id, "session-completed", "Completed work");
    const turn = runtime.beginTurn("session-restart", "running prompt");
    memory.database.prepare("UPDATE turns SET status='waiting_approval' WHERE id=?").run(turn.id);

    runtime.createTask(project.id, "session-restart", "running prompt", turn.id, { id: "task-running", status: "running" });
    runtime.updateTask("task-running", "running", turn.id, { model: "fake/model" });
    runtime.setTaskOutput("task-running", "partial output");
    runtime.createTask(queuedProject.id, "session-queued", "queued prompt", undefined, { id: "task-queued", status: "queued" });
    runtime.createTask(waitingProject.id, "session-waiting", "waiting prompt", undefined, { id: "task-waiting", status: "queued" });
    runtime.updateTask("task-waiting", "waiting");
    runtime.createTask(completedProject.id, "session-completed", "completed prompt", undefined, { id: "task-completed", status: "running" });
    runtime.updateTask("task-completed", "completed", undefined, { model: "fake/model", output: "complete output" });

    const sameProcessView = new RuntimeStore(memory.database);
    assert.equal(sameProcessView.getTask("task-running")?.status, "running", "a second store on the live connection must not simulate a restart");
    const parallelMemory = new MemoryStore(databasePath);
    try {
      const parallelView = new RuntimeStore(parallelMemory.database);
      assert.equal(parallelView.getTask("task-running")?.status, "running", "a second live database connection must not fail owned work");
    } finally {
      parallelMemory.close();
    }

    memory.database.exec(`UPDATE runtime_tasks SET owner_instance='dead-runtime', owner_pid=2147483647
      WHERE status IN ('queued','running','waiting');
      UPDATE turns SET owner_instance='dead-runtime', owner_pid=2147483647
      WHERE status IN ('queued','running','waiting_approval')`);

    memory.close();
    memory = undefined;
    const reopenedMemory = new MemoryStore(databasePath);
    try {
      const reopened = new RuntimeStore(reopenedMemory.database);
      const tasks = new Map(reopened.listTasks().map((task) => [task.id, task]));
      for (const id of ["task-running", "task-queued", "task-waiting"]) {
        assert.equal(tasks.get(id)?.status, "failed");
        assert.match(tasks.get(id)?.error ?? "", /process restart.*not resumed/i);
        assert.ok(tasks.get(id)?.completedAt);
      }
      assert.equal(tasks.get("task-running")?.prompt, "running prompt");
      assert.equal(tasks.get("task-running")?.output, "partial output");
      assert.equal(tasks.get("task-running")?.model, "fake/model");
      assert.equal(tasks.get("task-completed")?.status, "completed");
      assert.equal(tasks.get("task-completed")?.output, "complete output");
      assert.throws(() => reopened.updateTask("task-running", "running"), /cannot transition/);
      assert.equal(reopened.getTurn(turn.id)?.status, "failed");
      assert.match(reopened.getTurn(turn.id)?.error ?? "", /process restart.*not resumed/i);
      assert.equal(reopened.listSessions(project.id)[0]?.status, "idle");
    } finally {
      reopenedMemory.close();
    }
  } finally {
    memory?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime enforces one active task per project across database clients", () => {
  const { memory, runtime, root } = temporaryStore();
  try {
    const project = runtime.ensureProject(root, "Single flight");
    runtime.attachSession(project.id, "session-a", "A");
    runtime.attachSession(project.id, "session-b", "B");
    runtime.createTask(project.id, "session-a", "first", undefined, { id: "active-a", status: "running" });
    runtime.createTask(project.id, "session-b", "second", undefined, { id: "queued-b", status: "queued" });
    assert.throws(
      () => runtime.updateTask("queued-b", "running"),
      /UNIQUE constraint failed/,
      "a second process/session must not enter its mutating turn while the project is active",
    );
    runtime.updateTask("active-a", "completed", undefined, { output: "done" });
    runtime.updateTask("queued-b", "running");
    assert.equal(runtime.getTask("queued-b")?.status, "running");
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime keeps project roots canonical and never moves a session between projects", () => {
  const { memory, runtime, root } = temporaryStore();
  try {
    const first = runtime.ensureProject(root, "First");
    const otherRoot = join(root, "other");
    mkdirSync(otherRoot, { recursive: true });
    const second = runtime.ensureProject(otherRoot, "Second");
    runtime.attachSession(first.id, "scoped-session", "Scoped");
    assert.throws(() => runtime.attachSession(second.id, "scoped-session", "Moved"), /already belongs to project/);
    assert.equal(runtime.listSessions(first.id)[0]?.id, "scoped-session");
    assert.equal(
      runtime.listSessions(second.id).some((session) => session.id === "scoped-session"),
      false,
    );
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("project registry persists a selected workspace and unlinks without deleting its history or folder", () => {
  const { memory, runtime, root } = temporaryStore();
  try {
    const first = runtime.ensureProject(root, "Harness");
    const workspace = join(root, "linked-workspace");
    mkdirSync(workspace, { recursive: true });
    const second = runtime.ensureProject(workspace, "Product workspace");
    runtime.attachSession(second.id, "linked-session", "Project-specific session");
    memory.addMessage("linked-session", "user", "cross project searchable evidence");

    assert.equal(runtime.useProject(second.id).id, second.id);
    assert.equal(runtime.currentProject()?.rootPath, second.rootPath);
    assert.equal(runtime.getSession("linked-session")?.projectId, second.id);
    assert.equal(runtime.searchMessages("searchable evidence", 10, second.id)[0]?.projectId, second.id);
    assert.equal(runtime.searchMessages("searchable evidence", 10, first.id).length, 0);

    const removed = runtime.removeProject(second.id);
    assert.equal(removed.linked, false);
    assert.equal(runtime.currentProject(), undefined);
    assert.equal(
      runtime.listProjects().some((item) => item.id === second.id),
      false,
    );
    assert.equal(
      runtime.listProjects(true).some((item) => item.id === second.id),
      true,
    );
    assert.equal(runtime.getSession("linked-session")?.projectId, second.id, "unlink must retain local history");
    assert.equal(existsSync(workspace), true, "unlink must never delete the workspace folder");
    assert.throws(() => runtime.attachSession(second.id, "blocked-session"), /unknown or unlinked project/);
    assert.throws(
      () => runtime.createTask(second.id, "linked-session", "must not start", undefined, { id: "blocked-unlinked-task", status: "queued" }),
      /task project is not linked/,
    );

    const relinked = runtime.ensureProject(workspace, "Product workspace relinked");
    assert.equal(relinked.id, second.id);
    assert.equal(relinked.linked, true);
    assert.equal(runtime.useProject(relinked.id).name, "Product workspace relinked");
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an active project cannot be unlinked and project names are bounded", () => {
  const { memory, runtime, root } = temporaryStore();
  try {
    const project = runtime.ensureProject(root, "Active");
    runtime.attachSession(project.id, "active-session", "Active");
    runtime.createTask(project.id, "active-session", "work", undefined, { id: "active-unlink", status: "running" });
    assert.throws(() => runtime.removeProject(project.id), /active task active-unlink/);
    assert.throws(() => runtime.ensureProject(root, "x".repeat(121)), /1-120 printable/);
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("task finalization rejects cross-paired turns, sessions and projects atomically", () => {
  const { memory, runtime, root } = temporaryStore();
  try {
    const otherRoot = join(root, "other-project");
    mkdirSync(otherRoot);
    const first = runtime.ensureProject(root, "First binding");
    const second = runtime.ensureProject(otherRoot, "Second binding");
    runtime.attachSession(first.id, "binding-session-a", "A");
    runtime.attachSession(second.id, "binding-session-b", "B");
    const turnA = runtime.beginTurn("binding-session-a", "first task");
    const turnB = runtime.beginTurn("binding-session-b", "second task");
    runtime.createTask(first.id, "binding-session-a", "first task", turnA.id, { id: "binding-task-a", status: "running" });
    runtime.createTask(second.id, "binding-session-b", "second task", turnB.id, { id: "binding-task-b", status: "running" });

    assert.throws(
      () => runtime.completeTaskTurn("binding-task-a", turnB.id, "binding-session-a", "fake/model", "wrong completion"),
      /does not match its bound turn, session and project/,
    );
    assert.throws(
      () => runtime.completeTaskTurn("binding-task-a", turnA.id, "binding-session-b", "fake/model", "wrong session"),
      /does not match its bound turn, session and project/,
    );
    assert.throws(() => runtime.failTaskTurn("binding-task-a", turnB.id, "wrong failure"), /does not match its bound turn, session and project/);
    assert.throws(
      () => runtime.createTask(first.id, "binding-session-b", "cross-project task", undefined, { id: "invalid-cross-project-task", status: "queued" }),
      /task session does not belong to task project/,
    );
    assert.throws(
      () => runtime.appendEvent("binding-session-a", turnB.id, { at: new Date().toISOString(), kind: "lifecycle", phase: "started", label: "cross-paired" }),
      /event turn does not belong to event session/,
    );

    assert.equal(runtime.getTask("binding-task-a")?.status, "running");
    assert.equal(runtime.getTask("binding-task-b")?.status, "running");
    assert.equal(runtime.getTurn(turnA.id)?.status, "running");
    assert.equal(runtime.getTurn(turnB.id)?.status, "running");
    const assistantMessages = memory.database.prepare("SELECT COUNT(*) count FROM messages WHERE role='assistant'").get() as { count: number };
    assert.equal(Number(assistantMessages.count), 0, "rejected pairings must roll back every turn/task/message mutation");

    runtime.completeTaskTurn("binding-task-a", turnA.id, "binding-session-a", "fake/model", "first complete");
    runtime.completeTaskTurn("binding-task-b", turnB.id, "binding-session-b", "fake/model", "second complete");
    assert.equal(runtime.getTask("binding-task-a")?.status, "completed");
    assert.equal(runtime.getTask("binding-task-b")?.status, "completed");
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a linked project keeps its physical directory identity across store restarts", () => {
  const { memory, runtime, root } = temporaryStore();
  try {
    const workspace = join(root, "identity-workspace");
    const displaced = join(root, "identity-workspace-original");
    mkdirSync(workspace);
    const linked = runtime.ensureProject(workspace, "Identity workspace");
    assert.ok(linked.rootDevice);
    assert.ok(linked.rootInode);
    assert.ok(linked.rootBirthtimeNanoseconds);

    renameSync(workspace, displaced);
    mkdirSync(workspace);
    const reopenedMemory = new MemoryStore(join(root, "state.db"));
    try {
      const reopened = new RuntimeStore(reopenedMemory.database);
      assert.equal(reopened.getProjectByRoot(workspace), undefined, "the same pathname must not authenticate a replacement directory");
      assert.throws(() => reopened.ensureProject(workspace, "Replacement"), /directory identity changed.*unlink.*relink/i);

      reopened.removeProject(linked.id);
      const relinked = reopened.ensureProject(workspace, "Explicitly relinked replacement");
      assert.equal(relinked.id, linked.id, "an explicit unlink/relink keeps project history under the stable path-derived id");
      assert.notEqual(relinked.rootInode, linked.rootInode);
    } finally {
      reopenedMemory.close();
    }
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one-time identity migration never auto-trusts a workspace that was missing during upgrade", () => {
  mkdirSync(join(process.cwd(), ".superai"), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), ".superai", "runtime-identity-migration-"));
  const missingWorkspace = join(root, "missing-during-migration");
  const memory = new MemoryStore(join(root, "state.db"));
  try {
    memory.database.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      linked INTEGER NOT NULL DEFAULT 1 CHECK(linked IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    memory.database
      .prepare("INSERT INTO projects(id, name, root_path, linked) VALUES (?, ?, ?, 1)")
      .run("legacy-missing-project", "Legacy missing", missingWorkspace);

    const migrated = new RuntimeStore(memory.database);
    assert.equal(migrated.getProject("legacy-missing-project")?.rootInode, undefined);
    mkdirSync(missingWorkspace);

    const restarted = new RuntimeStore(memory.database);
    assert.equal(restarted.getProject("legacy-missing-project")?.rootInode, undefined, "a later restart must not backfill a replacement path");
    assert.equal(restarted.getProjectByRoot(missingWorkspace), undefined);
    assert.throws(() => restarted.ensureProject(missingWorkspace, "Untrusted replacement"), /directory identity changed.*unlink.*relink/i);
    restarted.removeProject("legacy-missing-project");
    const relinked = restarted.ensureProject(missingWorkspace, "Trusted replacement");
    assert.equal(relinked.id, "legacy-missing-project");
    assert.ok(relinked.rootInode);
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});
