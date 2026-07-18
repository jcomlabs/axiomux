import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, type Stats } from "node:fs";
import { lstat, link, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { HostTool, HostToolContext, HostToolResult } from "../types.js";
import { redactSecrets } from "../security/secrets.js";
import { resolveTrustedExecutable, resolveWindowsSystemExecutable } from "../security/executable.js";
import { captureWorkspaceIdentity, revalidateWorkspaceIdentity, type WorkspaceIdentity } from "../runtime/project-boundary.js";
import { workspaceHostToolName } from "./names.js";

export const GOVERNED_WORKSPACE_TOOLS = Object.freeze(["read", "grep", "glob", "edit", "write", "bash", "python"] as const);

export type WorkspaceToolCapability = (typeof GOVERNED_WORKSPACE_TOOLS)[number];

/**
 * Native OMP tools kept after the host takes ownership of filesystem and
 * process access. `web_search` remains subject to OMP's prompt approval policy.
 * Filesystem, image-path, LSP, browser and shell surfaces are deliberately not
 * considered safe native fallbacks.
 */
export const SAFE_NATIVE_OMP_TOOLS = Object.freeze(["todo", "web_search"] as const);

export const KNOWN_SUPERAI_TOOL_CAPABILITIES = Object.freeze([...GOVERNED_WORKSPACE_TOOLS, ...SAFE_NATIVE_OMP_TOOLS, "browser_task", "computer_use"] as const);

export interface OmpToolPartition {
  host: WorkspaceToolCapability[];
  native: string[];
  blocked: string[];
}

export interface WorkspaceToolLimits {
  maxReadBytes: number;
  maxReadLines: number;
  maxScanFileBytes: number;
  maxScanFiles: number;
  maxTraversalEntries: number;
  maxGrepResults: number;
  maxGlobResults: number;
  maxOutputBytes: number;
  maxWriteBytes: number;
  maxEditBytes: number;
  maxCommandOutputBytes: number;
  commandTimeoutMs: number;
  maxCommandTimeoutMs: number;
}

export type WorkspaceToolAuditOutcome = "requested" | "completed" | "denied" | "failed";

export interface WorkspaceToolAuditEvent {
  at: string;
  capability: WorkspaceToolCapability;
  outcome: WorkspaceToolAuditOutcome;
  target: string;
  details?: Record<string, unknown>;
}

export type WorkspaceMutationCapability = "edit" | "write" | "bash" | "python";

export type WorkspaceEffectRunner = (
  capability: WorkspaceMutationCapability,
  arguments_: Record<string, unknown>,
  context: HostToolContext,
  run: () => Promise<HostToolResult>,
) => Promise<HostToolResult>;

export interface WorkspaceToolOptions {
  root: string;
  /** Fixed identity captured when the project was linked/agent was created. */
  rootIdentity?: WorkspaceIdentity;
  capabilities: readonly string[];
  approve?: (description: string) => Promise<boolean>;
  /** Required for mutating tools; the caller supplies its durable effect ledger. */
  effect?: WorkspaceEffectRunner;
  audit?: (event: WorkspaceToolAuditEvent) => void;
  limits?: Partial<WorkspaceToolLimits>;
  /** Direct executable names or exact absolute paths. Shells are always denied. */
  commandAllowlist?: readonly string[];
  /** Additional non-secret environment variable names to copy into commands. */
  commandEnvAllowlist?: readonly string[];
  /** Interpreter used by the governed `python` tool. Defaults to `python`. */
  pythonExecutable?: string;
  excludedDirectories?: readonly string[];
}

export class WorkspaceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
  }
}

export class WorkspaceApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceApprovalError";
  }
}

const DEFAULT_LIMITS: WorkspaceToolLimits = Object.freeze({
  maxReadBytes: 128 * 1024,
  maxReadLines: 1_000,
  maxScanFileBytes: 512 * 1024,
  maxScanFiles: 2_000,
  maxTraversalEntries: 20_000,
  maxGrepResults: 200,
  maxGlobResults: 500,
  maxOutputBytes: 256 * 1024,
  maxWriteBytes: 512 * 1024,
  maxEditBytes: 1024 * 1024,
  maxCommandOutputBytes: 256 * 1024,
  commandTimeoutMs: 30_000,
  maxCommandTimeoutMs: 120_000,
});

const DEFAULT_COMMAND_ALLOWLIST = Object.freeze(["node", "node.exe"]);

const DEFAULT_COMMAND_ENV = Object.freeze(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM"]);

const MAX_APPROVAL_PAYLOAD_BYTES = 6_000;
const MAX_GLOB_TOKENS = 128;
const MAX_GLOB_MATCH_COST = 5_000_000;

const ALWAYS_DENIED_EXECUTABLES = new Set([
  "bash",
  "bash.exe",
  "cmd",
  "cmd.exe",
  "command.com",
  "fish",
  "fish.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "sh.exe",
  "wsl",
  "wsl.exe",
  "zsh",
  "zsh.exe",
]);

const SECRET_CONFIG_NAMES = new Set([".git-credentials", ".netrc", ".npmrc", ".pypirc"]);

const SECRET_DIRECTORIES = new Set([".aws", ".azure", ".gnupg", ".kube", ".ssh"]);

const SECRET_FILE_PATTERN = /^(?:auth|credentials?|secrets?|tokens?)(?:\.(?:conf(?:ig)?|db|ini|json|sqlite\d*|text|txt|toml|ya?ml))?$/i;
const GOVERNED_SET = new Set<string>(GOVERNED_WORKSPACE_TOOLS);
const SAFE_NATIVE_SET = new Set<string>(SAFE_NATIVE_OMP_TOOLS);

export function partitionOmpTools(capabilities: readonly string[]): OmpToolPartition {
  const host: WorkspaceToolCapability[] = [];
  const native: string[] = [];
  const blocked: string[] = [];
  for (const capability of new Set(capabilities)) {
    if (GOVERNED_SET.has(capability)) {
      host.push(capability as WorkspaceToolCapability);
    } else if (SAFE_NATIVE_SET.has(capability)) {
      native.push(capability);
    } else {
      blocked.push(capability);
    }
  }
  return { host, native, blocked };
}

export function isKnownSuperAIToolCapability(capability: string): boolean {
  return (KNOWN_SUPERAI_TOOL_CAPABILITIES as readonly string[]).includes(capability);
}

export interface GovernedWorkspaceTextFile {
  absolute: string;
  relative: string;
  content: string;
  bytes: number;
}

/** Shared secure-open boundary for non-tool workspace ingestion APIs. */
export async function readGovernedWorkspaceTextFile(
  root: string,
  path: string,
  maxBytes: number,
  signal: AbortSignal = new AbortController().signal,
  rootIdentity?: WorkspaceIdentity,
): Promise<GovernedWorkspaceTextFile> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) {
    throw new WorkspaceBoundaryError("Governed workspace read limit is invalid");
  }
  const boundary = new WorkspaceBoundary(root, rootIdentity);
  const target = await boundary.resolveExisting(path, "file");
  const result = await readTextPrefix(boundary, target.absolute, maxBytes, signal);
  if (result.truncated) throw new WorkspaceBoundaryError(`File exceeds ${maxBytes} bytes`);
  return { absolute: target.absolute, relative: target.relative, content: result.text, bytes: result.bytesRead };
}

