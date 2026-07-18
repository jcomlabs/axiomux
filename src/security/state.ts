import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, normalize, parse, relative, resolve, sep } from "node:path";
import { resolveWindowsSystemExecutable } from "./executable.js";

export interface StateSecurityResult {
  hardened: boolean;
  detail: string;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function comparisonPath(path: string): string {
  let value = normalize(path);
  if (process.platform === "win32") {
    if (value.toLowerCase().startsWith("\\\\?\\unc\\")) value = `\\\\${value.slice(8)}`;
    else if (value.startsWith("\\\\?\\")) value = value.slice(4);
    value = normalize(value).toLowerCase();
  }
  const root = parse(value).root;
  while (value.length > root.length && (value.endsWith("/") || value.endsWith("\\"))) value = value.slice(0, -1);
  return value;
}

function assertCanonicalPath(path: string, kind: string): void {
  const canonical = realpathSync.native(path);
  if (comparisonPath(canonical) !== comparisonPath(path)) {
    throw new Error(`${kind} resolves through a symbolic link, junction, or reparse-point redirection`);
  }
}

/**
 * Verify every existing directory component without following a redirect.
 * A second pass after creation closes the usual mkdirSync({ recursive: true })
 * gap, where an already-existing ancestor would otherwise be followed.
 */
function assertSafeDirectoryPath(path: string, requireLeaf: boolean): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const suffix = relative(root, absolute);
  const parts = suffix === "" ? [] : suffix.split(sep).filter(Boolean);
  let current = root;

  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) {
      const part = parts[index];
      if (!part) throw new Error(`Private state path contains an empty segment: ${absolute}`);
      current = join(current, part);
    }
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (isMissing(error)) {
        if (requireLeaf) throw new Error(`Private state directory does not exist: ${current}`);
        return absolute;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Private state directory component is a symbolic link, junction, or reparse point: ${current}`);
    }
    if (!stats.isDirectory()) throw new Error(`Private state path component is not a directory: ${current}`);
    assertCanonicalPath(current, "Private state directory component");
  }
  return absolute;
}

function assertRegularUnlinkedFile(path: string): Stats {
  const absolute = resolve(path);
  assertSafeDirectoryPath(dirname(absolute), true);
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink()) {
    throw new Error("Private state file is a symbolic link or reparse point");
  }
  if (!stats.isFile()) throw new Error("Private state path is not a regular file");
  if (stats.nlink !== 1) throw new Error("Private state file has hard links");
  assertCanonicalPath(absolute, "Private state file");
  return stats;
}

function assertSameFile(left: Stats, right: Stats): void {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error("Private state file changed while it was being secured");
  }
}

/** Reject redirects and hard links before any recursive Windows ACL operation. */
function assertSafePrivateTree(root: string): void {
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    for (const name of readdirSync(directory)) {
      visited += 1;
      if (visited > 100_000) throw new Error("Private state tree exceeds the safety traversal limit");
      const child = join(directory, name);
      const stats = lstatSync(child);
      if (stats.isSymbolicLink()) {
        throw new Error(`Private state tree contains a symbolic link, junction, or reparse point: ${child}`);
      }
      assertCanonicalPath(child, "Private state tree entry");
      if (stats.isDirectory()) pending.push(child);
      else if (!stats.isFile()) throw new Error(`Private state tree contains a non-file entry: ${child}`);
      else if (stats.nlink !== 1) throw new Error(`Private state tree contains a hard-linked file: ${child}`);
    }
  }
}

export function secureStateDirectory(path: string): StateSecurityResult {
  try {
    const absolute = assertSafeDirectoryPath(path, false);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    assertSafeDirectoryPath(absolute, true);
    if (process.platform !== "win32") {
      chmodSync(absolute, 0o700);
      assertSafeDirectoryPath(absolute, true);
      assertSafePrivateTree(absolute);
      return { hardened: true, detail: "mode 0700" };
    }

    const whoami = resolveWindowsSystemExecutable("whoami.exe");
    const icacls = resolveWindowsSystemExecutable("icacls.exe");
    const csv = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const match = csv.match(/"[^"]+","([^"]+)"/);
    if (!match?.[1]) throw new Error("Unable to determine the current Windows SID");
    execFileSync(icacls, [absolute, "/inheritance:r", "/grant:r", `*${match[1]}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/Q"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (readdirSync(absolute).length > 0) {
      assertSafePrivateTree(absolute);
      execFileSync(icacls, [join(absolute, "*"), "/reset", "/T", "/C", "/Q"], {
        encoding: "utf8",
        windowsHide: true,
      });
    }
    assertSafeDirectoryPath(absolute, true);
    assertSafePrivateTree(absolute);
    return { hardened: true, detail: "private Windows ACL" };
  } catch (error) {
    return { hardened: false, detail: errorDetail(error) };
  }
}

export function securePrivateFile(path: string): StateSecurityResult {
  let descriptor: number | undefined;
  try {
    const absolute = resolve(path);
    const before = assertRegularUnlinkedFile(absolute);
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    descriptor = openSync(absolute, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error("Private state path is not a regular file");
    if (opened.nlink !== 1) throw new Error("Private state file has hard links");
    assertSameFile(before, opened);

    let detail: string;
    if (process.platform !== "win32") {
      fchmodSync(descriptor, 0o600);
      detail = "mode 0600";
    } else {
      const whoami = resolveWindowsSystemExecutable("whoami.exe");
      const icacls = resolveWindowsSystemExecutable("icacls.exe");
      const csv = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
      const match = csv.match(/"[^"]+","([^"]+)"/);
      if (!match?.[1]) throw new Error("Unable to determine the current Windows SID");
      execFileSync(icacls, [absolute, "/inheritance:r", "/grant:r", `*${match[1]}:F`, "*S-1-5-18:F", "*S-1-5-32-544:F", "/Q"], {
        encoding: "utf8",
        windowsHide: true,
      });
      detail = "private Windows file ACL";
    }

    const after = assertRegularUnlinkedFile(absolute);
    const openedAfter = fstatSync(descriptor);
    if (openedAfter.nlink !== 1) throw new Error("Private state file acquired hard links while it was being secured");
    assertSameFile(opened, openedAfter);
    assertSameFile(opened, after);
    return { hardened: true, detail };
  } catch (error) {
    return { hardened: false, detail: errorDetail(error) };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/** Durably replace a private text file without exposing a truncated final path. */
export function writePrivateFileAtomic(path: string, content: string): void {
  const absolute = resolve(path);
  const directory = dirname(absolute);
  const directorySecurity = secureStateDirectory(directory);
  if (!directorySecurity.hardened) throw new Error(`Could not secure private directory: ${directorySecurity.detail}`);
  const temporary = join(directory, `.${randomUUID()}.superai.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const temporarySecurity = securePrivateFile(temporary);
    if (!temporarySecurity.hardened) throw new Error(`Could not secure temporary private file: ${temporarySecurity.detail}`);

    try {
      assertRegularUnlinkedFile(absolute);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    assertSafeDirectoryPath(directory, true);
    renameSync(temporary, absolute);
    const finalSecurity = securePrivateFile(absolute);
    if (!finalSecurity.hardened) throw new Error(`Could not secure private file: ${finalSecurity.detail}`);

    if (process.platform !== "win32") {
      const directoryDescriptor = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      /* renamed or already removed */
    }
  }
}
