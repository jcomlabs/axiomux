import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { type LocalUiServer, type StartLocalUiOptions, sanitizePublicValue, startLocalUi, UiApprovalBroker, type UiCallbacks } from "../src/ui/index.js";

interface UiFixture {
  ui: LocalUiServer;
  cookie: string;
}

async function startFixture(context: TestContext, callbacks: UiCallbacks = {}, options: Omit<StartLocalUiOptions, "callbacks"> = {}): Promise<UiFixture> {
  const ui = await startLocalUi({ callbacks, ...options });
  context.after(async () => ui.close());
  const response = await fetch(ui.bootstrapUrl, { redirect: "manual" });
  assert.equal(response.status, 303);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  const [cookie] = setCookie.split(";", 1);
  assert.ok(cookie);
  return { ui, cookie };
}

async function jsonRequest(fixture: UiFixture, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", fixture.cookie);
  return fetch(`${fixture.ui.origin}${path}`, { ...init, headers, redirect: "manual" });
}

async function requestWithHost(origin: string, host: string): Promise<{ status: number; body: string }> {
  const target = new URL(origin);
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: "/",
        method: "GET",
        headers: { Host: host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolveRequest({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("local UI bootstrap is one-time and establishes a hardened HttpOnly session", async (context) => {
  const ui = await startLocalUi({ callbacks: {}, staticRoot: resolve(process.cwd(), "ui") });
  context.after(async () => ui.close());

  const unauthenticated = await fetch(ui.origin, { redirect: "manual" });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("access-control-allow-origin"), null);
  assert.match(unauthenticated.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
  assert.equal(unauthenticated.headers.get("x-content-type-options"), "nosniff");
  assert.equal(unauthenticated.headers.get("referrer-policy"), "no-referrer");

  const bootstrap = await fetch(ui.bootstrapUrl, { redirect: "manual" });
  assert.equal(bootstrap.status, 303);
  assert.equal(bootstrap.headers.get("location"), "/");
  const setCookie = bootstrap.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^superai_ui_session=[A-Za-z0-9_-]+;/u);
  assert.match(setCookie, /HttpOnly/iu);
  assert.match(setCookie, /SameSite=Strict/iu);
  assert.match(setCookie, /Path=\//iu);
  assert.doesNotMatch(setCookie, /token=/iu);

  const replay = await fetch(ui.bootstrapUrl, { redirect: "manual" });
  assert.equal(replay.status, 404);

  const [cookie] = setCookie.split(";", 1);
  assert.ok(cookie);
  const page = await fetch(ui.origin, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Axiomux/u);
  const emblem = await fetch(`${ui.origin}/axiomux-emblem.png`, { headers: { Cookie: cookie } });
  assert.equal(emblem.status, 200);
  assert.equal(emblem.headers.get("content-type"), "image/png");
  assert.ok((await emblem.arrayBuffer()).byteLength > 10_000);

  const locales = await fetch(`${ui.origin}/locales.js`, { headers: { Cookie: cookie } });
  assert.equal(locales.status, 200);
  assert.equal(locales.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await locales.text(), /DEFAULT_LOCALE = "en"/u);
  const unknownAsset = await fetch(`${ui.origin}/translations.json`, { headers: { Cookie: cookie } });
  assert.equal(unknownAsset.status, 404);
  const traversal = await fetch(`${ui.origin}/..%2Fpackage.json`, { headers: { Cookie: cookie } });
  assert.equal(traversal.status, 404);

  const forgedHost = await requestWithHost(ui.origin, "attacker.invalid");
  assert.equal(forgedHost.status, 400);
  assert.match(forgedHost.body, /invalid_host/u);
});

test("mutation endpoints require same-origin requests and never enable CORS", async (context) => {
  let chatCalls = 0;
  const fixture = await startFixture(context, {
    chat: ({ message, responseLanguage }) => {
      chatCalls += 1;
      return { taskId: "task-1", accepted: message, responseLanguage };
    },
    listProjects: () => [],
  });

  const body = JSON.stringify({ sessionId: "session-1", message: "hello", responseLanguage: "pt" });
  const commonHeaders = { "Content-Type": "application/json" };
  const missingOrigin = await jsonRequest(fixture, "/api/chat", { method: "POST", headers: commonHeaders, body });
  assert.equal(missingOrigin.status, 403);
  const foreignOrigin = await jsonRequest(fixture, "/api/chat", {
    method: "POST",
    headers: { ...commonHeaders, Origin: "https://attacker.invalid" },
    body,
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(chatCalls, 0);

  const accepted = await jsonRequest(fixture, "/api/chat", {
    method: "POST",
    headers: { ...commonHeaders, Origin: fixture.ui.origin },
    body,
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await accepted.json(), { taskId: "task-1", accepted: "hello", responseLanguage: "pt" });
  assert.equal(chatCalls, 1);

  const invalidLanguage = await jsonRequest(fixture, "/api/chat", {
    method: "POST",
    headers: { ...commonHeaders, Origin: fixture.ui.origin },
    body: JSON.stringify({ sessionId: "session-1", message: "hello", responseLanguage: "fr" }),
  });
  assert.equal(invalidLanguage.status, 400);
  assert.deepEqual(await invalidLanguage.json(), { error: "invalid_response_language" });
  assert.equal(chatCalls, 1);

  const crossOriginRead = await jsonRequest(fixture, "/api/projects", {
    headers: { Origin: "https://attacker.invalid" },
  });
  assert.equal(crossOriginRead.status, 403);
});

test("JSON body limits and content type checks run before callbacks", async (context) => {
  let calls = 0;
  const fixture = await startFixture(
    context,
    {
      chat: () => {
        calls += 1;
        return {};
      },
    },
    { bodyLimitBytes: 256 },
  );

  const oversized = await jsonRequest(fixture, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: fixture.ui.origin },
    body: JSON.stringify({ sessionId: "s", message: "x".repeat(400) }),
  });
  assert.equal(oversized.status, 413);

  const wrongType = await jsonRequest(fixture, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: fixture.ui.origin },
    body: "not json",
  });
  assert.equal(wrongType.status, 415);
  assert.equal(calls, 0);
});

test("public projection removes credentials and private reasoning", async (context) => {
  const fixture = await startFixture(context, {
    listProjects: () => ({
      projects: [
        {
          id: "safe",
          name: "Visible",
          apiKey: "sk-this-must-never-leak",
          nested: { rawCoT: "private chain", accessToken: "token-value", authToken: "auth-value" },
          summary: "Authenticated with Bearer abcdefghijklmnopqrstuvwxyz",
        },
      ],
      providerEvent: { type: "reasoning_delta", content: "private model reasoning" },
    }),
  });
  const response = await jsonRequest(fixture, "/api/projects");
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /must-never-leak|private chain|token-value|auth-value|private model reasoning/iu);
  assert.doesNotMatch(text, /apiKey|rawCoT|accessToken|authToken/iu);
  assert.match(text, /Bearer \[REDACTED\]/u);
  assert.match(text, /reasoning\.activity/u);

  const circular: Record<string, unknown> = { password: "no", safe: "yes" };
  circular.self = circular;
  assert.deepEqual(JSON.parse(JSON.stringify(sanitizePublicValue(circular))), {
    safe: "yes",
    self: "[circular omitted]",
  });
});

test("all runtime routes preserve the callback boundary and validate inputs", async (context) => {
  const calls: string[] = [];
  const fixture = await startFixture(context, {
    listSessions: (projectId) => {
      calls.push(`sessions:${projectId}`);
      return { sessions: [] };
    },
    listMessages: (sessionId) => {
      calls.push(`messages:${sessionId}`);
      return { messages: [] };
    },
    createSession: (projectId, title) => {
      calls.push(`create:${projectId}:${title}`);
      return { id: "s2" };
    },
    search: ({ query, sessionId }) => {
      calls.push(`search:${query}:${sessionId}`);
      return { results: [] };
    },
    listTasks: (sessionId) => {
      calls.push(`tasks:${sessionId}`);
      return { tasks: [] };
    },
    listProviders: () => {
      calls.push("providers");
      return { providers: [] };
    },
    listModels: (provider) => {
      calls.push(`models:${provider}`);
      return { models: [] };
    },
    getRouting: () => {
      calls.push("routing:get");
      return { fallbackModels: [], fusion: { enabled: false } };
    },
    updateRouting: (routing) => {
      calls.push(`routing:set:${routing.fusion.mode}:${routing.fusion.models.join(",")}`);
      return routing;
    },
    steer: ({ taskId, message }) => {
      calls.push(`steer:${taskId}:${message}`);
      return { queued: true };
    },
    stop: (taskId) => {
      calls.push(`stop:${taskId}`);
      return { queued: true };
    },
    resolveApproval: ({ id, approved }) => {
      calls.push(`approval:${id}:${approved}`);
      return { resolved: true };
    },
  });

  const getPaths = [
    "/api/sessions?projectId=p1",
    "/api/messages?sessionId=s1",
    "/api/search?q=decision&sessionId=s1",
    "/api/tasks?sessionId=s1",
    "/api/providers",
    "/api/models?provider=omp",
    "/api/routing",
  ];
  for (const path of getPaths) assert.equal((await jsonRequest(fixture, path)).status, 200);

  const mutationHeaders = { "Content-Type": "application/json", Origin: fixture.ui.origin };
  assert.equal(
    (
      await jsonRequest(fixture, "/api/sessions", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ projectId: "p1", title: "New" }),
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await jsonRequest(fixture, "/api/steer", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ taskId: "t1", message: "more tests" }),
      })
    ).status,
    202,
  );
  assert.equal(
    (
      await jsonRequest(fixture, "/api/stop", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ taskId: "t1" }),
      })
    ).status,
    202,
  );
  assert.equal(
    (
      await jsonRequest(fixture, "/api/approval", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ id: "a1", approved: false }),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await jsonRequest(fixture, "/api/routing", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          fallbackModels: ["provider/fallback"],
          fusion: {
            enabled: true,
            mode: "fusion",
            models: ["provider/a", "neuralwatt/b"],
            synthesisModel: "provider/judge",
            maxParallel: 2,
          },
        }),
      })
    ).status,
    200,
  );

  assert.deepEqual(calls, [
    "sessions:p1",
    "messages:s1",
    "search:decision:s1",
    "tasks:s1",
    "providers",
    "models:omp",
    "routing:get",
    "create:p1:New",
    "steer:t1:more tests",
    "stop:t1",
    "approval:a1:false",
    "routing:set:fusion:provider/a,neuralwatt/b",
  ]);
});

