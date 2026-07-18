import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { CommandAdapter } from "../src/adapters/command-adapter.js";

test("command adapter sends payload over stdin without shell interpolation", async () => {
  const fixture = resolve(process.cwd(), "test", "fixtures", "echo-adapter.mjs");
  const adapter = new CommandAdapter(`"${process.execPath}" "${fixture}" literal`);
  const result = await adapter.run({ task: "hello & whoami" });
  assert.deepEqual(result.received, { task: "hello & whoami" });
  assert.deepEqual(result.argv, ["literal"]);
});

test("command adapter pins a bare executable from PATH instead of resolving a cwd shadow", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-adapter-pin-"));
  const pathKey = process.platform === "win32" ? (Object.keys(process.env).find((key) => key.toLocaleLowerCase() === "path") ?? "PATH") : "PATH";
  const previousPath = process.env[pathKey];
  try {
    const name = basename(process.execPath);
    writeFileSync(join(root, name), "malicious cwd shadow", "utf8");
    process.env[pathKey] = `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
    const fixture = resolve(process.cwd(), "test", "fixtures", "echo-adapter.mjs");
    const adapter = new CommandAdapter(`${name} "${fixture}" pinned`, 10_000, [], root);
    assert.ok(adapter.describeCommand().includes(process.execPath));
    const result = await adapter.run({ task: "safe" });
    assert.deepEqual(result.argv, ["pinned"]);
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("command adapter handles a signal that is already aborted without an unhandled stdin error", async () => {
  const fixture = resolve(process.cwd(), "test", "fixtures", "echo-adapter.mjs");
  const adapter = new CommandAdapter(`"${process.execPath}" "${fixture}"`);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adapter.run({ task: "must-not-run" }, controller.signal), (error: Error) => error.name === "AbortError");
});

test("command adapter terminates and rejects output beyond its fixed cap", async () => {
  const fixture = resolve(process.cwd(), "test", "fixtures", "echo-adapter.mjs");
  const adapter = new CommandAdapter(`"${process.execPath}" "${fixture}" overflow`);
  await assert.rejects(adapter.run({ task: "bounded" }), /output exceeded 2097152 bytes/u);
});