export function createWorkspaceTools(options: WorkspaceToolOptions): HostTool[] {
  const boundary = new WorkspaceBoundary(options.root, options.rootIdentity);
  const limits = normalizeLimits(options.limits);
  const capabilities = new Set(partitionOmpTools(options.capabilities).host);
  const excludedDirectories = new Set((options.excludedDirectories ?? [".git", "dist", "node_modules"]).map((value) => value.toLocaleLowerCase()));
  const commandAllowlist = normalizeExecutableAllowlist(options.commandAllowlist ?? DEFAULT_COMMAND_ALLOWLIST, boundary.root);
  const pythonExecutable = options.pythonExecutable?.trim() || "python";
  const pythonAllowlist = normalizeExecutableAllowlist([pythonExecutable], boundary.root);
  const tools: HostTool[] = [];

  const add = (
    capability: WorkspaceToolCapability,
    tool: Omit<HostTool, "execute"> & {
      execute: (arguments_: Record<string, unknown>, context: HostToolContext) => Promise<HostToolResult>;
    },
  ): void => {
    if (!capabilities.has(capability)) return;
    tools.push({
      ...tool,
      execute: async (arguments_, context) => {
        boundary.revalidateRoot();
        return auditedExecution(capability, auditTarget(capability, arguments_), options.audit, () => tool.execute(arguments_, context));
      },
    });
  };

  add("read", {
    name: workspaceHostToolName("read"),
    description:
      "Read a bounded UTF-8 text prefix inside the current workspace. Sensitive paths and symlink/junction escapes are denied; the access is audited.",
    parameters: objectSchema(
      {
        path: { type: "string", description: "Workspace-relative path (an absolute path is accepted only when it is inside the workspace)." },
        max_lines: { type: "integer", minimum: 1, maximum: limits.maxReadLines },
      },
      ["path"],
    ),
    execute: async (arguments_, context) => {
      assertOnlyKeys(arguments_, ["path", "max_lines"]);
      throwIfAborted(context.signal);
      const target = await boundary.resolveExisting(requireString(arguments_, "path"), "file");
      const requestedLines = optionalInteger(arguments_, "max_lines", limits.maxReadLines, 1, limits.maxReadLines);
      const prefix = await readTextPrefix(boundary, target.absolute, limits.maxReadBytes, context.signal);
      const lines = prefix.text.split(/\r?\n/u);
      const lineTruncated = lines.length > requestedLines;
      const selected = lines.slice(0, requestedLines).join("\n");
      const bounded = boundUtf8(redactSecrets(selected), limits.maxOutputBytes);
      const truncated = prefix.truncated || lineTruncated || bounded.truncated;
      return textResult(withTruncationNotice(bounded.text, truncated, limits.maxOutputBytes), {
        path: target.relative,
        bytesRead: prefix.bytesRead,
        fileBytes: prefix.fileBytes,
        linesReturned: Math.min(lines.length, requestedLines),
        truncated,
      });
    },
  });

  add("grep", {
    name: workspaceHostToolName("grep"),
    description: "Search bounded text files for a literal string inside the workspace. Traversal skips secret paths, excluded directories and links.",
    parameters: objectSchema(
      {
        pattern: { type: "string", minLength: 1, maxLength: 512 },
        path: { type: "string", default: "." },
        case_sensitive: { type: "boolean", default: false },
        max_results: { type: "integer", minimum: 1, maximum: limits.maxGrepResults },
      },
      ["pattern"],
    ),
    execute: async (arguments_, context) => {
      assertOnlyKeys(arguments_, ["pattern", "path", "case_sensitive", "max_results"]);
      const pattern = requireString(arguments_, "pattern", 512);
      const target = await boundary.resolveExisting(optionalString(arguments_, "path") ?? ".", "any");
      if (isExcludedPath(target.relative, excludedDirectories)) throw new WorkspaceBoundaryError("Grep target is inside an excluded directory");
      const caseSensitive = arguments_.case_sensitive === true;
      const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase();
      const maxResults = optionalInteger(arguments_, "max_results", limits.maxGrepResults, 1, limits.maxGrepResults);
      const matches: string[] = [];
      let filesScanned = 0;
      let truncatedFiles = 0;
      let traversalTruncated = false;

      const inspectFile = async (absolute: string, relativePath: string): Promise<boolean> => {
        if (filesScanned >= limits.maxScanFiles) {
          traversalTruncated = true;
          return false;
        }
        filesScanned += 1;
        const prefix = await readTextPrefix(boundary, absolute, limits.maxScanFileBytes, context.signal, true);
        if (prefix.binary) return true;
        if (prefix.truncated) truncatedFiles += 1;
        const lines = prefix.text.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          const haystack = caseSensitive ? line : line.toLocaleLowerCase();
          if (!haystack.includes(needle)) continue;
          const clipped = boundUtf8(redactSecrets(line), 1_000).text;
          matches.push(`${toPosix(relativePath)}:${index + 1}:${clipped}`);
          if (matches.length >= maxResults) {
            traversalTruncated = true;
            return false;
          }
        }
        return true;
      };

      if (target.stat.isFile()) {
        await inspectFile(target.absolute, target.relative);
      } else {
        const walk = await walkWorkspace(target.absolute, boundary, limits, excludedDirectories, context.signal, async (entry) => {
          if (!entry.stat.isFile()) return true;
          return inspectFile(entry.absolute, entry.relative);
        });
        traversalTruncated ||= walk.truncated;
      }
      const bounded = boundUtf8(matches.join("\n") || "No matches found.", limits.maxOutputBytes);
      const truncated = traversalTruncated || bounded.truncated;
      return textResult(withTruncationNotice(bounded.text, truncated, limits.maxOutputBytes), {
        patternHash: sha256(pattern),
        matches: matches.length,
        filesScanned,
        truncatedFiles,
        truncated,
      });
    },
  });

  add("glob", {
    name: workspaceHostToolName("glob"),
    description: "List a bounded set of workspace paths using *, ** and ? globs. Sensitive paths, excluded directories and links are never returned.",
    parameters: objectSchema(
      {
        pattern: { type: "string", minLength: 1, maxLength: 512 },
        include_directories: { type: "boolean", default: false },
        max_results: { type: "integer", minimum: 1, maximum: limits.maxGlobResults },
      },
      ["pattern"],
    ),
    execute: async (arguments_, context) => {
      assertOnlyKeys(arguments_, ["pattern", "include_directories", "max_results"]);
      const pattern = normalizeGlob(requireString(arguments_, "pattern", 512));
      assertGlobIsNonSensitive(pattern);
      const matcher = compileGlob(pattern);
      const includeDirectories = arguments_.include_directories === true;
      const maxResults = optionalInteger(arguments_, "max_results", limits.maxGlobResults, 1, limits.maxGlobResults);
      const results: string[] = [];
      let matchCost = 0;
      const walk = await walkWorkspace(boundary.root, boundary, limits, excludedDirectories, context.signal, async (entry) => {
        if (!entry.stat.isFile() && !(includeDirectories && entry.stat.isDirectory())) return true;
        const relativePath = toPosix(entry.relative);
        matchCost += matcher.length * (relativePath.length + 1);
        if (matchCost > MAX_GLOB_MATCH_COST) return false;
        if (!globMatches(matcher, relativePath)) return true;
        results.push(toPosix(entry.relative));
        return results.length < maxResults;
      });
      results.sort((left, right) => left.localeCompare(right));
      const bounded = boundUtf8(redactSecrets(results.join("\n") || "No paths matched."), limits.maxOutputBytes);
      const truncated = walk.truncated || results.length >= maxResults || bounded.truncated;
      return textResult(withTruncationNotice(bounded.text, truncated, limits.maxOutputBytes), {
        matches: results.length,
        entriesScanned: walk.entriesScanned,
        skippedLinks: walk.skippedLinks,
        matchCost: Math.min(matchCost, MAX_GLOB_MATCH_COST),
        truncated,
      });
    },
  });

  add("write", {
    name: workspaceHostToolName("write"),
    description:
      "Write a bounded UTF-8 file inside an existing workspace directory. Every mutation requires explicit approval and is intended to be wrapped by the caller's effect ledger.",
    parameters: objectSchema(
      {
        path: { type: "string" },
        content: { type: "string", maxLength: Math.min(limits.maxWriteBytes, 4_000) },
        overwrite: { type: "boolean", default: false },
      },
      ["path", "content"],
    ),
    execute: async (arguments_, context) => {
      assertOnlyKeys(arguments_, ["path", "content", "overwrite"]);
      const path = requireString(arguments_, "path");
      const content = requireText(arguments_, "content", Math.min(limits.maxWriteBytes, 4_000));
      const overwrite = arguments_.overwrite === true;
      const initial = await boundary.resolveWritable(path);
      if (initial.exists && !overwrite) throw new WorkspaceBoundaryError(`Refusing to overwrite existing file without overwrite=true: ${initial.relative}`);
      await requireApproval(
        options.approve,
        visibleApproval("Write workspace file?", {
          path: initial.relative,
          overwrite: initial.exists,
          bytes: Buffer.byteLength(content),
          sha256: sha256(content),
          completeContent: content,
        }),
        context.signal,
      );
      return runEffect(options.effect, "write", arguments_, context, async () => {
        const verified = await boundary.resolveWritable(path);
        if (verified.absolute !== initial.absolute || verified.exists !== initial.exists)
          throw new WorkspaceBoundaryError("Write target changed while approval was pending");
        throwIfAborted(context.signal);
        await commitTextFile(boundary, path, verified, content, context.signal);
        return textResult(`Wrote ${Buffer.byteLength(content)} bytes to ${verified.relative}.`, {
          path: verified.relative,
          bytesWritten: Buffer.byteLength(content),
          created: !verified.exists,
        });
      });
    },
  });

  add("edit", {
    name: workspaceHostToolName("edit"),
    description: "Replace exact text in a bounded workspace file. The file is revalidated after explicit approval and concurrent changes fail closed.",
    parameters: objectSchema(
      {
        path: { type: "string" },
        old_text: { type: "string", minLength: 1, maxLength: Math.min(limits.maxEditBytes, 4_000) },
        new_text: { type: "string", maxLength: Math.min(limits.maxEditBytes, 4_000) },
        replace_all: { type: "boolean", default: false },
      },
      ["path", "old_text", "new_text"],
    ),
    execute: async (arguments_, context) => {
      assertOnlyKeys(arguments_, ["path", "old_text", "new_text", "replace_all"]);
      const path = requireString(arguments_, "path");
      const oldText = requireString(arguments_, "old_text", Math.min(limits.maxEditBytes, 4_000), false);
      const newText = requireText(arguments_, "new_text", Math.min(limits.maxEditBytes, 4_000));
      const replaceAll = arguments_.replace_all === true;
      const initial = await boundary.resolveExisting(path, "file", true);
      const before = await readWholeText(boundary, initial.absolute, limits.maxEditBytes, context.signal);
      const occurrences = countOccurrences(before, oldText);
      if (occurrences === 0) throw new WorkspaceBoundaryError("old_text was not found");
      if (!replaceAll && occurrences !== 1)
        throw new WorkspaceBoundaryError(`old_text occurs ${occurrences} times; set replace_all=true or provide a unique match`);
      const replacementCount = replaceAll ? occurrences : 1;
      const projectedBytes = Buffer.byteLength(before) - replacementCount * Buffer.byteLength(oldText) + replacementCount * Buffer.byteLength(newText);
      if (!Number.isSafeInteger(projectedBytes) || projectedBytes > limits.maxEditBytes) {
        throw new WorkspaceBoundaryError(`Edited file would exceed ${limits.maxEditBytes} bytes`);
      }
      const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
      if (Buffer.byteLength(after) !== projectedBytes) throw new WorkspaceBoundaryError("Edited file size validation failed");
      const beforeHash = sha256(before);
      await requireApproval(
        options.approve,
        visibleApproval("Edit workspace file?", {
          path: initial.relative,
          replacements: replacementCount,
          resultBytes: projectedBytes,
          oldText,
          newText,
          beforeSha256: beforeHash,
          afterSha256: sha256(after),
        }),
        context.signal,
      );
      return runEffect(options.effect, "edit", arguments_, context, async () => {
        const verified = await boundary.resolveExisting(path, "file", true);
        if (verified.absolute !== initial.absolute) throw new WorkspaceBoundaryError("Edit target changed while approval was pending");
        const current = await readWholeText(boundary, verified.absolute, limits.maxEditBytes, context.signal);
        if (sha256(current) !== beforeHash) throw new WorkspaceBoundaryError("File changed while approval was pending; edit was not applied");
        await commitTextFile(boundary, path, { absolute: verified.absolute, relative: verified.relative, exists: true }, after, context.signal);
        return textResult(`Edited ${verified.relative}.`, {
          path: verified.relative,
          replacements: replaceAll ? occurrences : 1,
          bytesWritten: Buffer.byteLength(after),
        });
      });
    },
  });

  add("bash", {
    name: workspaceHostToolName("bash"),
    description:
      "Run an approved executable with an explicit argv, no shell, workspace cwd, reduced environment, timeout and bounded output. This is not an OS sandbox.",
    parameters: objectSchema(
      {
        executable: { type: "string", minLength: 1, maxLength: 1_024 },
        args: { type: "array", items: { type: "string", maxLength: 8_192 }, maxItems: 64, default: [] },
        timeout_ms: { type: "integer", minimum: 100, maximum: limits.maxCommandTimeoutMs },
      },
      ["executable"],
    ),
    execute: async (arguments_, context) => {
      assertOnlyKeys(arguments_, ["executable", "args", "timeout_ms"]);
      const executable = requireString(arguments_, "executable", 1_024);
      const args = optionalStringArray(arguments_, "args", 64, 8_192);
      const resolvedExecutable = resolveAllowedExecutable(executable, commandAllowlist, boundary);
      const timeoutMs = optionalInteger(arguments_, "timeout_ms", limits.commandTimeoutMs, 100, limits.maxCommandTimeoutMs);
      await requireApproval(options.approve, commandApprovalDescription(resolvedExecutable, args), context.signal);
      return runEffect(options.effect, "bash", arguments_, context, async () => {
        boundary.revalidateRoot();
        const environment = reducedEnvironment(boundary.root, options.commandEnvAllowlist);
        try {
          boundary.revalidateRoot();
          const result = await runDirectCommand({
            executable: resolvedExecutable,
            args,
            cwd: boundary.root,
            env: environment.env,
            timeoutMs,
            maxOutputBytes: limits.maxCommandOutputBytes,
            signal: context.signal,
          });
          return commandResult(resolvedExecutable, args, result, limits.maxOutputBytes);
        } finally {
          environment.cleanup();
        }
      });
    },
  });

  add("python", {
    name: workspaceHostToolName("python"),
    description:
      "Run approved Python code with -I, no shell, workspace cwd, reduced environment, timeout and bounded output. Approval is the boundary; this is not an OS sandbox.",
    parameters: objectSchema(
      {
        code: { type: "string", minLength: 1, maxLength: Math.min(limits.maxWriteBytes, MAX_APPROVAL_PAYLOAD_BYTES) },
        args: { type: "array", items: { type: "string", maxLength: 8_192 }, maxItems: 64, default: [] },
        timeout_ms: { type: "integer", minimum: 100, maximum: limits.maxCommandTimeoutMs },
      },
      ["code"],
    ),
    execute: async (arguments_, context) => {
      assertOnlyKeys(arguments_, ["code", "args", "timeout_ms"]);
      const code = requireText(arguments_, "code", Math.min(limits.maxWriteBytes, MAX_APPROVAL_PAYLOAD_BYTES));
      if (!code) throw new WorkspaceBoundaryError("code is required");
      const args = optionalStringArray(arguments_, "args", 64, 8_192);
      const resolvedPython = resolveAllowedExecutable(pythonExecutable, pythonAllowlist, boundary);
      const timeoutMs = optionalInteger(arguments_, "timeout_ms", limits.commandTimeoutMs, 100, limits.maxCommandTimeoutMs);
      const approval = `WARNING: THIS PROCESS IS NOT AN OS SANDBOX. IT MAY READ, WRITE OR USE THE NETWORK OUTSIDE THE WORKSPACE; APPROVAL ALSO TRUSTS IMPORTS AND DEPENDENCIES LOADED BY THE CODE.\nRun ${resolvedPython} -I without a shell (code sha256 ${sha256(code)}, ${Buffer.byteLength(code)} bytes). Complete JSON-escaped code and argv data follow:\ncode=${JSON.stringify(code)}\nargv=${JSON.stringify(args)}`;
      if (Buffer.byteLength(approval) > MAX_APPROVAL_PAYLOAD_BYTES + 1_000)
        throw new WorkspaceBoundaryError("Python approval payload is too large to display completely");
      await requireApproval(options.approve, approval, context.signal);
      const commandArgs = ["-I", "-c", code, ...args];
      return runEffect(options.effect, "python", arguments_, context, async () => {
        boundary.revalidateRoot();
        const environment = reducedEnvironment(boundary.root, options.commandEnvAllowlist);
        try {
          boundary.revalidateRoot();
          const result = await runDirectCommand({
            executable: resolvedPython,
            args: commandArgs,
            cwd: boundary.root,
            env: environment.env,
            timeoutMs,
            maxOutputBytes: limits.maxCommandOutputBytes,
            signal: context.signal,
          });
          return commandResult(resolvedPython, commandArgs, result, limits.maxOutputBytes);
        } finally {
          environment.cleanup();
        }
      });
    },
  });

  return tools;
}

