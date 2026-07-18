import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, normalize, parse, relative, resolve } from "node:path";
import { writePrivateFileAtomic } from "../security/state.js";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_WEB_ORIGIN = "https://github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "Axiomux-Upstream-Radar/0.1";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_UPSTREAMS = 64;
const MAX_CHANGED_FILES = 300;
const MAX_COMPARE_COMMITS = 250;

export type UpstreamStrategy = "branch" | "release";
export type ReviewStatus = "pending" | "reviewed" | "dismissed";
export type UpstreamCheckStatus = "up_to_date" | "pending" | "no_relevant_changes" | "baseline_missing" | "too_large" | "error";

export interface UpstreamLicense {
  spdx: string;
  codeReuseAllowed: boolean;
}

export interface UpstreamBaseline {
  kind: "commit" | "tag";
  ref: string;
  release?: string;
  evidence: string;
}

export interface UpstreamDefinition {
  id: string;
  owner: string;
  repo: string;
  strategy: UpstreamStrategy;
  ref?: string;
  role: string;
  license: UpstreamLicense;
  baseline: UpstreamBaseline | null;
  observedLocalVersion?: string;
  monitorIncludes: string[];
  monitorExcludes: string[];
  topics: string[];
}

export interface UpstreamConfig {
  schemaVersion: 1;
  upstreams: UpstreamDefinition[];
}

export interface UpstreamTarget {
  ref: string;
  sha: string;
  url?: string;
  publishedAt?: string;
}

export interface UpstreamCompareMetadata {
  status: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  url?: string;
}

export interface UpstreamChangedFile {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  previousFilename?: string;
}

export interface UpstreamRelevantCommit {
  sha: string;
  message: string;
  url?: string;
  authoredAt?: string;
}

export interface UpstreamCheckRecord {
  id: string;
  checkedAt: string;
  repositoryUrl: string;
  strategy: UpstreamStrategy;
  baselineRef?: string;
  target?: UpstreamTarget;
  compare?: UpstreamCompareMetadata;
  checkStatus: UpstreamCheckStatus;
  reviewStatus: ReviewStatus;
  reviewedAt?: string;
  reviewNote?: string;
  relevantFiles: UpstreamChangedFile[];
  relevantCommits: UpstreamRelevantCommit[];
  error?: string;
}

export interface UpstreamListItem {
  definition: UpstreamDefinition;
  lastCheck?: UpstreamCheckRecord;
}

interface PersistedUpstreamState {
  schemaVersion: 1;
  updatedAt: string;
  upstreams: Record<string, UpstreamCheckRecord>;
}

export type UpstreamFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface UpstreamManagerOptions {
  projectRoot?: string;
  config?: UpstreamConfig;
  fetch?: UpstreamFetch;
  timeoutMs?: number;
  now?: () => Date;
}

class ResponseTooLargeError extends Error {}

interface GitTreeEntryMetadata {
  path: string;
  type: string;
  sha: string;
}

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new Error(`${context} contains an unsupported field: ${key}`);
  }
}

function boundedString(value: unknown, context: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new Error(`${context} must be a string between ${minimum} and ${maximum} characters`);
  }
  return value;
}

function boundedText(value: unknown, context: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new Error(`${context} must be text no longer than ${maximum} characters`);
  }
  return value;
}

function optionalBoundedString(value: unknown, context: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, context, maximum);
}

