import { realpathSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface TrustedExecutableOptions {
  /** Bare-name resolution skips these directory trees (normally the active workspace). */
  rejectRoots?: readonly string[];
  /** Test/embedding override. The normal value is the current process PATH. */
  pathValue?: string;
}

/**
 * Resolve a program to a canonical absolute file before spawning it. This
 * avoids Windows CreateProcess searching the current workspace before PATH.
 * Relative paths with separators are deliberately refused; use either a bare
 * trusted name or an explicit absolute path.
 */
export function resolveTrustedExecutable(command: string, options: TrustedExecutableOptions = {}): string {
  const value = command.trim();
  if (!value || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Executable name is empty, too long, or contains control characters");
  }
  if (isAbsolute(value)) return validateExecutableFile(value);
  if (value.includes("/") || value.includes("\\")) {
    throw new Error("Executable paths must be absolute");
  }
  if (process.platform === "win32" && extname(value) && extname(value).toLocaleLowerCase() !== ".exe") {
    throw new Error("Only native .exe programs may be resolved on Windows");
  }

  const rejectRoots = (options.rejectRoots ?? [process.cwd()]).map((root) => canonicalDirectory(root));
  const pathValue = options.pathValue ?? environmentValue("PATH") ?? "";
  const names = process.platform === "win32" ? (extname(value) ? [value] : [`${value}.exe`]) : [value];
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/gu, "");
    if (!directory || !isAbsolute(directory)) continue;
    for (const name of names) {
      try {
        const candidate = validateExecutableFile(join(directory, name));
        if (rejectRoots.some((root) => isInside(root, candidate))) continue;
        return candidate;
      } catch {
        // Continue through absolute PATH entries only.
      }
    }
  }
  throw new Error(`Trusted executable was not found on an absolute PATH entry: ${value}`);
}

/** Resolve a Windows inbox executable without consulting cwd or PATH. */
export function resolveWindowsSystemExecutable(name: string): string {
  if (process.platform !== "win32") throw new Error(`${name} is a Windows-only system executable`);
  if (!/^[A-Za-z0-9._-]+\.exe$/u.test(name)) throw new Error("Windows system executable name is invalid");
  const windowsRoot = environmentValue("SystemRoot") ?? environmentValue("WINDIR");
  if (!windowsRoot || !isAbsolute(windowsRoot)) throw new Error("Windows system root is unavailable");
  const systemDirectory = realpathSync.native(join(windowsRoot, "System32"));
  const executable = validateExecutableFile(join(systemDirectory, name));
  if (!isInside(systemDirectory, executable)) throw new Error("Windows system executable escaped System32");
  return executable;
}

function validateExecutableFile(path: string): string {
  const canonical = realpathSync.native(resolve(path));
  const info = statSync(canonical);
  if (!info.isFile()) throw new Error("Executable path is not a regular file");
  if (process.platform !== "win32" && (info.mode & 0o111) === 0) throw new Error("Executable file is not marked executable");
  return canonical;
}

function canonicalDirectory(path: string): string {
  try {
    const canonical = realpathSync.native(resolve(path));
    return statSync(canonical).isDirectory() ? canonical : dirname(canonical);
  } catch {
    return resolve(path);
  }
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLocaleLowerCase() : root;
  const normalizedCandidate = process.platform === "win32" ? candidate.toLocaleLowerCase() : candidate;
  const result = relative(normalizedRoot, normalizedCandidate);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function environmentValue(name: string): string | undefined {
  if (process.platform !== "win32") return process.env[name];
  const key = Object.keys(process.env).find((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase());
  return key ? process.env[key] : undefined;
}