interface ResolvedWorkspacePath {
  absolute: string;
  relative: string;
  stat: Stats;
}

interface WritableWorkspacePath {
  absolute: string;
  relative: string;
  exists: boolean;
}

class WorkspaceBoundary {
  readonly root: string;
  private readonly lexicalRoot: string;
  private readonly identity: WorkspaceIdentity;

  constructor(root: string, identity?: WorkspaceIdentity) {
    if (!root.trim()) throw new WorkspaceBoundaryError("Workspace root is required");
    try {
      this.identity = identity ?? captureWorkspaceIdentity(root);
      const requested = realpathSync.native(resolve(root));
      if (!samePath(requested, this.identity.rootPath)) {
        throw new Error("Workspace root does not match its fixed project identity");
      }
      this.root = revalidateWorkspaceIdentity(this.identity);
      this.lexicalRoot = this.identity.lexicalRoot;
    } catch (error) {
      throw new WorkspaceBoundaryError(error instanceof Error ? error.message : String(error));
    }
  }

  revalidateRoot(): void {
    try {
      revalidateWorkspaceIdentity(this.identity);
    } catch (error) {
      throw new WorkspaceBoundaryError(error instanceof Error ? error.message : String(error));
    }
  }

  async resolveExisting(input: string, expected: "file" | "directory" | "any", rejectFinalLink = false): Promise<ResolvedWorkspacePath> {
    const lexical = this.lexicalCandidate(input);
    if (rejectFinalLink && lstatSync(lexical).isSymbolicLink()) throw new WorkspaceBoundaryError("Writes through symbolic links or junctions are denied");
    const canonical = await realpath(lexical);
    this.assertInside(canonical);
    const relativePath = this.relative(canonical);
    assertNonSensitive(relativePath);
    const info = await stat(canonical);
    if (expected === "file" && !info.isFile()) throw new WorkspaceBoundaryError(`Expected a regular file: ${relativePath}`);
    if (expected === "directory" && !info.isDirectory()) throw new WorkspaceBoundaryError(`Expected a directory: ${relativePath}`);
    if (expected === "any" && !info.isFile() && !info.isDirectory()) throw new WorkspaceBoundaryError(`Unsupported workspace path type: ${relativePath}`);
    if (info.isFile() && info.nlink > 1) throw new WorkspaceBoundaryError("Files with multiple hard links are denied because path provenance cannot be proven");
    return { absolute: canonical, relative: relativePath, stat: info };
  }