function nonNegativeInteger(value: unknown, context: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${context} must be a non-negative safe integer`);
  }
  return value as number;
}

function validateOwner(value: unknown, context: string): string {
  const owner = boundedString(value, context, 39);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner)) {
    throw new Error(`${context} is not a valid GitHub owner`);
  }
  return owner;
}

function validateRepo(value: unknown, context: string): string {
  const repo = boundedString(value, context, 100);
  if (!/^[A-Za-z0-9_.-]+$/u.test(repo) || repo === "." || repo === ".." || repo.startsWith("-") || repo.endsWith(".")) {
    throw new Error(`${context} is not a valid GitHub repository name`);
  }
  return repo;
}

function validateRef(value: unknown, context: string): string {
  const ref = boundedString(value, context, 200);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.split("/").some((part) => part === "." || part === ".." || part.endsWith(".lock"))
  ) {
    throw new Error(`${context} is not a safe GitHub ref`);
  }
  return ref;
}

function validateSha(value: unknown, context: string): string {
  const sha = boundedString(value, context, 40, 40).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error(`${context} must be a full 40-character commit SHA`);
  return sha;
}

function validateId(value: unknown, context: string): string {
  const id = boundedString(value, context, 64);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) throw new Error(`${context} is not a safe upstream id`);
  return id;
}

function validatePattern(value: unknown, context: string): string {
  const pattern = boundedString(value, context, 240);
  if (
    isAbsolute(pattern) ||
    pattern.startsWith("/") ||
    pattern.includes("\\") ||
    pattern.split("/").some((part) => part === "." || part === "..") ||
    !/^[A-Za-z0-9._/*?-]+$/u.test(pattern)
  ) {
    throw new Error(`${context} is not a safe repository-relative glob`);
  }
  return pattern;
}

function validateStringArray(
  value: unknown,
  context: string,
  itemValidator: (item: unknown, itemContext: string) => string,
  maximum: number,
  allowEmpty: boolean,
): string[] {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) {
    throw new Error(`${context} must contain ${allowEmpty ? "zero or more" : "one or more"} items (maximum ${maximum})`);
  }
  const result = value.map((item, index) => itemValidator(item, `${context}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${context} must not contain duplicates`);
  return result;
}

function validateIsoDate(value: unknown, context: string): string {
  const raw = boundedString(value, context, 64);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new Error(`${context} must be an ISO date`);
  return date.toISOString();
}

function parseDefinition(value: unknown, index: number): UpstreamDefinition {
  const context = `upstreams[${index}]`;
  const item = objectValue(value, context);
  assertOnlyKeys(
    item,
    ["id", "owner", "repo", "strategy", "ref", "role", "license", "baseline", "observedLocalVersion", "monitorIncludes", "monitorExcludes", "topics"],
    context,
  );

  const id = validateId(item.id, `${context}.id`);
  const owner = validateOwner(item.owner, `${context}.owner`);
  const repo = validateRepo(item.repo, `${context}.repo`);
  if (item.strategy !== "branch" && item.strategy !== "release") {
    throw new Error(`${context}.strategy must be branch or release`);
  }
  const ref = item.ref === undefined ? undefined : validateRef(item.ref, `${context}.ref`);
  const role = boundedString(item.role, `${context}.role`, 800);

  const licenseValue = objectValue(item.license, `${context}.license`);
  assertOnlyKeys(licenseValue, ["spdx", "codeReuseAllowed"], `${context}.license`);
  const spdx = boundedString(licenseValue.spdx, `${context}.license.spdx`, 100);
  if (typeof licenseValue.codeReuseAllowed !== "boolean") {
    throw new Error(`${context}.license.codeReuseAllowed must be boolean`);
  }
  const license: UpstreamLicense = { spdx, codeReuseAllowed: licenseValue.codeReuseAllowed };

  let baseline: UpstreamBaseline | null;
  if (item.baseline === null) {
    baseline = null;
  } else {
    const baselineValue = objectValue(item.baseline, `${context}.baseline`);
    assertOnlyKeys(baselineValue, ["kind", "ref", "release", "evidence"], `${context}.baseline`);
    if (baselineValue.kind !== "commit" && baselineValue.kind !== "tag") {
      throw new Error(`${context}.baseline.kind must be commit or tag`);
    }
    const baselineRef =
      baselineValue.kind === "commit" ? validateSha(baselineValue.ref, `${context}.baseline.ref`) : validateRef(baselineValue.ref, `${context}.baseline.ref`);
    const release = optionalBoundedString(baselineValue.release, `${context}.baseline.release`, 100);
    const evidence = boundedString(baselineValue.evidence, `${context}.baseline.evidence`, 500);
    baseline =
      release === undefined ? { kind: baselineValue.kind, ref: baselineRef, evidence } : { kind: baselineValue.kind, ref: baselineRef, release, evidence };
  }

  const observedLocalVersion = optionalBoundedString(item.observedLocalVersion, `${context}.observedLocalVersion`, 100);
  const monitorIncludes = validateStringArray(item.monitorIncludes, `${context}.monitorIncludes`, validatePattern, 100, false);
  const monitorExcludes = validateStringArray(item.monitorExcludes, `${context}.monitorExcludes`, validatePattern, 100, true);
  const topics = validateStringArray(item.topics, `${context}.topics`, (topic, topicContext) => boundedString(topic, topicContext, 80), 50, true);

  const definition: UpstreamDefinition = {
    id,
    owner,
    repo,
    strategy: item.strategy,
    role,
    license,
    baseline,
    monitorIncludes,
    monitorExcludes,
    topics,
  };
  if (ref !== undefined) definition.ref = ref;
  if (observedLocalVersion !== undefined) definition.observedLocalVersion = observedLocalVersion;
  return definition;
}

export function validateUpstreamConfig(value: unknown): UpstreamConfig {
  const config = objectValue(value, "upstream config");
  assertOnlyKeys(config, ["schemaVersion", "upstreams"], "upstream config");
  if (config.schemaVersion !== 1) throw new Error("upstream config schemaVersion must be 1");
  if (!Array.isArray(config.upstreams) || config.upstreams.length === 0 || config.upstreams.length > MAX_UPSTREAMS) {
    throw new Error(`upstream config must contain between 1 and ${MAX_UPSTREAMS} upstreams`);
  }
  const upstreams = config.upstreams.map(parseDefinition);
  const ids = upstreams.map((upstream) => upstream.id);
  if (new Set(ids).size !== ids.length) throw new Error("upstream ids must be unique");
  return { schemaVersion: 1, upstreams };
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

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readRegularFileBounded(path: string, maximumBytes: number, context: string, missingAllowed: boolean): string | undefined {
  const absolute = resolve(path);
  let descriptor: number | undefined;
  try {
    const before = lstatSync(absolute);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new Error(`${context} must be a regular file without symbolic or hard links`);
    }
    if (before.size > maximumBytes) throw new Error(`${context} exceeds the ${maximumBytes}-byte limit`);
    if (comparisonPath(realpathSync.native(absolute)) !== comparisonPath(absolute)) {
      throw new Error(`${context} resolves through a symbolic link, junction or reparse point`);
    }

    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    descriptor = openSync(absolute, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) {
      throw new Error(`${context} changed while it was opened`);
    }
    if (opened.size > maximumBytes) throw new Error(`${context} exceeds the ${maximumBytes}-byte limit`);

    const chunks: Buffer[] = [];
    let received = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - received));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      received += count;
      if (received > maximumBytes) throw new Error(`${context} exceeds the ${maximumBytes}-byte limit`);
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.nlink !== 1 || !sameFile(opened, after)) {
      throw new Error(`${context} changed while it was read`);
    }
    return Buffer.concat(chunks, received).toString("utf8");
  } catch (error) {
    if (missingAllowed && isMissing(error)) return undefined;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${context} is not valid JSON`);
  }
}

