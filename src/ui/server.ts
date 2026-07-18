import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSensitiveKeyName } from "../security/secrets.js";
import { isResponseLanguage, type ResponseLanguage } from "../response-language.js";

const LOOPBACK_HOST = "127.0.0.1";
const COOKIE_NAME = "superai_ui_session";
const DEFAULT_BODY_LIMIT = 64 * 1024;
const MAX_PUBLIC_RESPONSE_BYTES = 1024 * 1024;

const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "manifest-src 'self'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

type Awaitable<T> = T | Promise<T>;

export interface UiRequestContext {
  signal: AbortSignal;
}

export interface UiSearchRequest {
  query: string;
  projectId?: string;
  sessionId?: string;
}

export interface UiChatRequest {
  sessionId: string;
  message: string;
  provider?: string;
  model?: string;
  responseLanguage?: ResponseLanguage;
}

export interface UiSteerRequest {
  taskId: string;
  message: string;
}

export interface UiApprovalDecision {
  id: string;
  approved: boolean;
}

export interface UiRoutingSettings {
  fallbackModels: string[];
  fusion: {
    enabled: boolean;
    mode: "moa" | "fusion";
    models: string[];
    synthesisModel: string;
    maxParallel: number;
  };
}

export interface UiEventsRequest {
  projectId?: string;
  sessionId?: string;
  taskId?: string;
}

export type UiEventEmitter = (event: unknown) => void;
export type UiEventCleanup = void | (() => void | Promise<void>);

/**
 * The UI owns no agent state. Every operation crosses this narrow callback
 * boundary so the runtime can keep policy, persistence and approvals in one
 * place.
 */
export interface UiCallbacks {
  listProjects?: (context: UiRequestContext) => Awaitable<unknown>;
  listSessions?: (projectId: string | undefined, context: UiRequestContext) => Awaitable<unknown>;
  listMessages?: (sessionId: string, context: UiRequestContext) => Awaitable<unknown>;
  createSession?: (projectId: string, title: string | undefined, context: UiRequestContext) => Awaitable<unknown>;
  search?: (request: UiSearchRequest, context: UiRequestContext) => Awaitable<unknown>;
  listTasks?: (sessionId: string | undefined, context: UiRequestContext) => Awaitable<unknown>;
  listProviders?: (context: UiRequestContext) => Awaitable<unknown>;
  listModels?: (provider: string | undefined, context: UiRequestContext) => Awaitable<unknown>;
  getRouting?: (context: UiRequestContext) => Awaitable<unknown>;
  updateRouting?: (request: UiRoutingSettings, context: UiRequestContext) => Awaitable<unknown>;
  chat?: (request: UiChatRequest, context: UiRequestContext) => Awaitable<unknown>;
  steer?: (request: UiSteerRequest, context: UiRequestContext) => Awaitable<unknown>;
  stop?: (taskId: string, context: UiRequestContext) => Awaitable<unknown>;
  resolveApproval?: (request: UiApprovalDecision, context: UiRequestContext) => Awaitable<unknown>;
  subscribeEvents?: (request: UiEventsRequest, emit: UiEventEmitter, context: UiRequestContext) => Awaitable<UiEventCleanup>;
  onError?: (error: unknown) => void;
}

export interface StartLocalUiOptions {
  callbacks: UiCallbacks;
  port?: number;
  bodyLimitBytes?: number;
  staticRoot?: string;
}

export interface LocalUiServer {
  origin: string;
  /** Contains a short-lived secret. Show it to the local user, never log it remotely. */
  bootstrapUrl: string;
  port: number;
  close: () => Promise<void>;
}

