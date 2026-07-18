import assert from "node:assert/strict";
import { linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { securePrivateFile, secureStateDirectory, writePrivateFileAtomic } from "../src/security/state.js";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "superai-state-security-"));
}

function unsupportedLink(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(String(error.code));
}

function makeDirectoryRedirect(target: string, path: string, context: TestContext): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (!unsupportedLink(error)) throw error;
    context.skip("directory links are unavailable on this filesystem");
    return false;
  }
}

function makeFileRedirect(target: string, path: string, context: TestContext): boolean {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch (error) {
    if (!unsupportedLink(error)) throw error;
    context.skip("file links are unavailable on this filesystem");
    return false;
  }
}

test("private state directories and atomic private files retain normal operation", () => {
  const root = temporaryRoot();
  try {
    const directory = join(root, "nested", "state");
    assert.equal(secureStateDirectory(directory).hardened, true);
    const path = join(directory, "secret.txt");
    writePrivateFileAtomic(path, "first");
    writePrivateFileAtomic(path, "second");
    assert.equal(readFileSync(path, "utf8"), "second");
    assert.equal(securePrivateFile(path).hardened, true);
    if (process.platform !== "win32") {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private state directory rejects a non-directory component", () => {
  const root = temporaryRoot();
  try {
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const result = secureStateDirectory(join(blocker, "state"));
    assert.equal(result.hardened, false);
    assert.match(result.detail, /not a directory/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private state directory rejects a symlink or Windows junction ancestor", (context) => {
  const root = temporaryRoot();
  const real = join(root, "real");
  const redirect = join(root, "redirect");
  mkdirSync(real);
  writeFileSync(join(real, "secret.txt"), "target-value");
  try {
    if (!makeDirectoryRedirect(real, redirect, context)) return;
    const result = secureStateDirectory(join(redirect, "state"));
    assert.equal(result.hardened, false);
    assert.match(result.detail, /symbolic link|junction|reparse/i);
    const fileResult = securePrivateFile(join(redirect, "secret.txt"));
    assert.equal(fileResult.hardened, false);
    assert.match(fileResult.detail, /symbolic link|junction|reparse/i);
    assert.throws(() => writePrivateFileAtomic(join(redirect, "secret.txt"), "replacement"), /symbolic link|junction|reparse/i);
    assert.equal(readFileSync(join(real, "secret.txt"), "utf8"), "target-value");
    assert.equal(lstatSync(redirect).isSymbolicLink(), true);
  } finally {
    try {
      unlinkSync(redirect);
    } catch {
      /* absent or already removed */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("private files reject file symlinks without changing their targets", (context) => {
  const root = temporaryRoot();
  const target = join(root, "target.txt");
  const redirect = join(root, "redirect.txt");
  writeFileSync(target, "outside-value");
  try {
    if (!makeFileRedirect(target, redirect, context)) return;
    const result = securePrivateFile(redirect);
    assert.equal(result.hardened, false);
    assert.match(result.detail, /symbolic link|reparse/i);
    assert.throws(() => writePrivateFileAtomic(redirect, "replacement"), /symbolic link|reparse/i);
    assert.equal(readFileSync(target, "utf8"), "outside-value");
  } finally {
    try {
      unlinkSync(redirect);
    } catch {
      /* absent or already removed */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("private files and atomic replacement reject hard links", (context) => {
  const root = temporaryRoot();
  const target = join(root, "target.txt");
  const linked = join(root, "linked.txt");
  writeFileSync(target, "shared-value");
  try {
    try {
      linkSync(target, linked);
    } catch (error) {
      if (!unsupportedLink(error)) throw error;
      context.skip("hard links are unavailable on this filesystem");
      return;
    }
    const result = securePrivateFile(linked);
    assert.equal(result.hardened, false);
    assert.match(result.detail, /hard link/i);
    assert.throws(() => writePrivateFileAtomic(linked, "replacement"), /hard.link/i);
    assert.equal(readFileSync(target, "utf8"), "shared-value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("securePrivateFile rejects directories and other non-regular paths", () => {
  const root = temporaryRoot();
  try {
    const result = securePrivateFile(root);
    assert.equal(result.hardened, false);
    assert.match(result.detail, /not a regular file/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