function repositoryUrl(definition: UpstreamDefinition): string {
  return `${GITHUB_WEB_ORIGIN}/${definition.owner}/${definition.repo}`;
}

function validateGithubWebUrl(value: unknown, definition: UpstreamDefinition, context: string): string {
  const raw = boundedString(value, context, 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${context} is not a valid URL`);
  }
  const prefix = `/${definition.owner.toLowerCase()}/${definition.repo.toLowerCase()}`;
  const path = url.pathname.toLowerCase();
  if (url.origin !== GITHUB_WEB_ORIGIN || (path !== prefix && !path.startsWith(`${prefix}/`))) {
    throw new Error(`${context} is not a URL for the configured public GitHub repository`);
  }
  return url.toString();
}

function optionalGithubWebUrl(value: unknown, definition: UpstreamDefinition, context: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return validateGithubWebUrl(value, definition, context);
}

function validateRepositoryPath(value: unknown, context: string): string {
  const path = boundedString(value, context, 1_024).replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("//") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${context} is not a safe repository-relative path`);
  }
  return path;
}

function regexEscape(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

export function matchesUpstreamPattern(path: string, pattern: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += regexEscape(character);
    }
  }
  expression += "$";
  return new RegExp(expression, "u").test(normalized);
}

function monitoredPath(definition: UpstreamDefinition, filename: string): boolean {
  return (
    definition.monitorIncludes.some((pattern) => matchesUpstreamPattern(filename, pattern)) &&
    !definition.monitorExcludes.some((pattern) => matchesUpstreamPattern(filename, pattern))
  );
}

function commitTitle(message: string): string {
  return (message.split(/\r?\n/u, 1)[0] ?? "").trim().slice(0, 500);
}

function topicMatches(definition: UpstreamDefinition, message: string): boolean {
  const lower = message.toLocaleLowerCase("en-US");
  return definition.topics.some((topic) => lower.includes(topic.toLocaleLowerCase("en-US")));
}