interface RequestState {
  origin: string;
  expectedHost: string;
  sessionDigest: Buffer;
  bodyLimitBytes: number;
  callbacks: UiCallbacks;
  staticRoot: string;
  bootstrapDigest: Buffer | undefined;
  sseResponses: Set<ServerResponse>;
  sseClosers: Map<ServerResponse, () => Promise<void>>;
  closing: boolean;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeMatches(candidate: string, expectedDigest: Buffer | undefined): boolean {
  if (!expectedDigest) return false;
  const candidateDigest = digest(candidate);
  return candidateDigest.length === expectedDigest.length && timingSafeEqual(candidateDigest, expectedDigest);
}

function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const publicValue = sanitizePublicValue(value);
  let body = JSON.stringify(publicValue);
  if (Buffer.byteLength(body, "utf8") > MAX_PUBLIC_RESPONSE_BYTES) {
    body = JSON.stringify({ error: "response_too_large" });
    status = 502;
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  response.end(body);
}

function isSensitiveKey(key: string): boolean {
  return isSensitiveKeyName(key);
}

function redactCredentialPatterns(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[_A-Za-z0-9-]{12,}\b/gu, "[REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
}

function isPrivateReasoningEvent(value: Record<string, unknown>): boolean {
  const discriminator = [value.type, value.kind, value.event]
    .filter((entry): entry is string => typeof entry === "string")
    .join(" ")
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase();
  return (
    discriminator.includes("thinking") ||
    discriminator.includes("reasoningdelta") ||
    discriminator.includes("reasoningcontent") ||
    discriminator.includes("rawreasoning") ||
    discriminator.includes("chainofthought") ||
    discriminator.includes("rawcot")
  );
}

/** Defensive last-mile projection. Runtime callbacks should already return DTOs. */
export function sanitizePublicValue(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (depth > 12) return "[depth omitted]";
    if (current === null || typeof current === "boolean" || typeof current === "number") return current;
    if (typeof current === "string") return redactCredentialPatterns(current);
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "undefined" || typeof current === "function" || typeof current === "symbol") return null;
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Uint8Array) return "[binary omitted]";
    if (typeof current !== "object") return null;
    if (seen.has(current)) return "[circular omitted]";
    seen.add(current);

    if (Array.isArray(current)) return current.map((entry) => visit(entry, depth + 1));

    const record = current as Record<string, unknown>;
    if (isPrivateReasoningEvent(record)) {
      return { type: "reasoning.activity", status: "active" };
    }

    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor" || isSensitiveKey(key)) continue;
      output[key] = visit(entry, depth + 1);
    }
    return output;
  };

  return visit(value, 0);
}

function parseCookies(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function isAuthenticated(request: IncomingMessage, state: RequestState): boolean {
  const session = parseCookies(request).get(COOKIE_NAME);
  return typeof session === "string" && constantTimeMatches(session, state.sessionDigest);
}

function verifyRequestBoundary(request: IncomingMessage, state: RequestState): void {
  if (request.headers.host?.toLowerCase() !== state.expectedHost) throw new HttpError(400, "invalid_host");

  const remoteAddress = request.socket.remoteAddress;
  if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1" && remoteAddress !== "::ffff:127.0.0.1") {
    throw new HttpError(403, "loopback_only");
  }

  if (
    request.headers["x-forwarded-host"] !== undefined ||
    request.headers["x-forwarded-for"] !== undefined ||
    request.headers["x-forwarded-proto"] !== undefined
  ) {
    throw new HttpError(400, "proxy_headers_rejected");
  }

  const origin = request.headers.origin;
  if (origin !== undefined && origin !== state.origin) throw new HttpError(403, "invalid_origin");

  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "cross_site_rejected");
  }
}

function requireMutationOrigin(request: IncomingMessage, state: RequestState): void {
  if (request.headers.origin !== state.origin) throw new HttpError(403, "origin_required");
}

function requestContext(request: IncomingMessage, response: ServerResponse): UiRequestContext {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  return { signal: controller.signal };
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "json_required");

  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    request.resume();
    throw new HttpError(413, "body_too_large");
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) throw new HttpError(413, "body_too_large");
    chunks.push(buffer);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "object_required");
  return parsed as Record<string, unknown>;
}

function optionalString(value: unknown, name: string, maxLength = 256): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(400, `invalid_${name}`);
  }
  return value;
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  const result = optionalString(value, name, maxLength);
  if (!result?.trim()) throw new HttpError(400, `invalid_${name}`);
  return result;
}

