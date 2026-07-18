import assert from "node:assert/strict";
import test from "node:test";
import { PolicyEngine } from "../src/policy.js";

test("policy separates local reads, reversible writes and external/destructive actions", () => {
  const policy = new PolicyEngine();
  assert.deepEqual(policy.assess("memory_recall", { query: "release" }), {
    risk: "read",
    allowed: true,
    requiresApproval: false,
    reason: "Read-only operation",
  });
  assert.equal(policy.assess("memory_remember", { content: "fact" }).risk, "workspace-write");
  assert.equal(policy.assess("browser_task", { task: "open site" }).requiresApproval, true);
  assert.equal(policy.assess("computer_use", { task: "delete account" }).risk, "destructive");
});
