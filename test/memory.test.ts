import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { MemoryStore } from "../src/memory/store.js";

test("memory keeps provenance, review state and searchable recall", () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-memory-"));
  try {
    const store = new MemoryStore(join(directory, "state.db"));
    const id = store.addMemory({
      content: "The deployment uses a blue green release gate.",
      kind: "procedure",
      reviewStatus: "pending",
      confidence: 0.9,
      sourceUri: "file:///runbook.md",
      sourceLabel: "runbook",
    });
    const recalled = store.recall("deployment release", "session", 5);
    assert.equal(recalled[0]?.id, id);
    assert.equal(recalled[0]?.sourceUri, "file:///runbook.md");
    assert.equal(recalled[0]?.reviewStatus, "pending");
    assert.equal(store.reviewMemory(id, "approved"), true);
    assert.equal(store.getMemory(id)?.reviewStatus, "approved");
    store.addMessage("private-session", "user", "temporary conversation");
    assert.equal(
      store.listSessions().some((session) => session.id === "private-session"),
      true,
    );
    assert.equal(store.forgetSession("private-session"), true);
    assert.equal(store.recentMessages("private-session").length, 0);
    store.close();
  } finally {
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(resolve(tmpdir())));
    rmSync(absolute, { recursive: true, force: true });
  }
});