async function invoke(callback: ((...args: never[]) => Awaitable<unknown>) | undefined, args: unknown[]): Promise<unknown> {
  if (!callback) throw new HttpError(501, "capability_unavailable");
  return callback(...(args as never[]));
}

function eventRequestFrom(url: URL): UiEventsRequest {
  const projectId = optionalString(url.searchParams.get("projectId"), "project_id");
  const sessionId = optionalString(url.searchParams.get("sessionId"), "session_id");
  const taskId = optionalString(url.searchParams.get("taskId"), "task_id");
  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(taskId === undefined ? {} : { taskId }),
  };
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL, state: RequestState): Promise<void> {
  if (!isAuthenticated(request, state)) throw new HttpError(401, "authentication_required");
  const context = requestContext(request, response);

  if (request.method === "GET" && url.pathname === "/api/projects") {
    sendJson(response, 200, await invoke(state.callbacks.listProjects, [context]));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const projectId = optionalString(url.searchParams.get("projectId"), "project_id");
    sendJson(response, 200, await invoke(state.callbacks.listSessions, [projectId, context]));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/search") {
    const query = optionalString(url.searchParams.get("q"), "query", 2_000) ?? "";
    const projectId = optionalString(url.searchParams.get("projectId"), "project_id");
    const sessionId = optionalString(url.searchParams.get("sessionId"), "session_id");
    const searchRequest: UiSearchRequest = {
      query,
      ...(projectId === undefined ? {} : { projectId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    sendJson(response, 200, await invoke(state.callbacks.search, [searchRequest, context]));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/messages") {
    const sessionId = requiredString(url.searchParams.get("sessionId"), "session_id", 256);
    sendJson(response, 200, await invoke(state.callbacks.listMessages, [sessionId, context]));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/tasks") {
    const sessionId = optionalString(url.searchParams.get("sessionId"), "session_id");
    sendJson(response, 200, await invoke(state.callbacks.listTasks, [sessionId, context]));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/providers") {
    sendJson(response, 200, await invoke(state.callbacks.listProviders, [context]));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/models") {
    const provider = optionalString(url.searchParams.get("provider"), "provider");
    sendJson(response, 200, await invoke(state.callbacks.listModels, [provider, context]));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/routing") {
    sendJson(response, 200, await invoke(state.callbacks.getRouting, [context]));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    await openEventStream(response, eventRequestFrom(url), state, context);
    return;
  }

  if (request.method === "POST") {
    requireMutationOrigin(request, state);
    const body = await readJsonBody(request, state.bodyLimitBytes);
    if (url.pathname === "/api/sessions") {
      const projectId = requiredString(body.projectId, "project_id", 256);
      const title = optionalString(body.title, "title", 200);
      sendJson(response, 201, await invoke(state.callbacks.createSession, [projectId, title, context]));
      return;
    }
    if (url.pathname === "/api/chat") {
      const sessionId = requiredString(body.sessionId, "session_id", 256);
      const message = requiredString(body.message, "message", 32_000);
      const provider = optionalString(body.provider, "provider");
      const model = optionalString(body.model, "model");
      const responseLanguage = optionalResponseLanguage(body.responseLanguage);
      const chatRequest: UiChatRequest = {
        sessionId,
        message,
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(responseLanguage === undefined ? {} : { responseLanguage }),
      };
      sendJson(response, 202, await invoke(state.callbacks.chat, [chatRequest, context]));
      return;
    }
    if (url.pathname === "/api/steer") {
      const taskId = requiredString(body.taskId, "task_id", 256);
      const message = requiredString(body.message, "message", 8_000);
      sendJson(response, 202, await invoke(state.callbacks.steer, [{ taskId, message }, context]));
      return;
    }
    if (url.pathname === "/api/stop") {
      const taskId = requiredString(body.taskId, "task_id", 256);
      sendJson(response, 202, await invoke(state.callbacks.stop, [taskId, context]));
      return;
    }
    if (url.pathname === "/api/approval") {
      const id = requiredString(body.id, "approval_id", 256);
      const approved = requiredBoolean(body.approved, "approved");
      sendJson(response, 200, await invoke(state.callbacks.resolveApproval, [{ id, approved }, context]));
      return;
    }
    if (url.pathname === "/api/routing") {
      const fusionValue = body.fusion;
      if (typeof fusionValue !== "object" || fusionValue === null || Array.isArray(fusionValue)) {
        throw new HttpError(400, "invalid_fusion");
      }
      const fusion = fusionValue as Record<string, unknown>;
      const mode = requiredString(fusion.mode, "fusion_mode", 16);
      if (mode !== "moa" && mode !== "fusion") throw new HttpError(400, "invalid_fusion_mode");
      const routing: UiRoutingSettings = {
        fallbackModels: requiredStringArray(body.fallbackModels, "fallback_models", 8, 240),
        fusion: {
          enabled: requiredBoolean(fusion.enabled, "fusion_enabled"),
          mode,
          models: requiredStringArray(fusion.models, "fusion_models", 8, 240),
          synthesisModel: optionalString(fusion.synthesisModel, "synthesis_model", 240) ?? "",
          maxParallel: requiredInteger(fusion.maxParallel, "max_parallel", 1, 8),
        },
      };
      sendJson(response, 200, await invoke(state.callbacks.updateRouting, [routing, context]));
      return;
    }
  }

  if (request.method === "OPTIONS") throw new HttpError(405, "method_not_allowed");
  throw new HttpError(404, "not_found");
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, `invalid_${name}`);
  return value;
}

function optionalResponseLanguage(value: unknown): ResponseLanguage | undefined {
  if (value === undefined) return undefined;
  if (!isResponseLanguage(value)) throw new HttpError(400, "invalid_response_language");
  return value;
}

function requiredInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new HttpError(400, `invalid_${name}`);
  }
  return value as number;
}

