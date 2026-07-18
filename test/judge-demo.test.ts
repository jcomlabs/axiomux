import assert from "node:assert/strict";
import test from "node:test";
import { runJudgeDemo } from "../src/judge-demo.js";

test("offline judge demo exercises governed runtime components", async () => {
  const report = await runJudgeDemo();
  assert.equal(report.status, "pass");
  assert.equal(report.offline, true);
  assert.deepEqual(
    report.checks.map((check) => check.id),
    ["portable-continuity", "effect-aware-fallback", "governed-memory", "effect-policy", "skill-governance", "fusion-fault-isolation"],
  );
  assert.equal(report.metrics.providerHandoffs, 1);
  assert.equal(report.metrics.safeFallbacks, 1);
  assert.equal(report.metrics.blockedReplays, 1);
  assert.equal(report.metrics.governedRelations, 1);
  assert.equal(report.metrics.activeSkills, 1);
  assert.equal(report.metrics.fusionParticipants, 3);
  assert.equal(report.metrics.usableFusionCandidates, 2);
  assert.equal(report.metrics.isolatedFailures, 1);
});