test("memory rejects material that resembles a secret", () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-memory-"));
  try {
    const store = new MemoryStore(join(directory, "state.db"));
    assert.throws(
      () =>
        store.addMemory({
          content: `credential sk-${"a".repeat(32)}`,
          sourceUri: "manual://test",
          sourceLabel: "test",
        }),
      /secret/,
    );
    assert.throws(
      () =>
        store.addMemory({
          content: "password: definitely-a-real-secret",
          sourceUri: "manual://test",
          sourceLabel: "test",
        }),
      /secret/,
    );
    assert.doesNotThrow(() =>
      store.addMemory({
        content: "password: <redacted>",
        sourceUri: "manual://placeholder",
        sourceLabel: "test",
      }),
    );
    assert.throws(
      () =>
        store.addMemory({
          content: "safe evidence",
          sourceUri: "https://user:definitely-secret@example.com/source",
          sourceLabel: "test",
        }),
      /sourceUri.*secret/,
    );
    store.addMessage("session", "user", "password=definitely-a-real-secret");
    assert.equal(store.recentMessages("session")[0]?.content, "password=[REDACTED]");
    store.recall("password=definitely-a-real-secret", "session", 1);
    const logged = store.database.prepare("SELECT query FROM recall_log ORDER BY id DESC LIMIT 1").get() as { query: string };
    assert.equal(logged.query, "password=[REDACTED]");
    store.close();
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("memory excludes expired and superseded entries and exports portable state", () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-memory-"));
  try {
    const store = new MemoryStore(join(directory, "state.db"));
    const oldId = store.addMemory({
      content: "Use the old deployment procedure",
      kind: "procedure",
      reviewStatus: "approved",
      sourceUri: "manual://old",
      sourceLabel: "old",
    });
    const newId = store.addMemory({
      content: "Use the new deployment procedure",
      kind: "procedure",
      reviewStatus: "approved",
      sourceUri: "manual://new",
      sourceLabel: "new",
      importance: 1,
    });
    store.addMemory({ content: "Expired deployment procedure", sourceUri: "manual://expired", sourceLabel: "expired", expiresAt: "2020-01-01T00:00:00Z" });
    assert.equal(store.supersedeMemory(oldId, newId), true);
    assert.deepEqual(
      store.recall("deployment procedure", "session", 10).map((item) => item.id),
      [newId],
    );
    assert.equal(store.stats().superseded, 1);
    assert.equal(store.stats().expired, 1);
    assert.equal(store.exportPortable().version, 2);
    assert.equal(store.forgetMemory(newId), true);
    assert.equal(store.getMemory(oldId)?.supersededBy, undefined);
    store.close();
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("memory uses offline hybrid vectors, logs ranking and learns explicit feedback", () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-memory-"));
  try {
    const store = new MemoryStore(join(directory, "state.db"));
    const alpha = store.addMemory({ content: "Alpha provider: resilient authentication for production", sourceUri: "manual://alpha", sourceLabel: "alpha" });
    const beta = store.addMemory({ content: "Beta provider: resilient authentication for production", sourceUri: "manual://beta", sourceLabel: "beta" });
    store.addMemory({ content: "Chocolate cake recipe with cinnamon", sourceUri: "manual://cake", sourceLabel: "cake" });

    const fuzzy = store.recall("authenticate providers in production", "hybrid", 2);
    assert.ok(fuzzy.some((item) => item.id === alpha || item.id === beta));
    const log = store.database.prepare("SELECT ranking_version, scores_json FROM recall_log ORDER BY id DESC LIMIT 1").get() as {
      ranking_version: string;
      scores_json: string;
    };
    assert.equal(log.ranking_version, "hybrid-rrf-mmr-v1");
    assert.ok(Array.isArray(JSON.parse(log.scores_json)));
    assert.equal((store.database.prepare("SELECT COUNT(*) count FROM memory_embeddings").get() as { count: number }).count, 3);

    for (let index = 0; index < 3; index += 1) {
      store.recordRecallFeedback("hybrid", alpha, -1, "not useful for this task");
      store.recordRecallFeedback("hybrid", beta, 1, "verified useful");
    }
    assert.equal(store.recall("provider resilient authentication production", "hybrid", 2)[0]?.id, beta);
    store.close();
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("memory exposes contradictions as review suggestions and stores explicit relations", () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-memory-"));
  try {
    const store = new MemoryStore(join(directory, "state.db"));
    const enabled = store.addMemory({
      content: "The release procedure must enable the production cache before deployment",
      sourceUri: "manual://enabled",
      sourceLabel: "enabled",
    });
    const disabled = store.addMemory({
      content: "The release procedure must not enable the production cache before deployment",
      sourceUri: "manual://disabled",
      sourceLabel: "disabled",
    });
    const suggestions = store.findPotentialContradictions(enabled);
    assert.ok(suggestions.some((item) => item.memory.id === disabled));
    const relationId = store.linkMemories(enabled, disabled, "contradicts", "Reviewed against current runbook");
    assert.equal(store.listMemoryRelations(enabled)[0]?.id, relationId);
    assert.equal(store.listMemoryRelations(enabled)[0]?.relation, "contradicts");
    store.close();
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("learning candidates require human review before governed conversion", () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-memory-"));
  try {
    const store = new MemoryStore(join(directory, "state.db"));
    const id = store.addLearningCandidate("session-learning", "Reliable release", "Inspect state, apply bounded change, then verify the observable result.");
    assert.equal(store.getLearningCandidate(id)?.reviewStatus, "pending");
    assert.throws(() => store.markLearningCandidateConverted(id, "reliable-release"), /human-approved/);
    const reviewed = store.reviewLearningCandidate(id, "approved", "Procedure and provenance reviewed");
    assert.equal(reviewed.reviewStatus, "approved");
    const converted = store.markLearningCandidateConverted(id, "reliable-release");
    assert.equal(converted.status, "converted");
    assert.equal(converted.convertedSkillId, "reliable-release");
    assert.throws(() => store.reviewLearningCandidate(id, "rejected"), /cannot be reviewed/);

    const rejectedId = store.addLearningCandidate("session-learning", "Unsafe idea", "An unverified procedure that should remain inactive.");
    assert.equal(store.reviewLearningCandidate(rejectedId, "rejected", "Insufficient evidence").status, "rejected");
    const exported = store.exportPortable();
    assert.equal(exported.learningCandidates.length, 2);
    assert.equal(exported.relations.length, 0);
    store.close();
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("memory scopes isolate recall while retaining global knowledge", () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-memory-"));
  try {
    const store = new MemoryStore(join(directory, "state.db"));
    const globalId = store.addMemory({ content: "Shared alpha deployment rule", scope: "global", sourceUri: "manual://global", sourceLabel: "global" });
    const alphaId = store.addMemory({ content: "Alpha deployment procedure", scope: "alpha", sourceUri: "manual://alpha", sourceLabel: "alpha" });
    const betaId = store.addMemory({ content: "Beta deployment procedure", scope: "beta", sourceUri: "manual://beta", sourceLabel: "beta" });
    const ids = store.recall("deployment", "session", 10, "alpha").map((item) => item.id);
    assert.ok(ids.includes(globalId));
    assert.ok(ids.includes(alphaId));
    assert.equal(ids.includes(betaId), false);
    store.close();
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("workflow memory idempotency is atomic and rejects key reuse with different data", () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-memory-idempotency-"));
  try {
    const store = new MemoryStore(join(directory, "state.db"));
    const idempotencyKey = `wf_${"a".repeat(64)}`;
    const input = {
      content: "A durable workflow observation",
      kind: "evidence" as const,
      reviewStatus: "pending" as const,
      scope: "global",
      sourceUri: "workflow://idempotency-test",
      sourceLabel: "record",
      idempotencyKey,
    };
    const first = store.addMemory(input);
    const replay = store.addMemory(input);
    assert.equal(replay, first);
    assert.equal(store.stats().total, 1);
    assert.throws(() => store.addMemory({ ...input, content: "Different data" }), /reused with a different payload/);
    assert.throws(() => store.addMemory({ ...input, idempotencyKey: "invalid" }), /idempotency key is invalid/);
    store.close();
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});