  async resolveWritable(input: string): Promise<WritableWorkspacePath> {
    const lexical = this.lexicalCandidate(input);
    let existing: Stats | undefined;
    try {
      existing = await lstat(lexical);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (existing) {
      if (existing.isSymbolicLink()) throw new WorkspaceBoundaryError("Writes through symbolic links or junctions are denied");
      if (!existing.isFile()) throw new WorkspaceBoundaryError("Write target must be a regular file");
      if (existing.nlink > 1) throw new WorkspaceBoundaryError("Writes to files with multiple hard links are denied");
      const canonical = await realpath(lexical);
      this.assertInside(canonical);
      const relativePath = this.relative(canonical);
      assertNonSensitive(relativePath);
      return { absolute: canonical, relative: relativePath, exists: true };
    }
    const parentLexical = dirname(lexical);
    const parentInfo = await lstat(parentLexical);
    if (parentInfo.isSymbolicLink()) throw new WorkspaceBoundaryError("Writes through symbolic-link or junction parents are denied");
    const parentCanonical = await realpath(parentLexical);
    this.assertInside(parentCanonical);
    const canonical = join(parentCanonical, basename(lexical));
    this.assertInside(canonical);
    const relativePath = this.relative(canonical);
    assertNonSensitive(relativePath);
    return { absolute: canonical, relative: relativePath, exists: false };
  }

  relative(absolute: string): string {
    this.assertInside(absolute);
    return relative(this.root, absolute) || ".";
  }

  assertInside(absolute: string): void {
    if (!isInside(this.root, absolute)) throw new WorkspaceBoundaryError("Path escapes the workspace root");
  }

  isSensitive(relativePath: string): boolean {
    return sensitiveReason(relativePath) !== undefined;
  }

  private lexicalCandidate(input: string): string {
    this.revalidateRoot();
    const value = validatePathInput(input);
    const candidate = isAbsolute(value) ? resolve(value) : resolve(this.lexicalRoot, value);
    if (!isInside(this.lexicalRoot, candidate)) throw new WorkspaceBoundaryError("Path escapes the workspace root");
    assertNonSensitive(relative(this.lexicalRoot, candidate) || ".");
    return candidate;
  }
}

interface WalkEntry extends ResolvedWorkspacePath {}

interface WalkResult {
  entriesScanned: number;
  skippedLinks: number;
  truncated: boolean;
}

async function walkWorkspace(
  start: string,
  boundary: WorkspaceBoundary,
  limits: WorkspaceToolLimits,
  excludedDirectories: ReadonlySet<string>,
  signal: AbortSignal,
  visitor: (entry: WalkEntry) => Promise<boolean>,
): Promise<WalkResult> {
  const directories = [start];
  let entriesScanned = 0;
  let skippedLinks = 0;
  let truncated = false;
  while (directories.length > 0) {
    throwIfAborted(signal);
    boundary.revalidateRoot();
    const directory = directories.shift();
    if (!directory) break;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      entriesScanned += 1;
      if (entriesScanned > limits.maxTraversalEntries) {
        truncated = true;
        return { entriesScanned: entriesScanned - 1, skippedLinks, truncated };
      }
      const lexical = join(directory, entry.name);
      const relativePath = boundary.relative(lexical);
      if (boundary.isSensitive(relativePath)) continue;
      const info = await lstat(lexical);
      if (info.isSymbolicLink()) {
        skippedLinks += 1;
        continue;
      }
      const canonical = await realpath(lexical);
      boundary.assertInside(canonical);
      const canonicalRelative = boundary.relative(canonical);
      if (boundary.isSensitive(canonicalRelative)) continue;
      const canonicalInfo = await stat(canonical);
      if (canonicalInfo.isDirectory() && excludedDirectories.has(entry.name.toLocaleLowerCase())) continue;
      const shouldContinue = await visitor({ absolute: canonical, relative: canonicalRelative, stat: canonicalInfo });
      if (!shouldContinue) return { entriesScanned, skippedLinks, truncated: true };
      if (canonicalInfo.isDirectory()) directories.push(canonical);
    }
  }
  return { entriesScanned, skippedLinks, truncated };
}