function requiredStringArray(value: unknown, name: string, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new HttpError(400, `invalid_${name}`);
  const selected = value.map((item) => requiredString(item, name, maximumLength));
  if (new Set(selected).size !== selected.length) throw new HttpError(400, `invalid_${name}`);
  return selected;
}

async function openEventStream(response: ServerResponse, subscriptionRequest: UiEventsRequest, state: RequestState, context: UiRequestContext): Promise<void> {
  const subscribe = state.callbacks.subscribeEvents;
  if (!subscribe) throw new HttpError(501, "capability_unavailable");

  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  state.sseResponses.add(response);

  let sequence = 0;
  const emit: UiEventEmitter = (event) => {
    if (response.destroyed || response.writableEnded || state.closing) return;
    const data = JSON.stringify(sanitizePublicValue(event));
    if (Buffer.byteLength(data, "utf8") > MAX_PUBLIC_RESPONSE_BYTES) return;
    sequence += 1;
    response.write(`id: ${sequence}\nevent: message\ndata: ${data}\n\n`);
  };

  emit({ type: "ready" });
  let cleanup: UiEventCleanup;
  try {
    cleanup = await subscribe(subscriptionRequest, emit, context);
  } catch (error) {
    state.callbacks.onError?.(error);
    emit({ type: "subscription.error" });
    response.end();
    state.sseResponses.delete(response);
    return;
  }

  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(": heartbeat\n\n");
  }, 20_000);
  heartbeat.unref();

  let cleanupPromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      clearInterval(heartbeat);
      state.sseResponses.delete(response);
      state.sseClosers.delete(response);
      if (typeof cleanup === "function") {
        try {
          await cleanup();
        } catch (error) {
          state.callbacks.onError?.(error);
        }
      }
    })();
    return cleanupPromise;
  };
  state.sseClosers.set(response, close);
  response.once("close", () => void close());
  if (response.destroyed || response.writableEnded || state.closing) await close();
}

const STATIC_FILES = new Map<string, { file: string; type: string }>([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/locales.js", { file: "locales.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/axiomux-emblem.png", { file: "../assets/axiomux-emblem.png", type: "image/png" }],
]);

