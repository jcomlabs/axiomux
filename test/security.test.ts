import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AuditLog } from "../src/audit.js";
import { buildChildEnvironment } from "../src/security/environment.js";
import { sanitizeTerminalText } from "../src/security/display.js";
import { containsSecret, redactSecrets, redactValue } from "../src/security/secrets.js";

test("child environments expose only the base set and explicit names", () => {
  process.env.SUPERAI_TEST_SECRET = "must-not-leak";
  const isolated = buildChildEnvironment();
  assert.equal(isolated.SUPERAI_TEST_SECRET, undefined);
  const allowed = buildChildEnvironment(["SUPERAI_TEST_SECRET"]);
  assert.equal(allowed.SUPERAI_TEST_SECRET, "must-not-leak");
  delete process.env.SUPERAI_TEST_SECRET;
});

test("audit records redact credentials recursively", () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-audit-"));
  try {
    const path = join(directory, "audit.jsonl");
    new AuditLog(path).write({ action: "test", outcome: "failed", details: { nested: { message: "password: definitely-a-real-secret" } } });
    const content = readFileSync(path, "utf8");
    assert.doesNotMatch(content, /definitely-a-real-secret/);
    assert.match(content, /REDACTED/);
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});

test("secret detector covers assignments while allowing placeholders", () => {
  assert.equal(containsSecret("client_secret=abcdefghijklmnop"), true);
  assert.equal(containsSecret("client_secret=<redacted>"), false);
  assert.equal(redactSecrets("token password=abcdefghijklmnop"), "token password=[REDACTED]");
});

test("structured redaction removes opaque secrets by property name", () => {
  assert.deepEqual(redactValue({ token: "opaque-random-value", nested: { authorization: "not-a-known-format", safe: "visible" } }), {
    token: "[REDACTED]",
    nested: { authorization: "[REDACTED]", safe: "visible" },
  });
});

test("terminal projection neutralizes OSC, CSI, C1 and bidi controls", () => {
  const hostile = "safe\u001b]52;c;Y2xpcGJvYXJk\u0007\u009b31m.txt\u202eexe";
  const projected = sanitizeTerminalText(hostile, 10_000);
  assert.doesNotMatch(projected, /[\u001b\u0007\u009b\u202e]/u);
  assert.match(projected, /<ESC>\]52/);
  assert.match(projected, /\\u202eexe/);
});