interface TextPrefix {
  text: string;
  bytesRead: number;
  fileBytes: number;
  truncated: boolean;
  binary: boolean;
}

async function readTextPrefix(boundary: WorkspaceBoundary, path: string, maxBytes: number, signal: AbortSignal, allowBinary = false): Promise<TextPrefix> {
  throwIfAborted(signal);
  boundary.revalidateRoot();
  const expectedCanonical = await realpath(path);
  if (!samePath(expectedCanonical, path)) throw new WorkspaceBoundaryError("Read target changed after workspace validation");
  const handle = await open(path, "r");
  try {
    boundary.revalidateRoot();
    const handleInfo = await handle.stat();
    if (!handleInfo.isFile()) throw new WorkspaceBoundaryError("Only regular files can be read");
    if (handleInfo.nlink > 1) throw new WorkspaceBoundaryError("Files with multiple hard links are denied because path provenance cannot be proven");
    const postOpenCanonical = await realpath(path);
    if (!samePath(expectedCanonical, postOpenCanonical)) throw new WorkspaceBoundaryError("Read target changed during secure open");
    const pathInfo = await stat(postOpenCanonical);
    if (pathInfo.dev !== handleInfo.dev || pathInfo.ino !== handleInfo.ino) {
      throw new WorkspaceBoundaryError("Read file identity changed during secure open");
    }
    if (pathInfo.nlink > 1) throw new WorkspaceBoundaryError("Read target gained an additional hard link during secure open");
    const bytesToRead = Math.min(handleInfo.size, maxBytes + 1);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    throwIfAborted(signal);
    boundary.revalidateRoot();
    const available = buffer.subarray(0, bytesRead);
    const binary = available.includes(0);
    if (binary && !allowBinary) throw new WorkspaceBoundaryError("Binary files are not exposed by workspace read");
    const bounded = available.subarray(0, maxBytes);
    return {
      text: binary ? "" : bounded.toString("utf8"),
      bytesRead: bounded.byteLength,
      fileBytes: handleInfo.size,
      truncated: handleInfo.size > maxBytes,
      binary,
    };
  } finally {
    await handle.close();
  }
}

async function readWholeText(boundary: WorkspaceBoundary, path: string, maxBytes: number, signal: AbortSignal): Promise<string> {
  const prefix = await readTextPrefix(boundary, path, maxBytes, signal);
  if (prefix.truncated) throw new WorkspaceBoundaryError(`File exceeds the ${maxBytes}-byte edit limit`);
  return prefix.text;
}