async function serveStatic(response: ServerResponse, pathname: string, state: RequestState): Promise<void> {
  const asset = STATIC_FILES.get(pathname);
  if (!asset) throw new HttpError(404, "not_found");
  let body: Buffer;
  try {
    body = await readFile(resolve(state.staticRoot, asset.file));
  } catch {
    throw new HttpError(404, "ui_asset_missing");
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", asset.type);
  response.setHeader("Content-Length", body.length);
  response.end(body);
}

async function resolveStaticRoot(explicitRoot: string | undefined): Promise<string> {
  if (explicitRoot !== undefined) return resolve(explicitRoot);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const fallback = resolve(process.cwd(), "ui");
  const candidates = [resolve(moduleDirectory, "../../ui"), resolve(moduleDirectory, "../../../ui"), fallback];
  for (const candidate of candidates) {
    try {
      await access(resolve(candidate, "index.html"));
      return candidate;
    } catch {
      // Try the source-tree, compiled-package and current-directory layouts.
    }
  }
  return fallback;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, state: RequestState, rawSession: string): Promise<void> {
  applySecurityHeaders(response);
  if (state.closing) throw new HttpError(503, "shutting_down");
  verifyRequestBoundary(request, state);

  const url = new URL(request.url ?? "/", state.origin);
  if (request.method === "GET" && url.pathname === "/bootstrap") {
    const token = url.searchParams.get("token") ?? "";
    if (!constantTimeMatches(token, state.bootstrapDigest)) throw new HttpError(404, "not_found");
    state.bootstrapDigest = undefined;
    response.statusCode = 303;
    response.setHeader("Location", "/");
    response.setHeader("Set-Cookie", `${COOKIE_NAME}=${rawSession}; HttpOnly; SameSite=Strict; Path=/`);
    response.setHeader("Content-Length", "0");
    response.end();
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url, state);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "method_not_allowed");
  if (!isAuthenticated(request, state)) throw new HttpError(401, "authentication_required");
  if (request.method === "HEAD") {
    const asset = STATIC_FILES.get(url.pathname);
    if (!asset) throw new HttpError(404, "not_found");
    response.statusCode = 200;
    response.setHeader("Content-Type", asset.type);
    response.end();
    return;
  }
  await serveStatic(response, url.pathname, state);
}

export async function startLocalUi(options: StartLocalUiOptions): Promise<LocalUiServer> {
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("UI port must be an integer between 0 and 65535");
  }
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes < 256 || bodyLimitBytes > 1024 * 1024) {
    throw new Error("UI body limit must be between 256 bytes and 1 MiB");
  }

  const rawBootstrap = randomBytes(32).toString("base64url");
  const rawSession = randomBytes(32).toString("base64url");
  const staticRoot = await resolveStaticRoot(options.staticRoot);
  const sseResponses = new Set<ServerResponse>();
  const sseClosers = new Map<ServerResponse, () => Promise<void>>();

  let state: RequestState | undefined;
  const server = createServer((request, response) => {
    if (!state) {
      applySecurityHeaders(response);
      sendJson(response, 503, { error: "starting" });
      return;
    }
    void handleRequest(request, response, state, rawSession).catch((error: unknown) => {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.code });
        return;
      }
      state?.callbacks.onError?.(error);
      sendJson(response, 500, { error: "request_failed" });
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(requestedPort, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to determine local UI address");
  }
  const port = address.port;
  const origin = `http://${LOOPBACK_HOST}:${port}`;
  const activeState: RequestState = {
    origin,
    expectedHost: `${LOOPBACK_HOST}:${port}`,
    sessionDigest: digest(rawSession),
    bodyLimitBytes,
    callbacks: options.callbacks,
    staticRoot,
    bootstrapDigest: digest(rawBootstrap),
    sseResponses,
    sseClosers,
    closing: false,
  };
  state = activeState;

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    activeState.closing = true;
    activeState.bootstrapDigest = undefined;
    const responses = [...sseResponses];
    const cleanups = [...sseClosers.values()].map((cleanup) => cleanup());
    for (const response of responses) if (!response.writableEnded) response.end();
    closePromise = Promise.allSettled(cleanups).then(
      () =>
        new Promise<void>((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
    );
    return closePromise;
  };

  return {
    origin,
    bootstrapUrl: `${origin}/bootstrap?token=${encodeURIComponent(rawBootstrap)}`,
    port,
    close,
  };
}