function parseTargetCommit(value: unknown, definition: UpstreamDefinition, context: string): UpstreamRelevantCommit {
  const commit = objectValue(value, context);
  const sha = validateSha(commit.sha, `${context}.sha`);
  const details = objectValue(commit.commit, `${context}.commit`);
  const message = commitTitle(boundedText(details.message, `${context}.commit.message`, 100_000));
  const url = optionalGithubWebUrl(commit.html_url, definition, `${context}.html_url`);
  let authoredAt: string | undefined;
  if (details.author !== undefined && details.author !== null) {
    const author = objectValue(details.author, `${context}.commit.author`);
    if (author.date !== undefined && author.date !== null) {
      authoredAt = validateIsoDate(author.date, `${context}.commit.author.date`);
    }
  }
  const parsed: UpstreamRelevantCommit = { sha, message };
  if (url !== undefined) parsed.url = url;
  if (authoredAt !== undefined) parsed.authoredAt = authoredAt;
  return parsed;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function reviewFields(
  existing: UpstreamCheckRecord | undefined,
  targetSha: string | undefined,
): Pick<UpstreamCheckRecord, "reviewStatus" | "reviewedAt" | "reviewNote"> {
  const sameTarget = targetSha === undefined || existing?.target?.sha === targetSha;
  if (!existing || !sameTarget) return { reviewStatus: "pending" };
  const fields: Pick<UpstreamCheckRecord, "reviewStatus" | "reviewedAt" | "reviewNote"> = {
    reviewStatus: existing.reviewStatus,
  };
  if (existing.reviewedAt !== undefined) fields.reviewedAt = existing.reviewedAt;
  if (existing.reviewNote !== undefined) fields.reviewNote = existing.reviewNote;
  return fields;
}

function parseStoredTarget(value: unknown, definition: UpstreamDefinition, context: string): UpstreamTarget {
  const target = objectValue(value, context);
  assertOnlyKeys(target, ["ref", "sha", "url", "publishedAt"], context);
  const parsed: UpstreamTarget = {
    ref: validateRef(target.ref, `${context}.ref`),
    sha: validateSha(target.sha, `${context}.sha`),
  };
  const url = optionalGithubWebUrl(target.url, definition, `${context}.url`);
  if (url !== undefined) parsed.url = url;
  if (target.publishedAt !== undefined) parsed.publishedAt = validateIsoDate(target.publishedAt, `${context}.publishedAt`);
  return parsed;
}

function parseStoredCompare(value: unknown, definition: UpstreamDefinition, context: string): UpstreamCompareMetadata {
  const compare = objectValue(value, context);
  assertOnlyKeys(compare, ["status", "aheadBy", "behindBy", "totalCommits", "url"], context);
  const parsed: UpstreamCompareMetadata = {
    status: boundedString(compare.status, `${context}.status`, 30),
    aheadBy: nonNegativeInteger(compare.aheadBy, `${context}.aheadBy`),
    behindBy: nonNegativeInteger(compare.behindBy, `${context}.behindBy`),
    totalCommits: nonNegativeInteger(compare.totalCommits, `${context}.totalCommits`),
  };
  const url = optionalGithubWebUrl(compare.url, definition, `${context}.url`);
  if (url !== undefined) parsed.url = url;
  return parsed;
}

function parseStoredRecord(value: unknown, definition: UpstreamDefinition, context: string): UpstreamCheckRecord {
  const record = objectValue(value, context);
  assertOnlyKeys(
    record,
    [
      "id",
      "checkedAt",
      "repositoryUrl",
      "strategy",
      "baselineRef",
      "target",
      "compare",
      "checkStatus",
      "reviewStatus",
      "reviewedAt",
      "reviewNote",
      "relevantFiles",
      "relevantCommits",
      "error",
    ],
    context,
  );
  if (record.id !== definition.id || record.repositoryUrl !== repositoryUrl(definition) || record.strategy !== definition.strategy) {
    throw new Error(`${context} does not match its configured upstream`);
  }
  const allowedCheckStatuses: readonly unknown[] = ["up_to_date", "pending", "no_relevant_changes", "baseline_missing", "too_large", "error"];
  if (!allowedCheckStatuses.includes(record.checkStatus)) throw new Error(`${context}.checkStatus is invalid`);
  if (record.reviewStatus !== "pending" && record.reviewStatus !== "reviewed" && record.reviewStatus !== "dismissed") {
    throw new Error(`${context}.reviewStatus is invalid`);
  }
  if (!Array.isArray(record.relevantFiles) || record.relevantFiles.length > MAX_CHANGED_FILES) {
    throw new Error(`${context}.relevantFiles is invalid`);
  }
  if (!Array.isArray(record.relevantCommits) || record.relevantCommits.length > MAX_COMPARE_COMMITS) {
    throw new Error(`${context}.relevantCommits is invalid`);
  }
  const relevantFiles = record.relevantFiles.map((file, index) => {
    const stored = objectValue(file, `${context}.relevantFiles[${index}]`);
    assertOnlyKeys(stored, ["filename", "status", "additions", "deletions", "changes", "previousFilename"], `${context}.relevantFiles[${index}]`);
    const parsed: UpstreamChangedFile = {
      filename: validateRepositoryPath(stored.filename, `${context}.relevantFiles[${index}].filename`),
      status: boundedString(stored.status, `${context}.relevantFiles[${index}].status`, 30),
    };
    if (stored.additions !== undefined) parsed.additions = nonNegativeInteger(stored.additions, `${context}.relevantFiles[${index}].additions`);
    if (stored.deletions !== undefined) parsed.deletions = nonNegativeInteger(stored.deletions, `${context}.relevantFiles[${index}].deletions`);
    if (stored.changes !== undefined) parsed.changes = nonNegativeInteger(stored.changes, `${context}.relevantFiles[${index}].changes`);
    if (stored.previousFilename !== undefined) {
      parsed.previousFilename = validateRepositoryPath(stored.previousFilename, `${context}.relevantFiles[${index}].previousFilename`);
    }
    return parsed;
  });
  const relevantCommits = record.relevantCommits.map((commit, index) => {
    const stored = objectValue(commit, `${context}.relevantCommits[${index}]`);
    assertOnlyKeys(stored, ["sha", "message", "url", "authoredAt"], `${context}.relevantCommits[${index}]`);
    const parsed: UpstreamRelevantCommit = {
      sha: validateSha(stored.sha, `${context}.relevantCommits[${index}].sha`),
      message: boundedString(stored.message, `${context}.relevantCommits[${index}].message`, 500, 0),
    };
    const url = optionalGithubWebUrl(stored.url, definition, `${context}.relevantCommits[${index}].url`);
    if (url !== undefined) parsed.url = url;
    if (stored.authoredAt !== undefined) {
      parsed.authoredAt = validateIsoDate(stored.authoredAt, `${context}.relevantCommits[${index}].authoredAt`);
    }
    return parsed;
  });

  const parsed: UpstreamCheckRecord = {
    id: definition.id,
    checkedAt: validateIsoDate(record.checkedAt, `${context}.checkedAt`),
    repositoryUrl: repositoryUrl(definition),
    strategy: definition.strategy,
    checkStatus: record.checkStatus as UpstreamCheckStatus,
    reviewStatus: record.reviewStatus,
    relevantFiles,
    relevantCommits,
  };
  if (record.baselineRef !== undefined) {
    // Stored radar state is private, branch-local cache data. Parse it as a
    // bounded ref first; parseState decides whether it still belongs to the
    // version-controlled baseline that is currently checked out.
    parsed.baselineRef = validateRef(record.baselineRef, `${context}.baselineRef`);
  }
  if (record.target !== undefined) parsed.target = parseStoredTarget(record.target, definition, `${context}.target`);
  if (record.compare !== undefined) parsed.compare = parseStoredCompare(record.compare, definition, `${context}.compare`);
  if (record.reviewedAt !== undefined) parsed.reviewedAt = validateIsoDate(record.reviewedAt, `${context}.reviewedAt`);
  if (record.reviewNote !== undefined) parsed.reviewNote = boundedString(record.reviewNote, `${context}.reviewNote`, 1_000);
  if (record.error !== undefined) parsed.error = boundedString(record.error, `${context}.error`, 500);
  return parsed;
}

function parseState(value: unknown, definitions: Map<string, UpstreamDefinition>): PersistedUpstreamState {
  const state = objectValue(value, "upstream state");
  assertOnlyKeys(state, ["schemaVersion", "updatedAt", "upstreams"], "upstream state");
  if (state.schemaVersion !== 1) throw new Error("upstream state schemaVersion must be 1");
  const records = objectValue(state.upstreams, "upstream state.upstreams");
  const parsed: Record<string, UpstreamCheckRecord> = {};
  for (const [id, value] of Object.entries(records)) {
    const definition = definitions.get(id);
    if (!definition) throw new Error(`upstream state contains an unknown upstream: ${id}`);
    const record = parseStoredRecord(value, definition, `upstream state.upstreams.${id}`);
    // A reviewed baseline advance is committed in config/upstreams.json. The
    // ignored state file can legitimately lag after switching branches or
    // pulling that commit; never attach an old comparison to the new baseline.
    // It is discarded from the active view and replaced by the next check.
    if (record.baselineRef !== undefined && record.baselineRef !== definition.baseline?.ref) continue;
    parsed[id] = record;
  }
  return {
    schemaVersion: 1,
    updatedAt: validateIsoDate(state.updatedAt, "upstream state.updatedAt"),
    upstreams: parsed,
  };
}

function nowIso(now: () => Date): string {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("UpstreamManager now() returned an invalid date");
  return date.toISOString();
}

export class UpstreamManager {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly config: UpstreamConfig;

  private readonly definitions: Map<string, UpstreamDefinition>;
  private readonly fetchImplementation: UpstreamFetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private state: PersistedUpstreamState;

  constructor(options: UpstreamManagerOptions = {}) {
    const requestedRoot = resolve(options.projectRoot ?? process.cwd());
    const root = realpathSync.native(requestedRoot);
    if (comparisonPath(root) !== comparisonPath(requestedRoot)) {
      throw new Error("Project root must not resolve through a symbolic link, junction or reparse point");
    }
    this.projectRoot = root;
    this.configPath = join(root, "config", "upstreams.json");
    this.statePath = join(root, ".superai", "upstream-radar.json");
    const stateRelative = relative(root, this.statePath);
    if (stateRelative.startsWith("..") || isAbsolute(stateRelative)) throw new Error("Upstream state path escaped the project root");

    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 60_000)) {
      throw new Error("Upstream timeout must be an integer between 1000 and 60000 milliseconds");
    }
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImplementation !== "function") throw new Error("A fetch implementation is required");
    this.now = options.now ?? (() => new Date());

    if (options.config === undefined) {
      const text = readRegularFileBounded(this.configPath, MAX_CONFIG_BYTES, "upstream config", false);
      if (text === undefined) throw new Error("upstream config does not exist");
      this.config = validateUpstreamConfig(parseJson(text, "upstream config"));
    } else {
      this.config = validateUpstreamConfig(options.config);
    }
    this.definitions = new Map(this.config.upstreams.map((definition) => [definition.id, definition]));

    const stateText = readRegularFileBounded(this.statePath, MAX_STATE_BYTES, "upstream state", true);
    this.state =
      stateText === undefined
        ? { schemaVersion: 1, updatedAt: nowIso(this.now), upstreams: {} }
        : parseState(parseJson(stateText, "upstream state"), this.definitions);
  }

  list(): UpstreamListItem[] {
    return this.config.upstreams.map((definition) => {
      const lastCheck = this.state.upstreams[definition.id];
      const item: UpstreamListItem = { definition: clone(definition) };
      if (lastCheck !== undefined) item.lastCheck = clone(lastCheck);
      return item;
    });
  }

  show(id: string): UpstreamListItem {
    const definition = this.requireDefinition(id);
    const record = this.state.upstreams[id];
    const result: UpstreamListItem = { definition: clone(definition) };
    if (record !== undefined) result.lastCheck = clone(record);
    return result;
  }

  async check(id?: string): Promise<UpstreamCheckRecord[]> {
    const definitions = id === undefined ? this.config.upstreams : [this.requireDefinition(id)];
    const results: UpstreamCheckRecord[] = [];
    for (const definition of definitions) {
      const record = await this.checkOne(definition);
      const next: PersistedUpstreamState = {
        schemaVersion: 1,
        updatedAt: record.checkedAt,
        upstreams: { ...this.state.upstreams, [definition.id]: record },
      };
      this.persist(next);
      this.state = next;
      results.push(clone(record));
    }
    return results;
  }

  mark(id: string, status: ReviewStatus, note?: string): UpstreamCheckRecord {
    const definition = this.requireDefinition(id);
    if (status !== "pending" && status !== "reviewed" && status !== "dismissed") {
      throw new Error("Review status must be pending, reviewed or dismissed");
    }
    const existing = this.state.upstreams[id];
    if (!existing) throw new Error(`No upstream check exists for ${id}`);
    const normalizedNote = note === undefined ? undefined : boundedString(note.trim(), "review note", 1_000);
    const checkedAt = nowIso(this.now);
    const record: UpstreamCheckRecord = {
      ...existing,
      reviewStatus: status,
    };
    delete record.reviewedAt;
    delete record.reviewNote;
    if (status !== "pending") record.reviewedAt = checkedAt;
    if (normalizedNote !== undefined) record.reviewNote = normalizedNote;

    const next: PersistedUpstreamState = {
      schemaVersion: 1,
      updatedAt: checkedAt,
      upstreams: { ...this.state.upstreams, [definition.id]: record },
    };
    this.persist(next);
    this.state = next;
    return clone(record);
  }

  private requireDefinition(id: string): UpstreamDefinition {
    const safeId = validateId(id, "upstream id");
    const definition = this.definitions.get(safeId);
    if (!definition) throw new Error(`Unknown upstream: ${safeId}`);
    return definition;
  }

  private persist(state: PersistedUpstreamState): void {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw new Error(`Upstream state exceeds the ${MAX_STATE_BYTES}-byte persistence limit`);
    }
    writePrivateFileAtomic(this.statePath, serialized);
  }

  private async checkOne(definition: UpstreamDefinition): Promise<UpstreamCheckRecord> {
    const checkedAt = nowIso(this.now);
    const existing = this.state.upstreams[definition.id];
    let resolvedTarget: UpstreamTarget | undefined;
    try {
      const target = await this.resolveTarget(definition);
      resolvedTarget = target;
      const common = {
        id: definition.id,
        checkedAt,
        repositoryUrl: repositoryUrl(definition),
        strategy: definition.strategy,
        target,
        relevantFiles: [] as UpstreamChangedFile[],
        relevantCommits: [] as UpstreamRelevantCommit[],
        ...reviewFields(existing, target.sha),
      };
      if (definition.baseline === null) {
        return { ...common, checkStatus: "baseline_missing" };
      }
      const baselineSha = await this.resolveBaselineSha(definition);
      if (baselineSha === target.sha) {
        return { ...common, baselineRef: definition.baseline.ref, checkStatus: "up_to_date" };
      }

      const commits = await this.commitsSince(definition, baselineSha, target.sha);
      const baseTree = await this.loadTree(definition, baselineSha);
      const targetTree = await this.loadTree(definition, target.sha);
      const relevantFiles = this.diffMonitoredTrees(definition, baseTree, targetTree);
      const relevantCommits = commits.filter((commit) => topicMatches(definition, commit.message));
      const compareMetadata: UpstreamCompareMetadata = {
        status: "ahead",
        aheadBy: commits.length,
        behindBy: 0,
        totalCommits: commits.length,
        url: `${repositoryUrl(definition)}/compare/${baselineSha}...${target.sha}`,
      };
      const relevant = relevantFiles.length > 0 || relevantCommits.length > 0;
      return {
        ...common,
        baselineRef: definition.baseline.ref,
        compare: compareMetadata,
        relevantFiles,
        relevantCommits,
        checkStatus: relevant ? "pending" : "no_relevant_changes",
      };
    } catch (error) {
      const tooLarge = error instanceof ResponseTooLargeError;
      return {
        id: definition.id,
        checkedAt,
        repositoryUrl: repositoryUrl(definition),
        strategy: definition.strategy,
        ...(definition.baseline === null ? {} : { baselineRef: definition.baseline.ref }),
        ...(resolvedTarget === undefined ? {} : { target: resolvedTarget }),
        checkStatus: tooLarge ? "too_large" : "error",
        ...reviewFields(existing, resolvedTarget?.sha),
        relevantFiles: [],
        relevantCommits: [],
        error: tooLarge
          ? "Comparison was not processed because GitHub returned a truncated or oversized result."
          : error instanceof Error && error.message.startsWith("GitHub ")
            ? error.message.slice(0, 500)
            : "Upstream check failed validation.",
      };
    }
  }

  private async resolveBaselineSha(definition: UpstreamDefinition): Promise<string> {
    const baseline = definition.baseline;
    if (baseline === null) throw new Error("Upstream baseline is missing");
    if (baseline.kind === "commit") return baseline.ref;
    const repositoryPath = `/repos/${encodeURIComponent(definition.owner)}/${encodeURIComponent(definition.repo)}`;
    const commitValue = await this.requestJson(definition, `${repositoryPath}/commits/${encodeURIComponent(baseline.ref)}`);
    return parseTargetCommit(commitValue, definition, `${definition.id} baseline commit`).sha;
  }

  private async commitsSince(definition: UpstreamDefinition, baselineSha: string, targetSha: string): Promise<UpstreamRelevantCommit[]> {
    const repositoryPath = `/repos/${encodeURIComponent(definition.owner)}/${encodeURIComponent(definition.repo)}`;
    const commits: UpstreamRelevantCommit[] = [];
    const seen = new Set<string>();
    const pages = [
      { perPage: 100, page: 1 },
      { perPage: 100, page: 2 },
      { perPage: 50, page: 5 },
    ] as const;
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex];
      if (page === undefined) throw new Error("GitHub commit pagination failed validation");
      const value = await this.requestJson(
        definition,
        `${repositoryPath}/commits?sha=${encodeURIComponent(targetSha)}&per_page=${page.perPage}&page=${page.page}`,
      );
      if (!Array.isArray(value) || value.length > page.perPage) throw new Error("GitHub commit history response was malformed");
      for (let index = 0; index < value.length; index += 1) {
        const commit = parseTargetCommit(value[index], definition, `${definition.id} history[${commits.length}]`);
        if (pageIndex === 0 && index === 0 && commit.sha !== targetSha) {
          throw new Error("GitHub commit history did not start at the requested target");
        }
        if (commit.sha === baselineSha) return commits;
        if (seen.has(commit.sha)) throw new Error("GitHub commit history contained a duplicate commit");
        seen.add(commit.sha);
        commits.push(commit);
      }
      if (value.length < page.perPage) {
        throw new Error("GitHub commit history did not contain the audited baseline; upstream history may have diverged");
      }
    }
    throw new ResponseTooLargeError(`GitHub commit history exceeded the ${MAX_COMPARE_COMMITS}-commit comparison limit`);
  }

  private async loadTree(definition: UpstreamDefinition, commitSha: string): Promise<Map<string, GitTreeEntryMetadata>> {
    const repositoryPath = `/repos/${encodeURIComponent(definition.owner)}/${encodeURIComponent(definition.repo)}`;
    const commitValue = await this.requestJson(definition, `${repositoryPath}/git/commits/${encodeURIComponent(commitSha)}`);
    const commit = objectValue(commitValue, `${definition.id} git commit`);
    if (validateSha(commit.sha, `${definition.id} git commit.sha`) !== commitSha) {
      throw new Error("GitHub git commit response did not match the requested commit");
    }
    const treeReference = objectValue(commit.tree, `${definition.id} git commit.tree`);
    const treeSha = validateSha(treeReference.sha, `${definition.id} git commit.tree.sha`);
    const treeValue = await this.requestJson(definition, `${repositoryPath}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
    const tree = objectValue(treeValue, `${definition.id} git tree`);
    if (tree.truncated !== false) {
      if (tree.truncated === true) throw new ResponseTooLargeError("GitHub returned a truncated repository tree");
      throw new Error("GitHub git tree response did not declare truncation status");
    }
    if (!Array.isArray(tree.tree) || tree.tree.length > 100_000) {
      throw new ResponseTooLargeError("GitHub repository tree exceeded the entry limit");
    }
    const entries = new Map<string, GitTreeEntryMetadata>();
    const seenPaths = new Set<string>();
    for (let index = 0; index < tree.tree.length; index += 1) {
      const rawEntry = objectValue(tree.tree[index], `${definition.id} git tree[${index}]`);
      const path = validateRepositoryPath(rawEntry.path, `${definition.id} git tree[${index}].path`);
      if (seenPaths.has(path)) throw new Error("GitHub repository tree contained duplicate paths");
      seenPaths.add(path);
      const type = boundedString(rawEntry.type, `${definition.id} git tree[${index}].type`, 20);
      if (type !== "blob" && type !== "tree" && type !== "commit") {
        throw new Error("GitHub repository tree contained an unknown entry type");
      }
      if (type !== "tree") {
        entries.set(path, {
          path,
          type,
          sha: validateSha(rawEntry.sha, `${definition.id} git tree[${index}].sha`),
        });
      }
    }
    return entries;
  }

  private diffMonitoredTrees(
    definition: UpstreamDefinition,
    baseline: Map<string, GitTreeEntryMetadata>,
    target: Map<string, GitTreeEntryMetadata>,
  ): UpstreamChangedFile[] {
    const changed: UpstreamChangedFile[] = [];
    for (const [path, before] of baseline) {
      const after = target.get(path);
      if (after === undefined) {
        if (monitoredPath(definition, path)) changed.push({ filename: path, status: "removed" });
      } else if ((before.sha !== after.sha || before.type !== after.type) && monitoredPath(definition, path)) {
        changed.push({ filename: path, status: "modified" });
      }
    }
    for (const path of target.keys()) {
      if (!baseline.has(path) && monitoredPath(definition, path)) changed.push({ filename: path, status: "added" });
    }
    if (changed.length >= MAX_CHANGED_FILES) {
      throw new ResponseTooLargeError(`GitHub tree comparison reached the ${MAX_CHANGED_FILES}-file review limit`);
    }
    return changed.sort((left, right) => left.filename.localeCompare(right.filename, "en"));
  }

  private async resolveTarget(definition: UpstreamDefinition): Promise<UpstreamTarget> {
    const repositoryPath = `/repos/${encodeURIComponent(definition.owner)}/${encodeURIComponent(definition.repo)}`;
    if (definition.strategy === "release") {
      const releaseValue = await this.requestJson(definition, `${repositoryPath}/releases/latest`);
      const release = objectValue(releaseValue, `${definition.id} latest release`);
      const ref = validateRef(release.tag_name, `${definition.id} latest release tag`);
      const commitValue = await this.requestJson(definition, `${repositoryPath}/commits/${encodeURIComponent(ref)}`);
      const commit = parseTargetCommit(commitValue, definition, `${definition.id} release commit`);
      const target: UpstreamTarget = { ref, sha: commit.sha };
      const url = optionalGithubWebUrl(release.html_url, definition, `${definition.id} latest release.html_url`) ?? commit.url;
      if (url !== undefined) target.url = url;
      if (release.published_at !== undefined && release.published_at !== null) {
        target.publishedAt = validateIsoDate(release.published_at, `${definition.id} latest release.published_at`);
      }
      return target;
    }

    let ref = definition.ref;
    if (ref === undefined) {
      const repositoryValue = await this.requestJson(definition, repositoryPath);
      const repository = objectValue(repositoryValue, `${definition.id} repository`);
      ref = validateRef(repository.default_branch, `${definition.id} default branch`);
    }
    const commitValue = await this.requestJson(definition, `${repositoryPath}/commits/${encodeURIComponent(ref)}`);
    const commit = parseTargetCommit(commitValue, definition, `${definition.id} branch commit`);
    const target: UpstreamTarget = { ref, sha: commit.sha };
    if (commit.url !== undefined) target.url = commit.url;
    if (commit.authoredAt !== undefined) target.publishedAt = commit.authoredAt;
    return target;
  }

  private async requestJson(definition: UpstreamDefinition, path: string): Promise<unknown> {
    if (!path.startsWith("/repos/") || path.includes("\\") || /[\0\r\n]/u.test(path)) {
      throw new Error("GitHub request path failed validation");
    }
    const url = new URL(path, GITHUB_API_ORIGIN);
    if (url.origin !== GITHUB_API_ORIGIN || url.username !== "" || url.password !== "") {
      throw new Error("GitHub request escaped the fixed public API host");
    }
    const expectedPrefix = `/repos/${encodeURIComponent(definition.owner)}/${encodeURIComponent(definition.repo)}`.toLowerCase();
    const requestPath = url.pathname.toLowerCase();
    if (requestPath !== expectedPrefix && !requestPath.startsWith(`${expectedPrefix}/`)) {
      throw new Error("GitHub request escaped the configured repository");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": USER_AGENT,
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new Error("GitHub request timed out");
      throw new Error("GitHub request could not be completed");
    }

    try {
      if (response.redirected || response.type === "opaqueredirect") {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("GitHub redirected a request that must remain on the fixed API host");
      }
      if (response.url !== "") {
        let responseUrl: URL;
        try {
          responseUrl = new URL(response.url);
        } catch {
          throw new Error("GitHub response URL was invalid");
        }
        if (responseUrl.href !== url.href) throw new Error("GitHub response came from an unexpected URL");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`GitHub request failed with HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json" && contentType !== "application/vnd.github+json") {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("GitHub response did not use a JSON content type");
      }
      const contentLengthRaw = response.headers.get("content-length");
      if (contentLengthRaw !== null) {
        const contentLength = Number(contentLengthRaw);
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("GitHub response had an invalid Content-Length header");
        }
        if (contentLength > MAX_RESPONSE_BYTES) {
          await response.body?.cancel().catch(() => undefined);
          throw new ResponseTooLargeError("GitHub response exceeded the metadata size limit");
        }
      }
      if (response.body === null) throw new Error("GitHub response did not contain JSON metadata");

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          received += result.value.byteLength;
          if (received > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ResponseTooLargeError("GitHub response exceeded the metadata size limit");
          }
          chunks.push(result.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new Error("GitHub response was not valid UTF-8 JSON");
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error("GitHub request timed out");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