async function commitTextFile(
  boundary: WorkspaceBoundary,
  requestedPath: string,
  expected: WritableWorkspacePath,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const verified = await boundary.resolveWritable(requestedPath);
  if (verified.absolute !== expected.absolute || verified.exists !== expected.exists) {
    throw new WorkspaceBoundaryError("Write target changed before the atomic commit");
  }
  const parent = dirname(verified.absolute);
  const mode = verified.exists ? (await stat(verified.absolute)).mode & 0o777 : 0o600;
  const temporary = join(parent, `.superai-write-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    throwIfAborted(signal);
    const finalCheck = await boundary.resolveWritable(requestedPath);
    if (finalCheck.absolute !== expected.absolute || finalCheck.exists !== expected.exists) {
      throw new WorkspaceBoundaryError("Write target changed during the atomic commit");
    }
    if (expected.exists) {
      // Renaming a same-directory, fully-written file replaces the directory
      // entry rather than following a last-moment symlink at the destination.
      await rename(temporary, expected.absolute);
    } else {
      // A hard-link commit is an atomic create-if-absent. It cannot overwrite a
      // file raced into place after the final validation.
      await link(temporary, expected.absolute);
      await unlink(temporary);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

interface DirectCommandOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

interface DirectCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runDirectCommand(options: DirectCommandOptions): Promise<DirectCommandResult> {
  throwIfAborted(options.signal);
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let terminationError: Error | undefined;
    let terminationFallback: ReturnType<typeof setTimeout> | undefined;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settleError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminationFallback) clearTimeout(terminationFallback);
      options.signal.removeEventListener("abort", abort);
      rejectPromise(error);
    };
    const beginTermination = (error: Error): void => {
      if (settled || terminationError) return;
      terminationError = error;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      void terminateProcessTree(child);
      terminationFallback = setTimeout(() => settleError(error), 2_000);
    };
    const abort = (): void => {
      const error = new Error("Governed command execution aborted");
      error.name = "AbortError";
      beginTermination(error);
    };
    const timer = setTimeout(() => {
      beginTermination(new Error(`Governed command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const next = Buffer.concat([current, chunk]);
      if (stdout.byteLength + stderr.byteLength + chunk.byteLength > options.maxOutputBytes) {
        beginTermination(new Error(`Governed command output exceeded ${options.maxOutputBytes} bytes`));
        return current;
      }
      return next;
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => settleError(error));
    child.on("close", (code) => {
      if (settled) return;
      if (terminationError) {
        settleError(terminationError);
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (terminationFallback) clearTimeout(terminationFallback);
      options.signal.removeEventListener("abort", abort);
      const result = { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode: code ?? -1 };
      if (result.exitCode !== 0) {
        rejectPromise(new Error(`Governed command exited with ${result.exitCode}: ${redactSecrets((result.stderr || result.stdout).trim())}`));
      } else {
        resolvePromise(result);
      }
    });
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolveTermination) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(fallback);
        resolveTermination();
      };
      const fallback = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* Process may already have exited. */
        }
        finish();
      }, 1_500);
      try {
        const taskkill = resolveWindowsSystemExecutable("taskkill.exe");
        const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", () => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* Process may already have exited. */
          }
          finish();
        });
        killer.once("close", () => finish());
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* Process may already have exited. */
        }
        finish();
      }
    });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* Process may already have exited. */
  }
}

function commandResult(executable: string, args: string[], result: DirectCommandResult, maxOutputBytes: number): HostToolResult {
  const body = [result.stdout.trimEnd(), result.stderr.trimEnd() ? `[stderr]\n${result.stderr.trimEnd()}` : ""].filter(Boolean).join("\n");
  const bounded = boundUtf8(redactSecrets(body || "Command completed without output."), maxOutputBytes);
  return textResult(withTruncationNotice(bounded.text, bounded.truncated, maxOutputBytes), {
    executable: basename(executable),
    argvHash: sha256(JSON.stringify(args)),
    exitCode: result.exitCode,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    truncated: bounded.truncated,
  });
}

interface ReducedCommandEnvironment {
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

function reducedEnvironment(root: string, additional: readonly string[] | undefined): ReducedCommandEnvironment {
  const home = mkdtempSync(join(tmpdir(), "superai-command-home-"));
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  const result: NodeJS.ProcessEnv = {};
  try {
    for (const requested of new Set([...DEFAULT_COMMAND_ENV, ...(additional ?? [])])) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(requested)) throw new WorkspaceBoundaryError(`Invalid environment variable name: ${requested}`);
      if (/(?:api.?key|credential|password|secret|token)/iu.test(requested)) {
        throw new WorkspaceBoundaryError(`Secret-like environment variable cannot be inherited by governed commands: ${requested}`);
      }
      if (/^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/iu.test(requested)) {
        throw new WorkspaceBoundaryError(`Governed command home directories cannot be inherited: ${requested}`);
      }
      const actualKey =
        process.platform === "win32" ? Object.keys(process.env).find((key) => key.toLocaleLowerCase() === requested.toLocaleLowerCase()) : requested;
      if (actualKey && process.env[actualKey] !== undefined) result[requested] = process.env[actualKey];
    }
    result.HOME = home;
    result.USERPROFILE = home;
    result.APPDATA = appData;
    result.LOCALAPPDATA = localAppData;
    result.PWD = root;
    result.CI = "1";
    result.NO_COLOR = "1";
    result.SUPERAI_WORKSPACE_ROOT = root;
    return {
      env: result,
      cleanup: () => rmSync(home, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

function resolveAllowedExecutable(executable: string, allowlist: ReadonlySet<string>, boundary: WorkspaceBoundary): string {
  boundary.revalidateRoot();
  if (executable.includes("\0")) throw new WorkspaceBoundaryError("Executable contains a NUL byte");
  const executableName = basename(executable).toLocaleLowerCase();
  if (ALWAYS_DENIED_EXECUTABLES.has(executableName)) throw new WorkspaceBoundaryError(`Shell executable is denied: ${executableName}`);
  if (hasPathSeparator(executable) || isAbsolute(executable)) {
    const pinned = pinExecutableForSpawn(executable, boundary.root);
    if (!allowlist.has(normalizeAbsoluteExecutable(pinned))) throw new WorkspaceBoundaryError(`Executable is not allowlisted: ${executable}`);
    boundary.revalidateRoot();
    return pinned;
  }
  if (!allowlist.has(normalizeBareExecutable(executable))) throw new WorkspaceBoundaryError(`Executable is not allowlisted: ${executable}`);
  const pinned = pinExecutableForSpawn(executable, boundary.root);
  if (statSync(pinned).nlink > 1) throw new WorkspaceBoundaryError("Executables with multiple hard links are denied");
  const pinnedName = basename(pinned).toLocaleLowerCase();
  if (ALWAYS_DENIED_EXECUTABLES.has(pinnedName)) throw new WorkspaceBoundaryError(`Resolved executable is a denied shell: ${pinnedName}`);
  if (isInside(boundary.root, pinned)) {
    throw new WorkspaceBoundaryError("A bare executable cannot resolve inside the workspace; allowlist an exact absolute path if this is intentional");
  }
  boundary.revalidateRoot();
  return pinned;
}

/** Resolve once to an absolute executable and never delegate lookup to spawn. */
export function pinExecutableForSpawn(executable: string, workspaceRoot: string): string {
  const value = executable.trim();
  if (!value || value.includes("\0")) throw new WorkspaceBoundaryError("Executable is required and cannot contain NUL");
  const boundary = new WorkspaceBoundary(workspaceRoot);
  const name = basename(value).toLocaleLowerCase();
  if (ALWAYS_DENIED_EXECUTABLES.has(name)) throw new WorkspaceBoundaryError(`Shell executable is denied: ${name}`);
  const canonical = resolveTrustedExecutable(value, { rejectRoots: [boundary.root] });
  const info = statSync(canonical);
  if (info.nlink > 1) throw new WorkspaceBoundaryError("Executables with multiple hard links are denied");
  if (isInside(boundary.root, canonical)) assertNonSensitive(boundary.relative(canonical));
  return canonical;
}

function normalizeExecutableAllowlist(values: readonly string[], workspaceRoot: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const name = basename(trimmed).toLocaleLowerCase();
    if (ALWAYS_DENIED_EXECUTABLES.has(name)) throw new WorkspaceBoundaryError(`A shell cannot be command-allowlisted: ${trimmed}`);
    result.add(
      hasPathSeparator(trimmed) || isAbsolute(trimmed)
        ? normalizeAbsoluteExecutable(pinExecutableForSpawn(trimmed, workspaceRoot))
        : normalizeBareExecutable(trimmed),
    );
  }
  return result;
}

function normalizeBareExecutable(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase() : value;
}

function normalizeAbsoluteExecutable(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase() : value;
}

async function requireApproval(approve: WorkspaceToolOptions["approve"], description: string, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!approve) throw new WorkspaceApprovalError("Mutation denied because no approval callback is configured");
  const approved = await approve(description);
  throwIfAborted(signal);
  if (!approved) throw new WorkspaceApprovalError("Mutation was not approved");
}

async function runEffect(
  effect: WorkspaceEffectRunner | undefined,
  capability: WorkspaceMutationCapability,
  arguments_: Record<string, unknown>,
  context: HostToolContext,
  run: () => Promise<HostToolResult>,
): Promise<HostToolResult> {
  if (!effect) throw new WorkspaceBoundaryError("Mutation denied because no durable effect ledger is configured");
  return effect(capability, arguments_, context, run);
}

async function auditedExecution(
  capability: WorkspaceToolCapability,
  target: string,
  audit: WorkspaceToolOptions["audit"],
  execute: () => Promise<HostToolResult>,
): Promise<HostToolResult> {
  emitAudit(audit, { at: new Date().toISOString(), capability, outcome: "requested", target });
  try {
    const result = await execute();
    const details = safeResultAuditDetails(result.details);
    emitAudit(audit, {
      at: new Date().toISOString(),
      capability,
      outcome: "completed",
      target,
      ...(details ? { details } : {}),
    });
    return result;
  } catch (error) {
    const denied = error instanceof WorkspaceBoundaryError || error instanceof WorkspaceApprovalError;
    emitAudit(audit, {
      at: new Date().toISOString(),
      capability,
      outcome: denied ? "denied" : "failed",
      target,
      details: { error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000) },
    });
    throw error;
  }
}

function safeResultAuditDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (/content|stdout|stderr|text/i.test(key)) continue;
    if (["string", "number", "boolean"].includes(typeof value) || value === null) safe[key] = value;
  }
  return safe;
}

function emitAudit(audit: WorkspaceToolOptions["audit"], event: WorkspaceToolAuditEvent): void {
  if (!audit) return;
  try {
    audit(event);
  } catch {
    /* Audit observers cannot change the tool result. */
  }
}

function auditTarget(capability: WorkspaceToolCapability, arguments_: Record<string, unknown>): string {
  if (capability === "bash") return clipAudit(String(arguments_.executable ?? "<missing>"));
  if (capability === "python") return `python-code:${sha256(String(arguments_.code ?? ""))}`;
  if (capability === "grep") return clipAudit(String(arguments_.path ?? "."));
  if (capability === "glob") return `glob:${clipAudit(String(arguments_.pattern ?? "<missing>"))}`;
  return clipAudit(String(arguments_.path ?? "<missing>"));
}

function clipAudit(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512);
}

function safePathSegments(relativePath: string): string[] {
  return toPosix(relativePath)
    .split("/")
    .filter((segment) => segment && segment !== ".");
}

function sensitiveReason(relativePath: string): string | undefined {
  const segments = safePathSegments(relativePath);
  const lower = segments.map((segment) => segment.toLocaleLowerCase());
  for (const segment of lower) {
    if (segment === ".git") return "Git control directory";
    if (segment === ".superai") return "private Axiomux state";
    if (segment === "node_modules") return "third-party dependency tree";
    if (SECRET_DIRECTORIES.has(segment)) return `secret directory ${segment}`;
    if (/^\.env(?:$|[._-]|rc$)/iu.test(segment)) return "environment file";
    if (SECRET_CONFIG_NAMES.has(segment)) return `credential config ${segment}`;
  }
  const file = lower.at(-1) ?? "";
  if (/^(?:id_(?:dsa|ecdsa|ed25519|rsa))(?:\..*)?$/iu.test(file)) return `private key file ${file}`;
  if (/\.(?:jks|key|keystore|ovpn|p12|pem|pfx)$/iu.test(file)) return `private credential extension ${file}`;
  if (/^(?:client[_-]?secret|service[_-]?account).*\.json$/iu.test(file)) return `cloud credential file ${file}`;
  const docker = lower.indexOf(".docker");
  if (docker >= 0 && lower[docker + 1] === "config.json") return "Docker credential config";
  if (SECRET_FILE_PATTERN.test(file)) return `credential-like file ${file}`;
  const superai = lower.indexOf(".superai");
  if (superai >= 0 && lower[superai + 1] === "secrets") return "Axiomux secret store";
  const ompRuntime = lower.indexOf("omp-runtime");
  if (ompRuntime >= 0 && lower.slice(ompRuntime + 1).join("/") === "agent/agent.db") return "OMP credential database";
  return undefined;
}

function assertNonSensitive(relativePath: string): void {
  const reason = sensitiveReason(relativePath);
  if (reason) throw new WorkspaceBoundaryError(`Sensitive path denied (${reason})`);
}

function assertGlobIsNonSensitive(pattern: string): void {
  if (/(?:^|\/)(?:\.git|\.ssh|\.superai|node_modules)(?:\/|$)|(?:^|\/)\.env(?:$|[._*?/-])|omp-runtime\/agent\/agent\.db/i.test(pattern)) {
    throw new WorkspaceBoundaryError("Glob pattern targets a sensitive path");
  }
}

function validatePathInput(input: string): string {
  const value = input.trim();
  if (!value) throw new WorkspaceBoundaryError("Path is required");
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new WorkspaceBoundaryError("Path contains control characters");
  if (value.length > 4_096) throw new WorkspaceBoundaryError("Path is too long");
  if (process.platform === "win32") {
    const slashNormalized = value.replace(/\//gu, "\\");
    if (/^(?:\\\\[?.]\\|\\\?\?\\)/u.test(slashNormalized)) throw new WorkspaceBoundaryError("Windows device namespaces are denied");
    const drivePrefix = /^[A-Za-z]:[\\/]/u.test(value);
    const colonOffset = drivePrefix ? 2 : 0;
    if (value.slice(colonOffset).includes(":")) throw new WorkspaceBoundaryError("NTFS alternate data streams and device paths are denied");
    for (const segment of value.split(/[\\/]/u)) {
      if (!segment || segment === "." || segment === ".." || /^[A-Za-z]:$/u.test(segment)) continue;
      if (/[ .]$/u.test(segment)) throw new WorkspaceBoundaryError("Ambiguous Windows path segments ending in dot or space are denied");
      if (/^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\.|$)/iu.test(segment)) throw new WorkspaceBoundaryError("Windows device names are denied");
    }
  }
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right;
}

