import assert from "node:assert/strict";
import test from "node:test";
import { isExpectedNodeSqliteWarning } from "../src/security/node-warnings.js";

test("the launcher filter matches only Node's known SQLite experimental warning", () => {
  assert.equal(isExpectedNodeSqliteWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning"), true);
  assert.equal(isExpectedNodeSqliteWarning("another experimental feature", "ExperimentalWarning"), false);
  assert.equal(isExpectedNodeSqliteWarning("SQLite is an experimental feature and might change at any time", "Warning"), false);
  assert.equal(isExpectedNodeSqliteWarning(new Error("SQLite is an experimental feature and might change at any time"), "ExperimentalWarning"), true);
});
