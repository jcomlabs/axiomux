import { lookup } from "node:dns/promises";
import { realpathSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { basename, resolve } from "node:path";
import ipaddr from "ipaddr.js";
import type { MemoryStore, SourceIngestion } from "./memory/store.js";
import { redactSecrets } from "./security/secrets.js";
import { readGovernedWorkspaceTextFile } from "./tools/workspace-tools.js";
import { captureWorkspaceIdentity, revalidateWorkspaceIdentity, type WorkspaceIdentity } from "./runtime/project-boundary.js";

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

export class SourceHub {
  readonly workspaceRoot: string;
  readonly workspaceIdentity: WorkspaceIdentity;

  constructor(
    private readonly memory: MemoryStore,
    workspaceRoot: string,
    private readonly memoryScope = "global",
    workspaceIdentity?: WorkspaceIdentity,
  ) {
    if (workspaceIdentity) {
      const observedRoot = realpathSync.native(resolve(workspaceRoot));
      if (!sameCanonicalPath(observedRoot, workspaceIdentity.rootPath)) {
        throw new Error("SourceHub workspace does not match its fixed project identity");
      }
      revalidateWorkspaceIdentity(workspaceIdentity);
      this.workspaceIdentity = workspaceIdentity;
    } else {
      this.workspaceIdentity = captureWorkspaceIdentity(workspaceRoot);
    }
    this.workspaceRoot = revalidateWorkspaceIdentity(this.workspaceIdentity);
  }

  ingestText(content: string, label: string, uri = `manual://${Date.now()}`): number {
    return this.ingestTextDetailed(content, label, uri).memoryIds[0] as number;
  }

  ingestTextDetailed(content: string, label: string, uri = `manual://${Date.now()}`): SourceIngestion {
    revalidateWorkspaceIdentity(this.workspaceIdentity);
    return this.memory.addSourceDocument({
      content,
      kind: "evidence",
      reviewStatus: "pending",
      confidence: 0.75,
      scope: this.memoryScope,
      sourceUri: uri,
      sourceLabel: label,
    });
  }

  async ingestMany(sources: string[], concurrency = 4): Promise<Array<{ index: number; memoryId?: number; error?: string }>> {
    if (sources.length === 0 || sources.length > 50) throw new Error("A source batch must contain 1-50 entries");
    if (sources.some((source) => typeof source !== "string" || !source.trim())) throw new Error("Every batch source must be a non-empty string");
    const results: Array<{ index: number; memoryId?: number; error?: string }> = new Array(sources.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), 6, sources.length) }, async () => {
      while (cursor < sources.length) {
        const index = cursor++;
        const source = sources[index]?.trim();
        if (!source) continue;
        try {
          const memoryId = /^https?:\/\//i.test(source) ? await this.ingestUrl(source) : await this.ingestFile(source);
          results[index] = { index, memoryId };
        } catch (error) {
          results[index] = { index, error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1_000) };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async ingestFile(path: string): Promise<number> {
    const result = await this.ingestFileDetailed(path);
    return result.memoryIds[0] as number;
  }

  async ingestFileDetailed(path: string): Promise<SourceIngestion> {
    revalidateWorkspaceIdentity(this.workspaceIdentity);
    const file = await readGovernedWorkspaceTextFile(this.workspaceRoot, path, MAX_SOURCE_BYTES, new AbortController().signal, this.workspaceIdentity);
    return this.memory.addSourceDocument({
      content: redactSecrets(file.content),
      kind: "evidence",
      reviewStatus: "pending",
      confidence: 0.9,
      scope: this.memoryScope,
      sourceUri: redactSecrets(`workspace:///${file.relative.replaceAll("\\", "/")}`),
      sourceLabel: redactSecrets(basename(file.absolute)),
    });
  }

  async ingestUrl(url: string): Promise<number> {
    const result = await this.ingestUrlDetailed(url);
    return result.memoryIds[0] as number;
  }

  async ingestUrlDetailed(url: string): Promise<SourceIngestion> {
    revalidateWorkspaceIdentity(this.workspaceIdentity);
    const { response, finalUrl } = await safeFetch(url);
    if (response.status < 200 || response.status >= 300) throw new Error(`Source fetch failed with HTTP ${response.status}`);
    const contentType = headerValue(response.headers, "content-type");
    if (!contentType) throw new Error("Source response did not declare a supported content type");
    if (!/^(?:text\/|application\/(?:json|xml|xhtml\+xml))/i.test(contentType)) {
      throw new Error(`Unsupported source content type: ${contentType}`);
    }
    const content = contentType.includes("html") ? stripHtml(response.body) : response.body;
    const parsed = new URL(finalUrl);
    const provenanceUrl = sanitizeSourceProvenance(finalUrl);
    return this.memory.addSourceDocument({
      content: redactSecrets(content),
      kind: "evidence",
      reviewStatus: "pending",
      confidence: 0.7,
      scope: this.memoryScope,
      sourceUri: provenanceUrl,
      sourceLabel: parsed.hostname,
    });
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right;
}

export function sanitizeSourceProvenance(input: string): string {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) provenance is supported");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return redactSecrets(url.toString());
}

export function sourceApprovalLabel(input: string): string {
  try {
    const parsed = new URL(input);
    const hadQuery = Boolean(parsed.search || parsed.hash || parsed.username || parsed.password);
    const safe = sanitizeSourceProvenance(input);
    return hadQuery ? `${safe} [sensitive URL components redacted]` : safe;
  } catch {
    return redactSecrets(input)
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .slice(0, 4_096);
  }
}

/**
 * Agent-originated URL fetches must be fully visible at approval time. Query,
 * fragment and userinfo components can hide data or signed credentials, so
 * those remain available only through the operator-driven CLI path.
 */
export function assertAgentSourceIngestionAllowed(input: string): void {
  if (!/^https?:\/\//i.test(input)) return;
  const parsed = new URL(input);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "Agent source ingestion refuses URL userinfo, query strings and fragments; use the explicit CLI source command after reviewing the complete URL",
    );
  }
}

interface PinnedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

async function safeFetch(input: string): Promise<{ response: PinnedResponse; finalUrl: string }> {
  let current = new URL(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const destination = await resolvePublicHttpUrl(current);
    const response = await requestPinned(current, destination.address, destination.family);
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current.toString() };
    const location = headerValue(response.headers, "location");
    if (!location) throw new Error(`Redirect ${response.status} did not include a location`);
    if (redirects === MAX_REDIRECTS) throw new Error(`Source exceeded ${MAX_REDIRECTS} redirects`);
    current = new URL(location, current);
  }
  throw new Error("Source redirect handling failed");
}

