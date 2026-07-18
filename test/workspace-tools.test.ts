import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { WORKSPACE_HOST_TOOL_NAMES, workspaceHostToolName, type WorkspaceHostToolCapability } from "../src/tools/names.js";
import type { HostTool, HostToolContext } from "../src/types.js";
import { createWorkspaceTools, partitionOmpTools, type WorkspaceEffectRunner, type WorkspaceToolAuditEvent } from "../src/tools/workspace-tools.js";

const context = (): HostToolContext => ({
  toolCallId: "workspace-tool-test",
  signal: new AbortController().signal,
});

const passthroughEffect: WorkspaceEffectRunner = async (_capability, _arguments, _context, run) => run();

function tool(tools: HostTool[], capability: WorkspaceHostToolCapability): HostTool {
  const name = workspaceHostToolName(capability);
  const result = tools.find((candidate) => candidate.name === name);
  assert.ok(result, `missing ${name} tool for ${capability}`);
  return result;
}

function fixture(): { root: string; outside: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "superai-workspace-tools-"));
  const root = join(parent, "workspace");
  const outside = join(parent, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

test("tool partition replaces native filesystem and command tools and blocks ungoverned native surfaces", () => {
  assert.deepEqual(
    partitionOmpTools(["read", "grep", "glob", "edit", "write", "bash", "python", "todo", "web_search", "lsp", "inspect_image", "browser", "read"]),
    {
      host: ["read", "grep", "glob", "edit", "write", "bash", "python"],
      native: ["todo", "web_search"],
      blocked: ["lsp", "inspect_image", "browser"],
    },
  );

  const testFixture = fixture();
  try {
    const tools = createWorkspaceTools({ root: testFixture.root, capabilities: ["read", "write", "web_search", "lsp"] });
    assert.deepEqual(
      tools.map((item) => item.name),
      [WORKSPACE_HOST_TOOL_NAMES.read, WORKSPACE_HOST_TOOL_NAMES.write],
    );
    const ompBuiltins = new Set(["read", "grep", "glob", "edit", "write", "bash", "python"]);
    for (const name of Object.values(WORKSPACE_HOST_TOOL_NAMES)) assert.equal(ompBuiltins.has(name), false, `${name} must not collide with an OMP built-in`);
  } finally {
    testFixture.cleanup();
  }
});

test("read rejects traversal, external absolute paths and symlink or junction escapes", async () => {
  const testFixture = fixture();
  try {
    writeFileSync(join(testFixture.root, "inside.txt"), "inside", "utf8");
    writeFileSync(join(testFixture.outside, "outside.txt"), "outside", "utf8");
    const link = join(testFixture.root, "escape-link");
    symlinkSync(testFixture.outside, link, process.platform === "win32" ? "junction" : "dir");
    const read = tool(createWorkspaceTools({ root: testFixture.root, capabilities: ["read"] }), "read");

    await assert.rejects(read.execute({ path: "../outside/outside.txt" }, context()), /escapes the workspace root/i);
    await assert.rejects(read.execute({ path: join(testFixture.outside, "outside.txt") }, context()), /escapes the workspace root/i);
    await assert.rejects(read.execute({ path: "escape-link/outside.txt" }, context()), /escapes the workspace root/i);
    assert.match((await read.execute({ path: "inside.txt" }, context())).content[0]?.text ?? "", /inside/);
  } finally {
    testFixture.cleanup();
  }
});

test("tools keep the workspace root identity fixed after construction", async () => {
  const testFixture = fixture();
  try {
    writeFileSync(join(testFixture.root, "inside.txt"), "original", "utf8");
    writeFileSync(join(testFixture.outside, "inside.txt"), "replacement must stay hidden", "utf8");
    const read = tool(createWorkspaceTools({ root: testFixture.root, capabilities: ["read"] }), "read");
    rmSync(testFixture.root, { recursive: true, force: true });
    symlinkSync(testFixture.outside, testFixture.root, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(read.execute({ path: "inside.txt" }, context()), /symbolic link|junction|identity changed|different physical path/i);
  } finally {
    testFixture.cleanup();
  }
});

test("all sensitive path classes are denied", async () => {
  const testFixture = fixture();
  try {
    const sensitive = [
      ".env",
      ".env.local",
      ".envrc",
      ".ssh/id_ed25519",
      ".superai/secrets/provider-key.txt",
      ".superai/omp-runtime/agent/agent.db",
      ".superai/user.md",
      ".git/config",
      "node_modules/example/index.js",
      ".docker/config.json",
      "id_rsa",
      "private-signing.key",
      "client_secret_prod.json",
      "service-account-dev.json",
      "credentials.json",
      "auth.yaml",
      "tokens.db",
    ];
    for (const relativePath of sensitive) {
      mkdirSync(join(testFixture.root, ...relativePath.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(testFixture.root, ...relativePath.split("/")), "do-not-read", "utf8");
    }
    const read = tool(createWorkspaceTools({ root: testFixture.root, capabilities: ["read"] }), "read");
    for (const relativePath of sensitive) {
      await assert.rejects(read.execute({ path: relativePath }, context()), /sensitive path denied/i, relativePath);
    }
  } finally {
    testFixture.cleanup();
  }
});

test("hard-linked files fail closed because external provenance cannot be proven", async () => {
  const testFixture = fixture();
  try {
    const outsideFile = join(testFixture.outside, "shared.txt");
    writeFileSync(outsideFile, "external hardlink content", "utf8");
    linkSync(outsideFile, join(testFixture.root, "linked.txt"));
    const tools = createWorkspaceTools({
      root: testFixture.root,
      capabilities: ["read", "write", "edit"],
      approve: async () => true,
      effect: passthroughEffect,
    });
    await assert.rejects(tool(tools, "read").execute({ path: "linked.txt" }, context()), /multiple hard links/i);
    await assert.rejects(tool(tools, "write").execute({ path: "linked.txt", content: "overwrite", overwrite: true }, context()), /multiple hard links/i);
    await assert.rejects(tool(tools, "edit").execute({ path: "linked.txt", old_text: "external", new_text: "changed" }, context()), /multiple hard links/i);
    assert.equal(readFileSync(outsideFile, "utf8"), "external hardlink content");
  } finally {
    testFixture.cleanup();
  }
});

test("read is bounded, explicit about truncation and audit-observable without approval", async () => {
  const testFixture = fixture();
  try {
    writeFileSync(join(testFixture.root, "large.txt"), `${"abcdefghij\n".repeat(20)}tail`, "utf8");
    const events: WorkspaceToolAuditEvent[] = [];
    let approvals = 0;
    const read = tool(
      createWorkspaceTools({
        root: testFixture.root,
        capabilities: ["read"],
        approve: async () => {
          approvals += 1;
          return false;
        },
        audit: (event) => events.push(event),
        limits: { maxReadBytes: 35, maxReadLines: 3, maxOutputBytes: 80 },
      }),
      "read",
    );
    const result = await read.execute({ path: "large.txt", max_lines: 2 }, context());
    const output = result.content[0]?.text ?? "";
    assert.ok(Buffer.byteLength(output) <= 80);
    assert.match(output, /truncated by Axiomux safety limits/i);
    assert.equal(result.details?.truncated, true);
    assert.equal(approvals, 0);
    assert.deepEqual(
      events.map((event) => event.outcome),
      ["requested", "completed"],
    );
    assert.ok(!JSON.stringify(events).includes("abcdefghij"), "audit records must not contain file contents");
  } finally {
    testFixture.cleanup();
  }
});

test("grep and glob enforce result, traversal and output bounds while skipping links and secrets", async () => {
  const testFixture = fixture();
  try {
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(testFixture.root, `file-${index}.txt`), `needle ${index}\n`, "utf8");
    }
    writeFileSync(join(testFixture.root, ".env"), "needle=secret", "utf8");
    mkdirSync(join(testFixture.root, "dist"));
    writeFileSync(join(testFixture.root, "dist", "bundle.txt"), "needle generated", "utf8");
    symlinkSync(testFixture.outside, join(testFixture.root, "linked-outside"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(testFixture.outside, "outside.txt"), "needle outside", "utf8");
    const tools = createWorkspaceTools({
      root: testFixture.root,
      capabilities: ["grep", "glob"],
      limits: { maxGrepResults: 2, maxGlobResults: 2, maxOutputBytes: 160, maxScanFiles: 20, maxTraversalEntries: 30 },
    });

    const grep = await tool(tools, "grep").execute({ pattern: "needle", max_results: 2 }, context());
    assert.equal(grep.details?.matches, 2);
    assert.equal(grep.details?.truncated, true);
    assert.ok(Buffer.byteLength(grep.content[0]?.text ?? "") <= 160);
    assert.doesNotMatch(grep.content[0]?.text ?? "", /outside|secret/);
    await assert.rejects(tool(tools, "grep").execute({ pattern: "needle", path: "dist" }, context()), /excluded directory/i);

    const glob = await tool(tools, "glob").execute({ pattern: "**/*.txt", max_results: 2 }, context());
    assert.equal(glob.details?.matches, 2);
    assert.equal(glob.details?.truncated, true);
    assert.ok(Buffer.byteLength(glob.content[0]?.text ?? "") <= 160);
    assert.doesNotMatch(glob.content[0]?.text ?? "", /linked-outside|\.env/);

    const longName = `${"a".repeat(160)}.txt`;
    writeFileSync(join(testFixture.root, longName), "safe", "utf8");
    const startedAt = performance.now();
    const adversarial = await tool(tools, "glob").execute({ pattern: "********z" }, context());
    assert.match(adversarial.content[0]?.text ?? "", /No paths matched/);
    assert.ok(performance.now() - startedAt < 250, "glob matching must remain linear for repeated-star patterns");
  } finally {
    testFixture.cleanup();
  }
});

test("write and edit fail closed without approval and revalidate approved mutations", async () => {
  const testFixture = fixture();
  try {
    const deniedTools = createWorkspaceTools({
      root: testFixture.root,
      capabilities: ["write", "edit"],
      approve: async () => false,
    });
    await assert.rejects(tool(deniedTools, "write").execute({ path: "denied.txt", content: "no" }, context()), /not approved/i);
    assert.equal(existsSync(join(testFixture.root, "denied.txt")), false);

    const missingLedger = tool(
      createWorkspaceTools({
        root: testFixture.root,
        capabilities: ["write"],
        approve: async () => true,
      }),
      "write",
    );
    await assert.rejects(missingLedger.execute({ path: "no-ledger.txt", content: "no" }, context()), /no durable effect ledger/i);
    assert.equal(existsSync(join(testFixture.root, "no-ledger.txt")), false);

    const approvals: string[] = [];
    const allowedTools = createWorkspaceTools({
      root: testFixture.root,
      capabilities: ["write", "edit"],
      approve: async (description) => {
        approvals.push(description);
        return true;
      },
      effect: passthroughEffect,
    });
    await tool(allowedTools, "write").execute({ path: "approved.txt", content: "alpha beta" }, context());
    assert.equal(readFileSync(join(testFixture.root, "approved.txt"), "utf8"), "alpha beta");
    await tool(allowedTools, "edit").execute({ path: "approved.txt", old_text: "beta", new_text: "gamma" }, context());
    assert.equal(readFileSync(join(testFixture.root, "approved.txt"), "utf8"), "alpha gamma");
    assert.equal(
      readdirSync(testFixture.root).some((name) => name.startsWith(".superai-write-")),
      false,
      "atomic commit temporary files must be cleaned",
    );
    assert.equal(approvals.length, 2);
    assert.ok((approvals[0] ?? "").includes("alpha beta"), "write approval must contain the complete content");
    assert.ok((approvals[1] ?? "").includes("beta") && (approvals[1] ?? "").includes("gamma"), "edit approval must show complete old and new text");

    writeFileSync(join(testFixture.root, "growth.txt"), "a".repeat(2_000), "utf8");
    const growthTools = createWorkspaceTools({
      root: testFixture.root,
      capabilities: ["edit"],
      approve: async () => true,
      effect: passthroughEffect,
      limits: { maxEditBytes: 4_096 },
    });
    await assert.rejects(
      tool(growthTools, "edit").execute(
        {
          path: "growth.txt",
          old_text: "a",
          new_text: "b".repeat(2_000),
          replace_all: true,
        },
        context(),
      ),
      /would exceed 4096 bytes/i,
    );

    writeFileSync(join(testFixture.root, "approval-size.txt"), "x".repeat(3_000), "utf8");
    let oversizedApprovals = 0;
    const visibleEdit = tool(
      createWorkspaceTools({
        root: testFixture.root,
        capabilities: ["edit"],
        approve: async () => {
          oversizedApprovals += 1;
          return true;
        },
        effect: passthroughEffect,
        limits: { maxEditBytes: 10_000 },
      }),
      "edit",
    );
    await assert.rejects(
      visibleEdit.execute(
        {
          path: "approval-size.txt",
          old_text: "x".repeat(3_000),
          new_text: "y".repeat(3_000),
        },
        context(),
      ),
      /too large to display completely for approval/i,
    );
    assert.equal(oversizedApprovals, 0, "an approval must never hide an undisplayed payload tail");

    await assert.rejects(
      tool(allowedTools, "write").execute(
        {
          path: join(testFixture.outside, "bad.txt"),
          content: "bad",
        },
        context(),
      ),
      /escapes the workspace root/i,
    );
    assert.equal(existsSync(join(testFixture.outside, "bad.txt")), false);
  } finally {
    testFixture.cleanup();
  }
});

test("paths with control or ANSI characters are rejected before approval", async () => {
  const testFixture = fixture();
  try {
    let approvals = 0;
    const write = tool(
      createWorkspaceTools({
        root: testFixture.root,
        capabilities: ["write"],
        approve: async () => {
          approvals += 1;
          return true;
        },
        effect: passthroughEffect,
      }),
      "write",
    );
    await assert.rejects(write.execute({ path: "unsafe\u001b[31m.txt", content: "x" }, context()), /control characters/i);
    await assert.rejects(write.execute({ path: "line\nbreak.txt", content: "x" }, context()), /control characters/i);
    assert.equal(approvals, 0);
  } finally {
    testFixture.cleanup();
  }
});

test("governed command uses direct argv, workspace cwd and a reduced environment", async () => {
  const testFixture = fixture();
  const previousSecret = process.env.SUPERAI_TEST_SECRET;
  process.env.SUPERAI_TEST_SECRET = "must-not-leak";
  try {
    const approvals: string[] = [];
    const bash = tool(
      createWorkspaceTools({
        root: testFixture.root,
        capabilities: ["bash"],
        approve: async (description) => {
          approvals.push(description);
          return true;
        },
        effect: passthroughEffect,
        commandAllowlist: [process.execPath],
        limits: { commandTimeoutMs: 5_000, maxCommandTimeoutMs: 10_000, maxCommandOutputBytes: 8_192 },
      }),
      "bash",
    );
    const literal = "literal; echo shell-was-used && exit 9";
    const code =
      "process.stdout.write(JSON.stringify({arg:process.argv[1],cwd:process.cwd(),home:process.env.HOME,profile:process.env.USERPROFILE,appdata:process.env.APPDATA,secret:process.env.SUPERAI_TEST_SECRET??null}))";
    const result = await bash.execute({ executable: process.execPath, args: ["-e", code, literal] }, context());
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
      arg?: string;
      cwd?: string;
      home?: string;
      profile?: string;
      appdata?: string;
      secret?: string | null;
    };
    assert.equal(parsed.arg, literal, "shell metacharacters must remain one inert argv item");
    assert.equal(parsed.cwd, realpathSync.native(testFixture.root));
    assert.notEqual(parsed.home, testFixture.root, "governed commands must not use the workspace as HOME");
    assert.equal(parsed.profile, parsed.home);
    assert.ok(parsed.home, "governed commands must receive a disposable HOME");
    assert.ok(parsed.appdata?.startsWith(parsed.home), "APPDATA must stay under the disposable HOME");
    assert.equal(existsSync(parsed.home), false, "the disposable command HOME must be removed after execution");
    assert.equal(parsed.secret, null);
    assert.equal(approvals.length, 1);
    assert.match(approvals[0] ?? "", /WARNING: THIS PROCESS IS NOT AN OS SANDBOX/);
    assert.match(approvals[0] ?? "", /TRUSTS SCRIPTS, CONFIGURATION AND DEPENDENCIES/);
    assert.match(approvals[0] ?? "", /without a shell/i);
    assert.match(approvals[0] ?? "", new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.ok((approvals[0] ?? "").includes(process.execPath), "approval must show the pinned executable path");
    assert.equal(result.details?.argvHash !== undefined, true);
  } finally {
    if (previousSecret === undefined) delete process.env.SUPERAI_TEST_SECRET;
    else process.env.SUPERAI_TEST_SECRET = previousSecret;
    testFixture.cleanup();
  }
});

test("bare executables are pinned from absolute PATH entries and never resolved from cwd", async () => {
  const testFixture = fixture();
  const pathKey = process.platform === "win32" ? (Object.keys(process.env).find((key) => key.toLocaleLowerCase() === "path") ?? "PATH") : "PATH";
  const previousPath = process.env[pathKey];
  try {
    const executableName = basenameForPlatform(process.execPath);
    writeFileSync(join(testFixture.root, executableName), "malicious cwd shadow", "utf8");
    process.env[pathKey] = [dirname(process.execPath), ...(previousPath ? previousPath.split(delimiter) : [])].join(delimiter);
    const approvals: string[] = [];
    const bash = tool(
      createWorkspaceTools({
        root: testFixture.root,
        capabilities: ["bash"],
        approve: async (description) => {
          approvals.push(description);
          return true;
        },
        effect: passthroughEffect,
        commandAllowlist: [executableName],
      }),
      "bash",
    );
    const result = await bash.execute({ executable: executableName, args: ["-e", "process.stdout.write('trusted-pinned-binary')"] }, context());
    assert.equal(result.content[0]?.text, "trusted-pinned-binary");
    assert.ok((approvals[0] ?? "").includes(process.execPath));
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    testFixture.cleanup();
  }
});

test("write revalidation rejects an approval-time junction swap", async () => {
  const testFixture = fixture();
  try {
    const mutable = join(testFixture.root, "mutable");
    mkdirSync(mutable);
    const write = tool(
      createWorkspaceTools({
        root: testFixture.root,
        capabilities: ["write"],
        approve: async () => {
          rmSync(mutable, { recursive: true, force: true });
          symlinkSync(testFixture.outside, mutable, process.platform === "win32" ? "junction" : "dir");
          return true;
        },
        effect: passthroughEffect,
      }),
      "write",
    );
    await assert.rejects(write.execute({ path: "mutable/raced.txt", content: "must stay inside" }, context()), /symbolic-link|junction|escapes the workspace/i);
    assert.equal(existsSync(join(testFixture.outside, "raced.txt")), false);
  } finally {
    testFixture.cleanup();
  }
});

test("shell executables remain forbidden even if explicitly allowlisted", () => {
  const testFixture = fixture();
  try {
    assert.throws(
      () =>
        createWorkspaceTools({
          root: testFixture.root,
          capabilities: ["bash"],
          commandAllowlist: [process.platform === "win32" ? "cmd.exe" : "sh"],
        }),
      /shell cannot be command-allowlisted/i,
    );
  } finally {
    testFixture.cleanup();
  }
});

test("git is not in the default direct-command allowlist because repository config can execute hidden helpers", async () => {
  const testFixture = fixture();
  try {
    let approvals = 0;
    const bash = tool(
      createWorkspaceTools({
        root: testFixture.root,
        capabilities: ["bash"],
        approve: async () => {
          approvals += 1;
          return true;
        },
        effect: passthroughEffect,
      }),
      "bash",
    );
    await assert.rejects(bash.execute({ executable: process.platform === "win32" ? "git.exe" : "git", args: ["status"] }, context()), /not allowlisted/i);
    assert.equal(approvals, 0);
  } finally {
    testFixture.cleanup();
  }
});

test("the default direct-command tool exposes only Node; Python remains a separate governed tool", async () => {
  const testFixture = fixture();
  try {
    let approvals = 0;
    const bash = tool(
      createWorkspaceTools({
        root: testFixture.root,
        capabilities: ["bash"],
        approve: async () => {
          approvals += 1;
          return true;
        },
        effect: passthroughEffect,
      }),
      "bash",
    );
    for (const executable of ["python", "python3", "uv", "rg"]) {
      await assert.rejects(bash.execute({ executable, args: ["--version"] }, context()), /not allowlisted/i);
    }
    assert.equal(approvals, 0);
  } finally {
    testFixture.cleanup();
  }
});

test("running commands are abortable", async () => {
  const testFixture = fixture();
  try {
    const bash = tool(
      createWorkspaceTools({
        root: testFixture.root,
        capabilities: ["bash"],
        approve: async () => true,
        effect: passthroughEffect,
        commandAllowlist: [process.execPath],
        limits: { commandTimeoutMs: 5_000, maxCommandTimeoutMs: 10_000 },
      }),
      "bash",
    );
    const controller = new AbortController();
    const running = bash.execute(
      { executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
      {
        toolCallId: "abort-command",
        signal: controller.signal,
      },
    );
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(running, (error) => error instanceof Error && error.name === "AbortError");
  } finally {
    testFixture.cleanup();
  }
});

test("Windows abort terminates the complete child process tree", async (testContext) => {
  if (process.platform !== "win32") {
    testContext.skip("taskkill tree semantics are Windows-specific");
    return;
  }
  const testFixture = fixture();
  try {
    const marker = join(testFixture.root, "orphan-marker.txt");
    const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 500); setInterval(() => {}, 1000)`;
    const parentCode = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], {stdio:"ignore",windowsHide:true}); setInterval(() => {}, 1000)`;
    const bash = tool(
      createWorkspaceTools({
        root: testFixture.root,
        capabilities: ["bash"],
        approve: async () => true,
        effect: passthroughEffect,
        commandAllowlist: [process.execPath],
        limits: { commandTimeoutMs: 5_000, maxCommandTimeoutMs: 10_000 },
      }),
      "bash",
    );
    const controller = new AbortController();
    const running = bash.execute(
      { executable: process.execPath, args: ["-e", parentCode] },
      {
        toolCallId: "abort-command-tree",
        signal: controller.signal,
      },
    );
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(running, (error) => error instanceof Error && error.name === "AbortError");
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    assert.equal(existsSync(marker), false, "a child process must not survive an aborted governed command");
  } finally {
    testFixture.cleanup();
  }
});

test("Windows ADS and device namespace paths are denied", async (testContext) => {
  if (process.platform !== "win32") {
    testContext.skip("NTFS path rules are Windows-specific");
    return;
  }
  const testFixture = fixture();
  try {
    writeFileSync(join(testFixture.root, "safe.txt"), "safe", "utf8");
    const read = tool(createWorkspaceTools({ root: testFixture.root, capabilities: ["read"] }), "read");
    await assert.rejects(read.execute({ path: "safe.txt:hidden" }, context()), /alternate data streams/i);
    await assert.rejects(read.execute({ path: `\\\\?\\${join(testFixture.root, "safe.txt")}` }, context()), /device namespaces/i);
    await assert.rejects(read.execute({ path: "NUL" }, context()), /device names/i);
  } finally {
    testFixture.cleanup();
  }
});

function basenameForPlatform(path: string): string {
  return path.replace(/.*[\\/]/u, "");
}