function isExcludedPath(relativePath: string, excludedDirectories: ReadonlySet<string>): boolean {
  return safePathSegments(relativePath).some((segment) => excludedDirectories.has(segment.toLocaleLowerCase()));
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function normalizeGlob(input: string): string {
  const pattern = toPosix(input.trim())
    .replace(/^\.\//u, "")
    .replace(/\*{2,}/gu, "**");
  if (!pattern || pattern.includes("\0")) throw new WorkspaceBoundaryError("Glob pattern is required");
  if (isAbsolute(input) || pattern.split("/").includes("..")) throw new WorkspaceBoundaryError("Glob pattern must stay inside the workspace");
  if (/[{}[\]\\]/u.test(pattern)) throw new WorkspaceBoundaryError("Glob supports only literals, *, ** and ?");
  return pattern;
}

type GlobToken = { type: "literal"; value: string } | { type: "one" | "star" | "globstar" | "globstarSlash" };

function compileGlob(pattern: string): GlobToken[] {
  const source = process.platform === "win32" ? pattern.toLocaleLowerCase() : pattern;
  const tokens: GlobToken[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "*" && source[index + 1] === "*") {
      index += 1;
      if (source[index + 1] === "/") {
        index += 1;
        tokens.push({ type: "globstarSlash" });
      } else {
        tokens.push({ type: "globstar" });
      }
    } else if (character === "*") {
      tokens.push({ type: "star" });
    } else if (character === "?") {
      tokens.push({ type: "one" });
    } else {
      tokens.push({ type: "literal", value: character });
    }
  }
  if (tokens.length > MAX_GLOB_TOKENS) throw new WorkspaceBoundaryError(`Glob pattern exceeds ${MAX_GLOB_TOKENS} matching tokens`);
  return tokens;
}

function globMatches(tokens: readonly GlobToken[], path: string): boolean {
  const candidate = process.platform === "win32" ? path.toLocaleLowerCase() : path;
  let state = new Uint8Array(candidate.length + 1);
  state[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(candidate.length + 1);
    if (token.type === "literal" || token.type === "one") {
      for (let index = 0; index < candidate.length; index += 1) {
        if (!state[index]) continue;
        const character = candidate[index] ?? "";
        if (token.type === "literal" ? character === token.value : character !== "/") next[index + 1] = 1;
      }
    } else if (token.type === "star" || token.type === "globstar") {
      for (let index = 0; index <= candidate.length; index += 1) {
        if (state[index]) next[index] = 1;
        if (index < candidate.length && next[index] && (token.type === "globstar" || candidate[index] !== "/")) next[index + 1] = 1;
      }
    } else {
      let active = false;
      for (let index = 0; index <= candidate.length; index += 1) {
        active ||= state[index] === 1;
        if (state[index]) next[index] = 1;
        if (active && index < candidate.length && candidate[index] === "/") next[index + 1] = 1;
      }
    }
    state = next;
  }
  return state[candidate.length] === 1;
}

function toPosix(value: string): string {
  return value.replace(/\\/gu, "/");
}

function normalizeLimits(overrides: Partial<WorkspaceToolLimits> | undefined): WorkspaceToolLimits {
  const result = { ...DEFAULT_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new WorkspaceBoundaryError(`Invalid workspace tool limit ${name}`);
  }
  if (result.commandTimeoutMs > result.maxCommandTimeoutMs) throw new WorkspaceBoundaryError("Default command timeout exceeds its maximum");
  return result;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function requireString(value: Record<string, unknown>, key: string, maxLength = 4_096, trim = true): string {
  const raw = value[key];
  if (typeof raw !== "string") throw new WorkspaceBoundaryError(`${key} is required`);
  const result = trim ? raw.trim() : raw;
  if (!result) throw new WorkspaceBoundaryError(`${key} is required`);
  if (result.length > maxLength) throw new WorkspaceBoundaryError(`${key} exceeds ${maxLength} characters`);
  return result;
}

function requireText(value: Record<string, unknown>, key: string, maxBytes: number): string {
  const result = value[key];
  if (typeof result !== "string") throw new WorkspaceBoundaryError(`${key} must be a string`);
  if (Buffer.byteLength(result) > maxBytes) throw new WorkspaceBoundaryError(`${key} exceeds ${maxBytes} UTF-8 bytes`);
  return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string") throw new WorkspaceBoundaryError(`${key} must be a string`);
  return result;
}

function optionalInteger(value: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
  const result = value[key];
  if (result === undefined) return fallback;
  if (!Number.isSafeInteger(result) || typeof result !== "number" || result < minimum || result > maximum) {
    throw new WorkspaceBoundaryError(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function optionalStringArray(value: Record<string, unknown>, key: string, maxItems: number, maxItemLength: number): string[] {
  const result = value[key];
  if (result === undefined) return [];
  if (
    !Array.isArray(result) ||
    result.length > maxItems ||
    result.some((item) => typeof item !== "string" || item.length > maxItemLength || item.includes("\0"))
  ) {
    throw new WorkspaceBoundaryError(`${key} must contain at most ${maxItems} bounded strings`);
  }
  return [...result] as string[];
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedSet.has(key));
  if (extra) throw new WorkspaceBoundaryError(`Unexpected tool argument: ${extra}`);
}

function textResult(text: string, details: Record<string, unknown>): HostToolResult {
  return { content: [{ type: "text", text }], details };
}

function boundUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  return { text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function withTruncationNotice(value: string, truncated: boolean, maxBytes: number): string {
  if (!truncated) return boundUtf8(value, maxBytes).text;
  const notice = "\n[output truncated by Axiomux safety limits]";
  if (Buffer.byteLength(notice) >= maxBytes) return boundUtf8(notice.trimStart(), maxBytes).text;
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(notice));
  return `${boundUtf8(value, contentBudget).text}${notice}`;
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = value.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}

function commandApprovalDescription(executable: string, args: string[]): string {
  const warning =
    "WARNING: THIS PROCESS IS NOT AN OS SANDBOX. IT MAY READ, WRITE OR USE THE NETWORK OUTSIDE THE WORKSPACE; APPROVAL ALSO TRUSTS SCRIPTS, CONFIGURATION AND DEPENDENCIES LOADED BY THE EXECUTABLE.";
  const description = `${warning}\nRun this resolved executable directly, without a shell, from the workspace?\nexecutable=${executable}\ncomplete argv data=${JSON.stringify(args)}`;
  if (Buffer.byteLength(description) > MAX_APPROVAL_PAYLOAD_BYTES) {
    throw new WorkspaceBoundaryError("Command argv is too large to display completely for approval");
  }
  return description;
}

function visibleApproval(title: string, payload: Record<string, unknown>): string {
  const description = `${title}\ncomplete payload=${JSON.stringify(payload)}`;
  if (Buffer.byteLength(description) > MAX_APPROVAL_PAYLOAD_BYTES) {
    throw new WorkspaceBoundaryError("Mutation payload is too large to display completely for approval; split it into smaller operations");
  }
  return description;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Workspace tool execution aborted");
  error.name = "AbortError";
  throw error;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