async function resolvePublicHttpUrl(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) sources are supported");
  if (url.username || url.password) throw new Error("Credentialed source URLs are not supported");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Private or local source addresses are blocked");
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicSourceAddress(address))) {
    throw new Error("Private, reserved, or unresolved source addresses are blocked");
  }
  const selected = addresses[0];
  if (!selected) throw new Error("Source address resolution returned no usable address");
  return { address: selected.address, family: selected.family as 4 | 6 };
}

export function isPublicSourceAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase().split("%", 1)[0] ?? "";
  if (!normalized || isIP(normalized) === 0) return false;
  try {
    // ipaddr.process normalizes IPv4-mapped IPv6 before classifying the full
    // IANA special-purpose range set. Only globally routable unicast is valid.
    return ipaddr.process(normalized).range() === "unicast";
  } catch {
    return false;
  }
}

function requestPinned(url: URL, address: string, family: 4 | 6): Promise<PinnedResponse> {
  return new Promise((resolveRequest, reject) => {
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers: {
          host: url.host,
          "user-agent": "Axiomux/0.1 source-ingest",
          accept: "text/*,application/json,application/xml;q=0.9",
          "accept-encoding": "identity",
        },
        lookup: (_hostname, _options, callback) => callback(null, address, family),
        ...(url.protocol === "https:" ? { servername: url.hostname.replace(/^\[|\]$/g, "") } : {}),
      },
      (response) => {
        void readPinnedBody(response, MAX_SOURCE_BYTES).then(
          (body) => resolveRequest({ status: response.statusCode ?? 0, headers: response.headers, body }),
          reject,
        );
      },
    );
    request.setTimeout(30_000, () => request.destroy(new Error("Source request timed out")));
    request.once("error", reject);
    request.end();
  });
}

async function readPinnedBody(response: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(headerValue(response.headers, "content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    response.destroy();
    throw new Error(`Source response exceeds ${limit} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      response.destroy();
      throw new Error(`Source response exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}
