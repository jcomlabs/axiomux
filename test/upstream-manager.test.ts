import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  matchesUpstreamPattern,
  type UpstreamConfig,
  type UpstreamDefinition,
  type UpstreamFetch,
  UpstreamManager,
  validateUpstreamConfig,
} from "../src/upstreams/manager.js";

const BASE_SHA = "1111111111111111111111111111111111111111";
const HEAD_SHA = "2222222222222222222222222222222222222222";
const BASE_TREE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_TREE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "superai-upstream-radar-"));
}

function definition(overrides: Partial<UpstreamDefinition> = {}): UpstreamDefinition {
  return {
    id: "example",
    owner: "Example-Org",
    repo: "example-repo",
    strategy: "release",
    role: "Test upstream",
    license: { spdx: "MIT", codeReuseAllowed: true },
    baseline: { kind: "commit", ref: BASE_SHA, release: "v1.0.0", evidence: "test fixture" },
    monitorIncludes: ["packages/auth/**", "packages/rpc/**"],
    monitorExcludes: ["**/fixtures/**"],
    topics: ["oauth", "rpc"],
    ...overrides,
  };
}

function config(upstream: UpstreamDefinition = definition()): UpstreamConfig {
  return { schemaVersion: 1, upstreams: [upstream] };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function commit(sha: string, message: string, date = "2026-07-17T10:00:00.000Z"): Record<string, unknown> {
  return {
    sha,
    html_url: `https://github.com/Example-Org/example-repo/commit/${sha}`,
    commit: { message, author: { date } },
  };
}

function gitCommit(sha: string, treeSha: string): Record<string, unknown> {
  return { sha, tree: { sha: treeSha } };
}

function tree(entries: Array<{ path: string; sha: string; type?: string }>, truncated = false): Record<string, unknown> {
  return {
    truncated,
    tree: entries.map((entry) => ({ path: entry.path, type: entry.type ?? "blob", sha: entry.sha })),
  };
}

function successfulFetch(requests: Array<{ url: string; init?: RequestInit }>): UpstreamFetch {
  return async (input, init) => {
    const url = String(input);
    requests.push(init === undefined ? { url } : { url, init });
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    if (pathname.endsWith("/releases/latest")) {
      return jsonResponse({
        tag_name: "v1.1.0",
        html_url: "https://github.com/Example-Org/example-repo/releases/tag/v1.1.0",
        published_at: "2026-07-17T09:00:00Z",
      });
    }
    if (pathname.endsWith("/commits/v1.1.0")) return jsonResponse(commit(HEAD_SHA, "release"));
    if (pathname === "/repos/Example-Org/example-repo/commits" && parsedUrl.searchParams.has("sha")) {
      return jsonResponse([
        commit(HEAD_SHA, "Release"),
        commit("3333333333333333333333333333333333333333", "Improve OAuth broker\n\nDetails"),
        commit(BASE_SHA, "Baseline"),
      ]);
    }
    if (pathname.endsWith(`/git/commits/${BASE_SHA}`)) return jsonResponse(gitCommit(BASE_SHA, BASE_TREE_SHA));
    if (pathname.endsWith(`/git/commits/${HEAD_SHA}`)) return jsonResponse(gitCommit(HEAD_SHA, HEAD_TREE_SHA));
    if (pathname.endsWith(`/git/trees/${BASE_TREE_SHA}`)) {
      return jsonResponse(
        tree([
          { path: "packages/auth/oauth.ts", sha: "4444444444444444444444444444444444444444" },
          { path: "packages/auth/fixtures/token.json", sha: "5555555555555555555555555555555555555555" },
          { path: "docs/release.md", sha: "6666666666666666666666666666666666666666" },
        ]),
      );
    }
    if (pathname.endsWith(`/git/trees/${HEAD_TREE_SHA}`)) {
      return jsonResponse(
        tree([
          { path: "packages/auth/oauth.ts", sha: "7777777777777777777777777777777777777777" },
          { path: "packages/auth/fixtures/token.json", sha: "8888888888888888888888888888888888888888" },
          { path: "docs/release.md", sha: "9999999999999999999999999999999999999999" },
        ]),
      );
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
}

function unsupportedLink(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(String(error.code));
}

test("repository radar config pins the audited OMP v17.0.4 baseline and validates every entry", () => {
  const path = resolve("config", "upstreams.json");
  const parsed = validateUpstreamConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  assert.equal(parsed.upstreams.length, 12);
  assert.deepEqual(
    parsed.upstreams.filter((item) => item.baseline === null).map((item) => item.id),
    [],
  );
  const omp = parsed.upstreams.find((item) => item.id === "oh-my-pi");
  assert.equal(omp?.baseline?.ref, "3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0");
  assert.equal(omp?.baseline?.release, "v17.0.4");
  assert.equal(omp?.license.codeReuseAllowed, true);
  assert.ok(omp?.monitorIncludes.some((pattern) => pattern.includes("registry")));
  assert.ok(omp?.monitorIncludes.some((pattern) => pattern.includes("rpc")));
  assert.equal(parsed.upstreams.find((item) => item.id === "mem0")?.license.spdx, "Apache-2.0");
  assert.equal(parsed.upstreams.find((item) => item.id === "agency-agents")?.license.spdx, "MIT");
  for (const id of ["openclaw", "ob1", "oh-my-openagent", "dify", "claude-code"]) {
    assert.equal(parsed.upstreams.find((item) => item.id === id)?.license.codeReuseAllowed, false, id);
  }
});

test("radar checks only the fixed GitHub API, filters metadata and persists review state", async () => {
  const root = temporaryRoot();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  try {
    const manager = new UpstreamManager({
      projectRoot: root,
      config: config(),
      fetch: successfulFetch(requests),
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    const [record] = await manager.check("example");
    assert.equal(record?.checkStatus, "pending");
    assert.equal(record?.reviewStatus, "pending");
    assert.equal(record?.target?.sha, HEAD_SHA);
    assert.deepEqual(
      record?.relevantFiles.map((file) => file.filename),
      ["packages/auth/oauth.ts"],
    );
    assert.deepEqual(
      record?.relevantCommits.map((item) => item.message),
      ["Improve OAuth broker"],
    );
    assert.equal(requests.length, 7);
    assert.equal(
      requests.some((request) => new URL(request.url).pathname.includes("/compare/")),
      false,
      "the radar must not call GitHub's compare endpoint because it embeds patch snippets",
    );
    for (const request of requests) {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.github.com");
      assert.match(url.pathname, /^\/repos\/Example-Org\/example-repo\//u);
      assert.equal(request.init?.method, "GET");
      assert.equal(request.init?.redirect, "error");
      const headers = new Headers(request.init?.headers);
      assert.equal(headers.get("accept"), "application/vnd.github+json");
      assert.equal(headers.get("x-github-api-version"), "2022-11-28");
      assert.equal(headers.get("user-agent"), "Axiomux-Upstream-Radar/0.1");
      assert.equal(headers.has("authorization"), false);
      assert.deepEqual([...headers.keys()].sort(), ["accept", "user-agent", "x-github-api-version"]);
    }

    const stateText = readFileSync(manager.statePath, "utf8");
    assert.doesNotMatch(stateText, /patch must never|excluded fixture|irrelevant patch/u);
    assert.doesNotMatch(stateText, /"patch"/u);
    const marked = manager.mark("example", "reviewed", "Audited locally");
    assert.equal(marked.reviewStatus, "reviewed");
    assert.equal(marked.reviewNote, "Audited locally");

    const reloaded = new UpstreamManager({ projectRoot: root, config: config(), fetch: successfulFetch([]) });
    assert.equal(reloaded.show("example").lastCheck?.reviewStatus, "reviewed");
    assert.equal(reloaded.show("example").lastCheck?.reviewNote, "Audited locally");
    const mutable = reloaded.list();
    const first = mutable[0];
    assert.ok(first);
    first.definition.role = "caller mutation";
    assert.equal(reloaded.show("example").definition.role, "Test upstream");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("branch strategy discovers the default branch but refuses to invent an audited baseline", async () => {
  const root = temporaryRoot();
  const requested: string[] = [];
  const fetch: UpstreamFetch = async (input) => {
    const url = String(input);
    requested.push(url);
    const pathname = new URL(url).pathname;
    if (pathname === "/repos/Example-Org/example-repo") return jsonResponse({ default_branch: "main" });
    if (pathname.endsWith("/commits/main")) return jsonResponse(commit(HEAD_SHA, "Current branch"));
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  try {
    const manager = new UpstreamManager({
      projectRoot: root,
      config: config(definition({ strategy: "branch", baseline: null })),
      fetch,
    });
    const [record] = await manager.check();
    assert.equal(record?.checkStatus, "baseline_missing");
    assert.equal(record?.target?.ref, "main");
    assert.equal(record?.baselineRef, undefined);
    assert.equal(requested.length, 2);
    assert.equal(
      requested.some((url) => url.includes("/compare/")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a version-controlled baseline advance discards stale private comparison state", async () => {
  const root = temporaryRoot();
  try {
    const initial = new UpstreamManager({ projectRoot: root, config: config(), fetch: successfulFetch([]) });
    const [pending] = await initial.check("example");
    assert.equal(pending?.baselineRef, BASE_SHA);
    initial.mark("example", "reviewed", "Reviewed before advancing the committed baseline");

    const advanced = definition({ baseline: { kind: "commit", ref: HEAD_SHA, release: "v1.1.0", evidence: "review commit" } });
    const reloaded = new UpstreamManager({ projectRoot: root, config: config(advanced), fetch: successfulFetch([]) });
    assert.equal(reloaded.show("example").lastCheck, undefined);

    const [current] = await reloaded.check("example");
    assert.equal(current?.checkStatus, "up_to_date");
    assert.equal(current?.baselineRef, HEAD_SHA);
    assert.equal(current?.target?.sha, HEAD_SHA);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configuration validation rejects SSRF-shaped owner, repository and ref inputs before fetch", () => {
  const cases: UpstreamDefinition[] = [
    definition({ owner: "api.github.com/redirect" }),
    definition({ repo: "../private" }),
    definition({ strategy: "branch", ref: "https://attacker.invalid/x" }),
    definition({ strategy: "branch", ref: "main..evil" }),
  ];
  for (const [index, upstream] of cases.entries()) {
    const root = temporaryRoot();
    let fetchCalls = 0;
    try {
      assert.throws(
        () =>
          new UpstreamManager({
            projectRoot: root,
            config: config(upstream),
            fetch: async () => {
              fetchCalls += 1;
              return jsonResponse({});
            },
          }),
        /GitHub owner|repository name|safe GitHub ref/u,
        `case ${index}`,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("non-JSON responses and oversized responses fail closed without storing response bodies", async () => {
  const cases: Array<{ fetch: UpstreamFetch; expected: "error" | "too_large" }> = [
    {
      fetch: async () =>
        new Response("not json and potentially sensitive", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      expected: "error",
    },
    {
      fetch: async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) },
        }),
      expected: "too_large",
    },
  ];
  for (const item of cases) {
    const root = temporaryRoot();
    try {
      const manager = new UpstreamManager({ projectRoot: root, config: config(), fetch: item.fetch });
      const [record] = await manager.check();
      assert.equal(record?.checkStatus, item.expected);
      assert.deepEqual(record?.relevantFiles, []);
      const stateText = readFileSync(manager.statePath, "utf8");
      assert.doesNotMatch(stateText, /potentially sensitive|not json/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("streaming response cap is enforced even without Content-Length", async () => {
  const root = temporaryRoot();
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array([123]));
        controller.close();
      },
    });
    const manager = new UpstreamManager({
      projectRoot: root,
      config: config(),
      fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    });
    const [record] = await manager.check();
    assert.equal(record?.checkStatus, "too_large");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timeout remains active while a GitHub response body is streaming", async () => {
  const root = temporaryRoot();
  try {
    const fetch: UpstreamFetch = async (_input, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    };
    const startedAt = Date.now();
    const manager = new UpstreamManager({ projectRoot: root, config: config(), fetch, timeoutMs: 1_000 });
    const [record] = await manager.check();
    assert.equal(record?.checkStatus, "error");
    assert.match(record?.error ?? "", /timed out/u);
    assert.ok(Date.now() - startedAt < 2_500, "streaming body timeout did not abort promptly");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized history, truncated trees and 300-file reviews fail honestly without compare patches", async () => {
  for (const mode of ["history-limit", "tree-truncation", "file-limit"] as const) {
    const root = temporaryRoot();
    const requested: string[] = [];
    const fetch: UpstreamFetch = async (input) => {
      const url = String(input);
      requested.push(url);
      const parsedUrl = new URL(url);
      const pathname = parsedUrl.pathname;
      if (pathname.endsWith("/releases/latest")) {
        return jsonResponse({
          tag_name: "v1.1.0",
          html_url: "https://github.com/Example-Org/example-repo/releases/tag/v1.1.0",
        });
      }
      if (pathname.endsWith("/commits/v1.1.0")) return jsonResponse(commit(HEAD_SHA, "release"));
      if (pathname === "/repos/Example-Org/example-repo/commits" && parsedUrl.searchParams.has("sha")) {
        if (mode !== "history-limit") return jsonResponse([commit(HEAD_SHA, "OAuth"), commit(BASE_SHA, "baseline")]);
        const perPage = Number(parsedUrl.searchParams.get("per_page"));
        const page = Number(parsedUrl.searchParams.get("page"));
        return jsonResponse(
          Array.from({ length: perPage }, (_, index) => {
            if (page === 1 && index === 0) return commit(HEAD_SHA, "head");
            const number = 1_000 + (page - 1) * perPage + index;
            return commit(number.toString(16).padStart(40, "0"), `commit ${number}`);
          }),
        );
      }
      if (pathname.endsWith(`/git/commits/${BASE_SHA}`)) return jsonResponse(gitCommit(BASE_SHA, BASE_TREE_SHA));
      if (pathname.endsWith(`/git/commits/${HEAD_SHA}`)) return jsonResponse(gitCommit(HEAD_SHA, HEAD_TREE_SHA));
      if (pathname.endsWith(`/git/trees/${BASE_TREE_SHA}`)) return jsonResponse(tree([], mode === "tree-truncation"));
      if (pathname.endsWith(`/git/trees/${HEAD_TREE_SHA}`)) {
        const entries = Array.from({ length: mode === "file-limit" ? 300 : 1 }, (_, index) => ({
          path: `packages/auth/file-${index}.ts`,
          sha: (2_000 + index).toString(16).padStart(40, "0"),
        }));
        return jsonResponse(tree(entries));
      }
      throw new Error("Unexpected URL");
    };
    try {
      const manager = new UpstreamManager({ projectRoot: root, config: config(), fetch });
      const [record] = await manager.check();
      assert.equal(record?.checkStatus, "too_large", mode);
      assert.deepEqual(record?.relevantFiles, []);
      assert.deepEqual(record?.relevantCommits, []);
      assert.equal(
        requested.some((url) => new URL(url).pathname.includes("/compare/")),
        false,
        mode,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("commit pagination reaches an audited baseline at position 250 without overlapping pages", async () => {
  const root = temporaryRoot();
  const historyRequests: Array<[string | null, string | null]> = [];
  const fetch: UpstreamFetch = async (input) => {
    const url = new URL(String(input));
    const pathname = url.pathname;
    if (pathname.endsWith("/releases/latest")) {
      return jsonResponse({
        tag_name: "v1.1.0",
        html_url: "https://github.com/Example-Org/example-repo/releases/tag/v1.1.0",
      });
    }
    if (pathname.endsWith("/commits/v1.1.0")) return jsonResponse(commit(HEAD_SHA, "head"));
    if (pathname === "/repos/Example-Org/example-repo/commits" && url.searchParams.has("sha")) {
      const perPage = Number(url.searchParams.get("per_page"));
      const page = Number(url.searchParams.get("page"));
      historyRequests.push([url.searchParams.get("per_page"), url.searchParams.get("page")]);
      const offset = (page - 1) * perPage;
      return jsonResponse(
        Array.from({ length: perPage }, (_, index) => {
          const position = offset + index;
          if (position === 0) return commit(HEAD_SHA, "head");
          if (position === 249) return commit(BASE_SHA, "baseline");
          return commit((4_000 + position).toString(16).padStart(40, "0"), `ordinary commit ${position}`);
        }),
      );
    }
    if (pathname.endsWith(`/git/commits/${BASE_SHA}`)) return jsonResponse(gitCommit(BASE_SHA, BASE_TREE_SHA));
    if (pathname.endsWith(`/git/commits/${HEAD_SHA}`)) return jsonResponse(gitCommit(HEAD_SHA, HEAD_TREE_SHA));
    if (pathname.endsWith(`/git/trees/${BASE_TREE_SHA}`) || pathname.endsWith(`/git/trees/${HEAD_TREE_SHA}`)) {
      return jsonResponse(tree([]));
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  };
  try {
    const manager = new UpstreamManager({ projectRoot: root, config: config(), fetch });
    const [record] = await manager.check();
    assert.equal(record?.checkStatus, "no_relevant_changes");
    assert.equal(record?.compare?.aheadBy, 249);
    assert.deepEqual(historyRequests, [
      ["100", "1"],
      ["100", "2"],
      ["50", "5"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized aggregate state is rejected before replacing the last readable snapshot", async () => {
  const root = temporaryRoot();
  const largeConfig: UpstreamConfig = {
    schemaVersion: 1,
    upstreams: Array.from({ length: 8 }, (_, index) => definition({ id: `example-${index}` })),
  };
  const fetch: UpstreamFetch = async (input) => {
    const url = new URL(String(input));
    const pathname = url.pathname;
    if (pathname.endsWith("/releases/latest")) {
      return jsonResponse({
        tag_name: "v1.1.0",
        html_url: "https://github.com/Example-Org/example-repo/releases/tag/v1.1.0",
      });
    }
    if (pathname.endsWith("/commits/v1.1.0")) return jsonResponse(commit(HEAD_SHA, "OAuth head"));
    if (pathname === "/repos/Example-Org/example-repo/commits" && url.searchParams.has("sha")) {
      const perPage = Number(url.searchParams.get("per_page"));
      const page = Number(url.searchParams.get("page"));
      const offset = (page - 1) * perPage;
      return jsonResponse(
        Array.from({ length: perPage }, (_, index) => {
          const position = offset + index;
          if (position === 0) return commit(HEAD_SHA, `OAuth ${"message ".repeat(70)}`);
          if (position === 249) return commit(BASE_SHA, "baseline");
          return commit((8_000 + position).toString(16).padStart(40, "0"), `OAuth ${position} ${"message ".repeat(70)}`);
        }),
      );
    }
    if (pathname.endsWith(`/git/commits/${BASE_SHA}`)) return jsonResponse(gitCommit(BASE_SHA, BASE_TREE_SHA));
    if (pathname.endsWith(`/git/commits/${HEAD_SHA}`)) return jsonResponse(gitCommit(HEAD_SHA, HEAD_TREE_SHA));
    if (pathname.endsWith(`/git/trees/${BASE_TREE_SHA}`)) return jsonResponse(tree([]));
    if (pathname.endsWith(`/git/trees/${HEAD_TREE_SHA}`)) {
      return jsonResponse(
        tree(
          Array.from({ length: 299 }, (_, index) => ({
            path: `packages/auth/${index}-${"x".repeat(850)}.ts`,
            sha: (12_000 + index).toString(16).padStart(40, "0"),
          })),
        ),
      );
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  };
  try {
    const manager = new UpstreamManager({ projectRoot: root, config: largeConfig, fetch });
    let rejected = false;
    for (const upstream of largeConfig.upstreams) {
      const previous = existsSync(manager.statePath) ? readFileSync(manager.statePath, "utf8") : undefined;
      try {
        await manager.check(upstream.id);
      } catch (error) {
        assert.match(error instanceof Error ? error.message : String(error), /state exceeds.*persistence limit/u);
        assert.notEqual(previous, undefined);
        assert.equal(readFileSync(manager.statePath, "utf8"), previous);
        rejected = true;
        break;
      }
    }
    assert.equal(rejected, true, "large fixture did not reach the aggregate state limit");
    const reloaded = new UpstreamManager({ projectRoot: root, config: largeConfig, fetch });
    assert.ok(reloaded.list().some((item) => item.lastCheck !== undefined));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state persistence rejects a hard-linked destination and leaves its external target unchanged", async (context) => {
  const root = temporaryRoot();
  const target = join(root, "external-state.json");
  try {
    const manager = new UpstreamManager({
      projectRoot: root,
      config: config(definition({ strategy: "branch", ref: "main", baseline: null })),
      fetch: async () => jsonResponse(commit(HEAD_SHA, "branch")),
    });
    mkdirSync(join(root, ".superai"));
    writeFileSync(target, "external-value", "utf8");
    try {
      linkSync(target, manager.statePath);
    } catch (error) {
      if (!unsupportedLink(error)) throw error;
      context.skip("hard links are unavailable on this filesystem");
      return;
    }
    await assert.rejects(manager.check(), /hard.link/u);
    assert.equal(readFileSync(target, "utf8"), "external-value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state loading rejects file symlinks without reading through them", (context) => {
  const root = temporaryRoot();
  const target = join(root, "external-state.json");
  const stateDirectory = join(root, ".superai");
  const statePath = join(stateDirectory, "upstream-radar.json");
  try {
    mkdirSync(stateDirectory);
    writeFileSync(target, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), upstreams: {} }), "utf8");
    try {
      symlinkSync(target, statePath, "file");
    } catch (error) {
      if (!unsupportedLink(error)) throw error;
      context.skip("file symlinks are unavailable on this filesystem");
      return;
    }
    assert.throws(() => new UpstreamManager({ projectRoot: root, config: config(), fetch: async () => jsonResponse({}) }), /symbolic|regular file/u);
    assert.equal(readFileSync(target, "utf8").includes("schemaVersion"), true);
  } finally {
    try {
      unlinkSync(statePath);
    } catch {
      /* absent */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("glob matching supports recursive prefixes, single segments and exclusions", () => {
  assert.equal(matchesUpstreamPattern("packages/auth/oauth.ts", "packages/auth/**"), true);
  assert.equal(matchesUpstreamPattern("auth/oauth.ts", "**/auth/**"), true);
  assert.equal(matchesUpstreamPattern("packages/auth/oauth.ts", "**/auth/**"), true);
  assert.equal(matchesUpstreamPattern("packages/auth/deep/oauth.ts", "packages/*/*.ts"), false);
  assert.equal(matchesUpstreamPattern("packages/rpc/index.ts", "packages/?pc/**"), true);
});
