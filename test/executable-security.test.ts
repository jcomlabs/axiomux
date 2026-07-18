import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { resolveTrustedExecutable, resolveWindowsSystemExecutable } from "../src/security/executable.js";

test("trusted executable resolution pins an absolute PATH file and skips workspace shadows", () => {
  const parent = mkdtempSync(join(tmpdir(), "superai-executable-"));
  const workspace = join(parent, "workspace");
  const trusted = join(parent, "trusted");
  mkdirSync(workspace);
  mkdirSync(trusted);
  const name = process.platform === "win32" ? "fixture.exe" : "fixture";
  const shadow = join(workspace, name);
  const real = join(trusted, name);
  writeFileSync(shadow, "shadow", "utf8");
  writeFileSync(real, "trusted", "utf8");
  if (process.platform !== "win32") {
    chmodSync(shadow, 0o755);
    chmodSync(real, 0o755);
  }
  try {
    const resolved = resolveTrustedExecutable(process.platform === "win32" ? "fixture" : name, {
      rejectRoots: [workspace],
      pathValue: [workspace, trusted].join(delimiter),
    });
    assert.equal(resolved, realpathSync.native(resolve(real)));
    assert.throws(() => resolveTrustedExecutable(`.${process.platform === "win32" ? "\\" : "/"}${name}`), /absolute/iu);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Windows inbox tools resolve from System32 without cwd or PATH lookup", { skip: process.platform !== "win32" }, () => {
  const executable = resolveWindowsSystemExecutable("whoami.exe");
  assert.match(executable, /[\\/]System32[\\/]whoami\.exe$/iu);
});