test("routing endpoint rejects malformed orchestration before callback", async (context) => {
  let calls = 0;
  const fixture = await startFixture(context, {
    updateRouting: () => {
      calls += 1;
      return {};
    },
  });
  const headers = { "Content-Type": "application/json", Origin: fixture.ui.origin };
  const malformed = [
    { fallbackModels: [], fusion: { enabled: true, mode: "unknown", models: [], synthesisModel: "", maxParallel: 2 } },
    { fallbackModels: [], fusion: { enabled: "yes", mode: "fusion", models: [], synthesisModel: "", maxParallel: 2 } },
    { fallbackModels: [], fusion: { enabled: false, mode: "fusion", models: [], synthesisModel: "", maxParallel: 9 } },
    {
      fallbackModels: Array.from({ length: 9 }, (_, index) => `provider/${index}`),
      fusion: { enabled: false, mode: "fusion", models: [], synthesisModel: "", maxParallel: 2 },
    },
  ];
  for (const body of malformed) {
    const response = await jsonRequest(fixture, "/api/routing", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test("UI approvals are single-use and fail closed on shutdown", async () => {
  const broker = new UiApprovalBroker(5_000);
  const decision = broker.request("task-1", "Open an external site");
  const [pending] = broker.list("task-1");
  assert.ok(pending);
  assert.equal(pending.description, "Open an external site");
  assert.equal(broker.resolve(pending.id, true).type, "approval.resolved");
  assert.equal(await decision, true);
  assert.throws(() => broker.resolve(pending.id, true), /Unknown or expired/);

  const bidiDecision = broker.request("task-bidi", "write safe.txt\u202eexe.txt");
  const [bidiPending] = broker.list("task-bidi");
  assert.equal(bidiPending?.description, "write safe.txt\\u202eexe.txt");
  assert.ok(bidiPending);
  broker.resolve(bidiPending.id, false);
  assert.equal(await bidiDecision, false);

  const deniedOnClose = broker.request("task-2", "Control the desktop");
  broker.close();
  assert.equal(await deniedOnClose, false);
});

test("approval endpoint rejects non-boolean decisions before callback", async (context) => {
  let calls = 0;
  const fixture = await startFixture(context, {
    resolveApproval: () => {
      calls += 1;
      return {};
    },
  });
  const response = await jsonRequest(fixture, "/api/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: fixture.ui.origin },
    body: JSON.stringify({ id: "approval-1", approved: "yes" }),
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("SSE events are authenticated, sanitized and cleaned up on shutdown", async (context) => {
  let cleaned = false;
  const fixture = await startFixture(context, {
    subscribeEvents: (_request, emit) => {
      emit({
        type: "trace",
        summary: `tool authenticated with sk-${"abcdefghijklmnopqrstuvwxyz"}`,
        refreshToken: "do-not-send",
      });
      return async () => {
        cleaned = true;
      };
    },
  });

  const unauthenticated = await fetch(`${fixture.ui.origin}/api/events?sessionId=s1`);
  assert.equal(unauthenticated.status, 401);

  const response = await jsonRequest(fixture, "/api/events?sessionId=s1", {
    headers: { Origin: fixture.ui.origin },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/u);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("[REDACTED]")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(received, /"type":"ready"/u);
  assert.match(received, /\[REDACTED\]/u);
  assert.doesNotMatch(received, /do-not-send|refreshToken/u);

  await fixture.ui.close();
  assert.equal(cleaned, true);
});

test("browser client uses DOM text projection instead of HTML injection", async () => {
  const script = await readFile(resolve(process.cwd(), "ui", "app.js"), "utf8");
  const markup = await readFile(resolve(process.cwd(), "ui", "index.html"), "utf8");
  assert.doesNotMatch(script, /\.innerHTML\b/u);
  assert.match(script, /\.textContent\b/u);
  assert.match(script, /replaceChildren/u);
  assert.match(markup, /id="search-all-projects"/u);
  assert.match(markup, /id="routing-dialog"/u);
  assert.match(markup, /<html lang="en">/u);
  assert.match(markup, /id="language-select"/u);
  assert.match(markup, /data-i18n="language\.portuguese"/u);
  assert.match(script, /selectedRoutingValues/u);
  assert.match(script, /readStoredLocale\(window\.localStorage\)/u);
  assert.match(script, /persistLocale\(window\.localStorage, locale\)/u);
  assert.match(script, /languageSelect\.addEventListener\("change"/u);
  assert.match(script, /responseLanguage: state\.locale/u);
  assert.match(script, /querySelectorAll\("\[data-trace-timestamp\]"\)/u);
  assert.match(script, /time\.dataset\.traceTimestamp/u);
  assert.match(script, /INVALID_FIELD_KEYS\[normalized\.slice\(8\)\]/u);
  assert.match(script, /return message \|\| normalized/u, "unknown error content must remain verbatim");
  assert.match(script, /!byId\("search-all-projects"\)\.checked/u, "global search must omit project/session filters only after an explicit UI choice");
  assert.match(script, /\["rootPath", "path", "updatedAt"\]/u, "project navigation must expose the canonical linked folder");
});

test("locale catalog defaults to English and persists an explicit Portuguese choice", async () => {
  interface TranslationDescriptor {
    key: string;
    parameters: Record<string, string>;
  }
  interface LocaleStorage {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => unknown;
  }
  const moduleUrl = pathToFileURL(resolve(process.cwd(), "ui", "locales.js")).href;
  const localeModule = (await import(moduleUrl)) as {
    DEFAULT_LOCALE: string;
    LOCALE_STORAGE_KEY: string;
    EVENT_TITLE_KEYS: Record<string, string>;
    STABLE_TRACE_LABEL_KEYS: Record<string, string>;
    FUSION_TRACE_TITLE_KEYS: Record<string, string>;
    FUSION_REASON_DETAIL_KEYS: Record<string, string>;
    ERROR_KEYS: Record<string, string>;
    INVALID_FIELD_KEYS: Record<string, string>;
    MEMORY_KIND_KEYS: Record<string, string>;
    MEMORY_REVIEW_KEYS: Record<string, string>;
    translations: { en: Record<string, string>; pt: Record<string, string> };
    translate: (locale: string, key: string, parameters?: Record<string, string>) => string;
    traceTitleDescriptor: (event: Record<string, unknown>) => TranslationDescriptor | undefined;
    traceDetailDescriptor: (event: Record<string, unknown>, value: string) => TranslationDescriptor | undefined;
    readStoredLocale: (storage: LocaleStorage) => string;
    persistLocale: (storage: LocaleStorage, locale: string) => string;
  };
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } satisfies LocaleStorage;

  assert.equal(localeModule.DEFAULT_LOCALE, "en");
  assert.equal(localeModule.readStoredLocale(storage), "en");
  assert.equal(localeModule.translate("en", "empty.title"), "One agent, multiple minds.");
  assert.equal(localeModule.translate("pt-PT", "empty.title"), "Um agente, várias mentes."); // language-audit: allow-portuguese-input
  assert.equal(localeModule.translate("pt", "message.guidance", { message: "Mais testes" }), "Orientação: Mais testes"); // language-audit: allow-portuguese-input
  assert.deepEqual(Object.keys(localeModule.translations.en).sort(), Object.keys(localeModule.translations.pt).sort());

  const mappedKeyCatalogs = [
    localeModule.EVENT_TITLE_KEYS,
    localeModule.STABLE_TRACE_LABEL_KEYS,
    localeModule.FUSION_TRACE_TITLE_KEYS,
    localeModule.FUSION_REASON_DETAIL_KEYS,
    localeModule.ERROR_KEYS,
    localeModule.INVALID_FIELD_KEYS,
    localeModule.MEMORY_KIND_KEYS,
    localeModule.MEMORY_REVIEW_KEYS,
  ];
  for (const key of mappedKeyCatalogs.flatMap((catalog) => Object.values(catalog))) {
    assert.ok(Object.hasOwn(localeModule.translations.en, key), `mapped key missing from English catalog: ${key}`);
    assert.ok(Object.hasOwn(localeModule.translations.pt, key), `mapped key missing from Portuguese catalog: ${key}`);
    assert.ok(localeModule.translate("en", key).trim(), `empty English translation: ${key}`);
    assert.ok(localeModule.translate("pt", key).trim(), `empty Portuguese translation: ${key}`);
  }
  for (const [label, key] of Object.entries(localeModule.STABLE_TRACE_LABEL_KEYS)) {
    const descriptor = localeModule.traceTitleDescriptor({ type: "trace.public", kind: "lifecycle", label });
    assert.equal(descriptor?.key, key);
    assert.equal(localeModule.translate("en", descriptor?.key ?? ""), label);
  }
  for (const [token, key] of Object.entries(localeModule.EVENT_TITLE_KEYS)) {
    assert.equal(localeModule.traceTitleDescriptor({ type: token })?.key, key);
  }
  for (const [token, key] of Object.entries(localeModule.FUSION_TRACE_TITLE_KEYS)) {
    const [stage, phase] = token.split(".");
    assert.ok(stage && phase);
    const label = stage === "consultant" ? `Fusion consultant 3 ${phase}` : `Fusion ${stage} ${phase}`;
    assert.equal(localeModule.traceTitleDescriptor({ type: "trace.public", kind: "reasoning", phase, label })?.key, key);
  }

  const stableDetails: Array<[Record<string, unknown>, string, string]> = [
    [{ label: "Turn started" }, "session=s-1", "trace.detailTurnSession"],
    [{ label: "Turn started" }, "session=s-1; workflow_key=w-1", "trace.detailTurnWorkflow"],
    [{ label: "Governed memory recalled" }, "0 item(s): none", "trace.detailMemoryNone"],
    [{ label: "Governed memory recalled" }, "3 item(s): 7, 8, 9", "trace.detailMemoryItems"],
    [{ label: "Fusion skipped for exact model route" }, "model=provider/model; no consultant received the prompt", "trace.detailExactRoute"],
    [{ label: "Multi-model advisory panel completed" }, "2/3 usable consultant answer(s); mode=moa", "trace.detailAdvisoryPanel"],
    [{ label: "Provider attempt completed" }, "4 tool call(s)", "trace.detailToolCalls"],
    [{ label: "Provider reasoning in progress" }, "800 private reasoning characters processed", "trace.detailReasoningProcessed"],
    [{ label: "Provider reasoning completed" }, "1600 private reasoning characters processed; content not persisted", "trace.detailReasoningNotPersisted"],
    [{ label: "Provider attempt failed" }, "external error; fallback=allowed", "trace.detailFallbackAllowed"],
    [{ label: "Provider attempt failed" }, "external error; fallback=blocked by side-effect ledger", "trace.detailFallbackBlocked"],
    [{ kind: "reasoning", phase: "completed", label: "Fusion consultant 1 completed" }, "42ms", "trace.detailFusionDuration"],
  ];
  for (const [event, detail, key] of stableDetails) assert.equal(localeModule.traceDetailDescriptor(event, detail)?.key, key);
  for (const [reason, key] of Object.entries(localeModule.FUSION_REASON_DETAIL_KEYS)) {
    const descriptor = localeModule.traceDetailDescriptor({ kind: "reasoning", phase: "failed", label: "Fusion synthesis failed" }, `42ms; reason=${reason}`);
    assert.equal(descriptor?.key, key);
  }

  const [markup, script] = await Promise.all([
    readFile(resolve(process.cwd(), "ui", "index.html"), "utf8"),
    readFile(resolve(process.cwd(), "ui", "app.js"), "utf8"),
  ]);
  const eventTokens = new Set([
    "approval.requested",
    "approval.resolved",
    "task.started",
    "task.running",
    "task.update",
    "task.completed",
    "task.failed",
    "task.stopped",
    "task.cancelled",
  ]);
  const referencedKeys = new Set([
    ...[...markup.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9.]+)"/gu)].flatMap((match) => (match[1] ? [match[1]] : [])),
    ...[
      ...script.matchAll(
        /"((?:approval|common|composer|controls|document|empty|error|field|language|memory|message|projects|routing|sessions|sidebar|status|task|toast|trace|workspace)\.[A-Za-z0-9]+)"/gu,
      ),
    ].flatMap((match) => (match[1] && !eventTokens.has(match[1]) ? [match[1]] : [])),
  ]);
  for (const key of referencedKeys) {
    assert.ok(Object.hasOwn(localeModule.translations.en, key), `missing English UI translation: ${key}`);
    assert.ok(Object.hasOwn(localeModule.translations.pt, key), `missing Portuguese UI translation: ${key}`);
  }

  assert.equal(localeModule.persistLocale(storage, "pt-PT"), "pt");
  assert.equal(values.get(localeModule.LOCALE_STORAGE_KEY), "pt");
  assert.equal(localeModule.readStoredLocale(storage), "pt");
  const unavailableStorage = {
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("storage unavailable");
    },
  } satisfies LocaleStorage;
  assert.equal(localeModule.readStoredLocale(unavailableStorage), "en");
  assert.equal(localeModule.persistLocale(unavailableStorage, "pt"), "pt");

  const render = (locale: string, descriptor: TranslationDescriptor | undefined): string => {
    assert.ok(descriptor);
    return localeModule.translate(locale, descriptor.key, descriptor.parameters);
  };
  const renderMapped = (locale: string, catalog: Record<string, string>, token: string): string => {
    const key = catalog[token];
    assert.ok(key);
    return localeModule.translate(locale, key);
  };
  assert.equal(render("pt", localeModule.traceTitleDescriptor({ type: "reasoning.activity", status: "active" })), "Atividade de raciocínio do provider"); // language-audit: allow-portuguese-input
  assert.equal(renderMapped("pt", localeModule.ERROR_KEYS, "starting"), "A UI local ainda está a iniciar."); // language-audit: allow-portuguese-input
  assert.equal(renderMapped("pt", localeModule.ERROR_KEYS, "request_failed"), "Não foi possível concluir o pedido local."); // language-audit: allow-portuguese-input
  assert.equal(renderMapped("pt", localeModule.ERROR_KEYS, "invalid_response_language"), "O idioma das respostas tem de ser inglês ou português."); // language-audit: allow-portuguese-input
  assert.equal(renderMapped("pt", localeModule.MEMORY_KIND_KEYS, "evidence"), "EVIDÊNCIA"); // language-audit: allow-portuguese-input
  assert.equal(renderMapped("pt", localeModule.MEMORY_REVIEW_KEYS, "approved"), "Aprovada"); // language-audit: allow-portuguese-input
  assert.equal(
    render(
      "pt",
      localeModule.traceTitleDescriptor({ type: "trace.public", kind: "tool", phase: "started", label: "Tool workspace_read", tool: "workspace_read" }),
    ),
    "Ferramenta workspace_read", // language-audit: allow-portuguese-input
  );
  assert.equal(
    render("pt", localeModule.traceTitleDescriptor({ type: "trace.public", kind: "reasoning", phase: "completed", label: "Fusion consultant 2 completed" })),
    "Consultor Fusion 2 concluído", // language-audit: allow-portuguese-input
  );
  assert.equal(
    render("pt", localeModule.traceDetailDescriptor({ label: "Governed memory recalled" }, "3 item(s): 7, 8, 9")),
    "3 elemento(s) de memória: 7, 8, 9", // language-audit: allow-portuguese-input
  );
  assert.equal(
    render("pt", localeModule.traceDetailDescriptor({ label: "Provider attempt failed" }, "quota failure from provider; fallback=allowed")),
    "quota failure from provider; fallback permitido", // language-audit: allow-portuguese-input
  );
  assert.equal(localeModule.traceTitleDescriptor({ type: "trace.public", kind: "provider", label: "Arbitrary provider title" }), undefined);
  assert.equal(localeModule.traceDetailDescriptor({ label: "Provider attempt failed" }, "arbitrary external failure"), undefined);
});
