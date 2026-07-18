import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { securePrivateFile } from "./security/state.js";

const MAX_WORKFLOW_STATE_BYTES = 16 * 1024 * 1024;
const MAX_WORKFLOW_LOCK_BYTES = 4 * 1024;

export type WorkflowStep =
  | { id: string; type: "agent"; prompt: string; retries?: number }
  | { id: string; type: "approval"; prompt: string }
  | { id: string; type: "memory"; content: string; label: string };

export interface WorkflowDefinition {
  id: string;
  title: string;
  steps: WorkflowStep[];
}

export type WorkflowJournalStatus = "started" | "completed" | "failed" | "paused" | "retry_authorized" | "recovered_completed" | "recovered_failed";

export interface WorkflowJournalEntry {
  stepId: string;
  stepType: WorkflowStep["type"];
  attempt: number;
  idempotencyKey: string;
  /** False only when legacy state cannot prove the effect received this key. */
  idempotencyEstablished: boolean;
  status: WorkflowJournalStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface WorkflowState {
  workflowId: string;
  /** Missing only in state written by Axiomux versions predating definition binding. */
  definitionHash?: string;
  status: "running" | "paused" | "completed" | "failed";
  cursor: number;
  attempts: Record<string, number>;
  outputs: Record<string, unknown>;
  /** Missing only in legacy state. New writes always include it. */
  journal?: Record<string, WorkflowJournalEntry[]>;
  error?: string;
  updatedAt: string;
}

export interface WorkflowRuntime {
  /**
   * The key is stable for a definition-bound step. An agent runtime may use it,
   * but the engine still treats a crash during an agent step as an unknown effect.
   */
  runAgent(prompt: string, idempotencyKey: string): Promise<string>;
  requestApproval(prompt: string): Promise<boolean>;
  /** The runtime must deduplicate repeated calls carrying the same key. */
  remember(content: string, label: string, idempotencyKey: string): Promise<number>;
}

export type UnknownStepResolution = { action: "retry" } | { action: "complete"; output: unknown } | { action: "fail"; error: string };

class WorkflowPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowPersistenceError";
  }
}

/** A runtime uses this when a rejected agent call may already have caused effects. */
export class UnknownWorkflowEffectError extends Error {
  constructor(message = "Agent execution ended with an unknown effect", options?: ErrorOptions) {
    super(message, options);
    this.name = "UnknownWorkflowEffectError";
  }
}

interface WorkflowLockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

export class WorkflowEngine {
  constructor(
    private readonly stateDirectory: string,
    private readonly runtime: WorkflowRuntime,
  ) {
    mkdirSync(stateDirectory, { recursive: true });
  }

  load(id: string): WorkflowState | undefined {
    const path = this.path(id);
    if (!existsSync(path)) return undefined;
    let parsed: unknown;
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > MAX_WORKFLOW_STATE_BYTES) {
        throw new Error("state is not a bounded regular file");
      }
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`Workflow state ${id} is not valid JSON`, { cause: error });
    }
    validateState(parsed);
    return parsed;
  }

  /**
   * Explicitly binds progressed legacy state to the supplied definition. This is
   * deliberately never called by run(): only a human/operator may accept that
   * the old state and the current definition describe the same workflow.
   */
  adoptLegacyState(definition: WorkflowDefinition): WorkflowState {
    validateWorkflow(definition);
    const releaseLock = this.acquireLock(definition.id);
    try {
      const state = this.load(definition.id);
      if (!state) throw new Error(`No legacy state exists for workflow ${definition.id}`);
      const definitionHash = hashWorkflowDefinition(definition);
      if (state.definitionHash) {
        assertDefinitionMatches(state, definitionHash);
        assertStateMatchesDefinition(state, definition, definitionHash);
        return state;
      }
      assertCursorMatchesDefinition(state, definition);
      assertStateStepIdsKnown(state, definition);

      state.definitionHash = definitionHash;
      state.journal = state.journal ?? {};
      const legacyTimestamp = state.updatedAt;
      for (let index = 0; index < Math.min(state.cursor, definition.steps.length); index += 1) {
        const step = definition.steps[index];
        if (!step || (state.journal[step.id]?.length ?? 0) > 0) continue;
        state.journal[step.id] = [
          {
            stepId: step.id,
            stepType: step.type,
            attempt: state.attempts[step.id] ?? 0,
            idempotencyKey: stepIdempotencyKey(definition.id, definitionHash, step.id),
            idempotencyEstablished: false,
            status: "completed",
            startedAt: legacyTimestamp,
            finishedAt: legacyTimestamp,
          },
        ];
      }

      const current = definition.steps[state.cursor];
      if (current && ((state.attempts[current.id] ?? 0) > 0 || hasOwn(state.outputs, current.id))) {
        const entries = journalEntries(state, current.id);
        if (entries.length === 0) {
          entries.push({
            stepId: current.id,
            stepType: current.type,
            attempt: Math.max(1, state.attempts[current.id] ?? 0),
            idempotencyKey: stepIdempotencyKey(definition.id, definitionHash, current.id),
            idempotencyEstablished: false,
            status: "started",
            startedAt: legacyTimestamp,
          });
        }
        state.status = "paused";
        state.error = unknownEffectMessage(current.id);
      } else if (state.status !== "completed") {
        state.status = "paused";
        state.error = "Legacy workflow state adopted. Resume explicitly after reviewing the migrated cursor and outputs.";
      }
      this.save(state);
      return state;
    } finally {
      releaseLock();
    }
  }

  /** Resolve an unknown in-flight step after an operator has inspected its effect. */
  resolveUnknownStep(definition: WorkflowDefinition, stepId: string, resolution: UnknownStepResolution): WorkflowState {
    validateWorkflow(definition);
    const releaseLock = this.acquireLock(definition.id);
    try {
      const state = this.load(definition.id);
      if (!state) throw new Error(`No state exists for workflow ${definition.id}`);
      const definitionHash = hashWorkflowDefinition(definition);
      if (!state.definitionHash) {
        throw new Error(`Legacy workflow state ${definition.id} must be adopted before step recovery`);
      }
      assertDefinitionMatches(state, definitionHash);
      assertStateMatchesDefinition(state, definition, definitionHash);
      const step = definition.steps[state.cursor];
      if (!step || step.id !== stepId) {
        throw new Error(`Only the current workflow step may be recovered (expected ${step?.id ?? "none"})`);
      }
      const entry = latestJournalEntry(state, step.id);
      if (entry?.status !== "started") {
        throw new Error(`Workflow step ${step.id} has no unknown started effect to recover`);
      }

      const finishedAt = new Date().toISOString();
      if (resolution.action === "retry") {
        if (step.type === "agent") {
          const maxAttempts = maxAgentAttempts(step);
          if ((state.attempts[step.id] ?? 0) >= maxAttempts) {
            throw new Error(`Retry budget exhausted for workflow step ${step.id}; mark it complete or failed explicitly`);
          }
        }
        entry.status = "retry_authorized";
        entry.finishedAt = finishedAt;
        state.status = "paused";
        state.error = `Manual retry authorized for workflow step ${step.id}`;
      } else if (resolution.action === "complete") {
        assertJsonSerializable(resolution.output, `recovery output for ${step.id}`);
        entry.status = "recovered_completed";
        entry.finishedAt = finishedAt;
        state.outputs[step.id] = resolution.output;
        state.cursor += 1;
        state.status = state.cursor >= definition.steps.length ? "completed" : "paused";
        delete state.error;
      } else {
        if (!resolution.error.trim()) throw new Error("A human recovery failure requires a non-empty error");
        entry.status = "recovered_failed";
        entry.finishedAt = finishedAt;
        entry.error = resolution.error;
        state.status = "failed";
        state.error = resolution.error;
      }
      this.save(state);
      return state;
    } finally {
      releaseLock();
    }
  }

  async run(definition: WorkflowDefinition): Promise<WorkflowState> {
    validateWorkflow(definition);
    const releaseLock = this.acquireLock(definition.id);
    try {
      const definitionHash = hashWorkflowDefinition(definition);
      const prior = this.load(definition.id);
      const state = prior ? this.bindDefinition(prior, definition, definitionHash) : newState(definition.id, definitionHash);

      assertCursorMatchesDefinition(state, definition);
      if (state.status === "completed") return state;

      const inFlight = definition.steps[state.cursor];
      const latest = inFlight ? latestJournalEntry(state, inFlight.id) : undefined;
      if (latest?.status === "recovered_failed") return state;
      if (inFlight && latest?.status === "started" && (inFlight.type === "agent" || !latest.idempotencyEstablished)) {
        state.status = "paused";
        state.error = unknownEffectMessage(inFlight.id);
        this.save(state);
        return state;
      }

      state.status = "running";
      delete state.error;
      this.save(state);

      while (state.cursor < definition.steps.length) {
        const step = definition.steps[state.cursor];
        if (!step) break;
        try {
          if (step.type === "approval") {
            const entry = this.beginStep(state, definitionHash, step);
            this.save(state);
            const approved = await this.runtime.requestApproval(step.prompt);
            if (!approved) {
              finishJournalEntry(entry, "paused");
              state.status = "paused";
              state.outputs[step.id] = { approved: false };
              this.save(state);
              return state;
            }
            finishJournalEntry(entry, "completed");
            state.outputs[step.id] = { approved: true };
            state.cursor += 1;
            this.save(state);
          } else if (step.type === "memory") {
            const entry = this.beginStep(state, definitionHash, step);
            this.save(state);
            let memoryId: number;
            try {
              memoryId = await this.runtime.remember(step.content, step.label, entry.idempotencyKey);
            } catch (error) {
              const normalized = normalizeError(error);
              finishJournalEntry(entry, "failed", normalized.message);
              state.status = "failed";
              state.error = normalized.message;
              this.save(state);
              return state;
            }
            state.outputs[step.id] = { memoryId };
            finishJournalEntry(entry, "completed");
            state.cursor += 1;
            this.save(state);
          } else {
            const maxAttempts = maxAgentAttempts(step);
            if ((state.attempts[step.id] ?? 0) >= maxAttempts) {
              throw new Error(`Retry budget exhausted for workflow step ${step.id}: ${state.error ?? "previous attempts failed"}`);
            }
            let lastError: Error | undefined;
            while ((state.attempts[step.id] ?? 0) < maxAttempts) {
              state.attempts[step.id] = (state.attempts[step.id] ?? 0) + 1;
              const entry = this.beginStep(state, definitionHash, step, state.attempts[step.id]);
              this.save(state);
              try {
                const output = await this.runtime.runAgent(step.prompt, entry.idempotencyKey);
                state.outputs[step.id] = output;
                finishJournalEntry(entry, "completed");
                state.cursor += 1;
                delete state.error;
                this.save(state);
                lastError = undefined;
                break;
              } catch (error) {
                if (error instanceof WorkflowPersistenceError) throw error;
                if (error instanceof UnknownWorkflowEffectError) {
                  state.status = "paused";
                  state.error = `${unknownEffectMessage(step.id)} Runtime detail: ${error.message}`;
                  this.save(state);
                  return state;
                }
                lastError = normalizeError(error);
                finishJournalEntry(entry, "failed", lastError.message);
                state.error = lastError.message;
                this.save(state);
              }
            }
            if (lastError) throw lastError;
          }
        } catch (error) {
          // A persistence failure after an effect must leave the durable `started`
          // record untouched. Reclassifying it as failed would permit unsafe replay.
          if (error instanceof WorkflowPersistenceError) throw error;
          state.status = "failed";
          state.error = normalizeError(error).message;
          this.save(state);
          return state;
        }
      }
      state.status = "completed";
      this.save(state);
      return state;
    } finally {
      releaseLock();
    }
  }

  private bindDefinition(state: WorkflowState, definition: WorkflowDefinition, definitionHash: string): WorkflowState {
    if (!state.definitionHash) {
      if (!isPristineLegacyState(state)) {
        throw new Error(
          `Legacy workflow state ${definition.id} contains progress and is not bound to a definition; inspect it and call adoptLegacyState() explicitly`,
        );
      }
      state.definitionHash = definitionHash;
      state.journal = {};
      this.save(state);
      return state;
    }
    assertDefinitionMatches(state, definitionHash);
    assertCursorMatchesDefinition(state, definition);
    assertStateMatchesDefinition(state, definition, definitionHash);
    const hadJournal = state.journal !== undefined;
    state.journal = state.journal ?? {};
    const current = definition.steps[state.cursor];
    let reconstructedUnknown = false;
    if (current && ((state.attempts[current.id] ?? 0) > 0 || hasOwn(state.outputs, current.id)) && !latestJournalEntry(state, current.id)) {
      journalEntries(state, current.id).push({
        stepId: current.id,
        stepType: current.type,
        attempt: state.attempts[current.id] ?? 1,
        idempotencyKey: stepIdempotencyKey(definition.id, definitionHash, current.id),
        idempotencyEstablished: false,
        status: "started",
        startedAt: state.updatedAt,
      });
      state.status = "paused";
      state.error = unknownEffectMessage(current.id);
      reconstructedUnknown = true;
    }
    if (!hadJournal || reconstructedUnknown) this.save(state);
    return state;
  }

  private beginStep(state: WorkflowState, definitionHash: string, step: WorkflowStep, attempt?: number): WorkflowJournalEntry {
    const entries = journalEntries(state, step.id);
    const entry: WorkflowJournalEntry = {
      stepId: step.id,
      stepType: step.type,
      attempt: attempt ?? Math.max(0, ...entries.map((candidate) => candidate.attempt)) + 1,
      idempotencyKey: stepIdempotencyKey(state.workflowId, definitionHash, step.id),
      idempotencyEstablished: true,
      status: "started",
      startedAt: new Date().toISOString(),
    };
    entries.push(entry);
    return entry;
  }

  private acquireLock(id: string): () => void {
    const statePath = this.path(id);
    const lockPath = `${statePath.slice(0, -".json".length)}.lock`;
    const owner: WorkflowLockOwner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let descriptor: number | undefined;
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
        writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        const security = securePrivateFile(lockPath);
        if (!security.hardened) throw new Error(`could not secure lock: ${security.detail}`);
        let released = false;
        return () => {
          if (released) return;
          const current = readWorkflowLock(lockPath, id);
          if (current.token !== owner.token || current.pid !== owner.pid) {
            throw new WorkflowPersistenceError(`Workflow lock ownership was lost for ${id}`);
          }
          unlinkSync(lockPath);
          released = true;
        };
      } catch (error) {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor);
          } catch {
            /* best-effort cleanup */
          }
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          // If creation succeeded but a later hardening/write failed, remove
          // only the lock carrying our own token.
          try {
            if (readWorkflowLock(lockPath, id).token === owner.token) unlinkSync(lockPath);
          } catch {
            /* preserve an ambiguous lock fail-closed */
          }
          throw new WorkflowPersistenceError(`Could not acquire workflow lock for ${id}`, { cause: error });
        }
      }

      const existing = readWorkflowLock(lockPath, id);
      if (isProcessAlive(existing.pid)) {
        throw new Error(`Workflow ${id} is already locked by active process ${existing.pid}`);
      }
      const stalePath = `${lockPath}.stale.${randomUUID()}`;
      try {
        renameSync(lockPath, stalePath);
        unlinkSync(stalePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EEXIST") continue;
        throw new WorkflowPersistenceError(`Could not quarantine stale workflow lock for ${id}`, { cause: error });
      }
    }
    throw new WorkflowPersistenceError(`Could not acquire workflow lock for ${id} after concurrent retries`);
  }

  private save(state: WorkflowState): void {
    state.updatedAt = new Date().toISOString();
    const path = this.path(state.workflowId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      validateState(state);
      assertJsonSerializable(state, `workflow state ${state.workflowId}`);
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_WORKFLOW_STATE_BYTES) {
        throw new Error(`Workflow state exceeds ${MAX_WORKFLOW_STATE_BYTES} bytes`);
      }
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      syncDirectory(this.stateDirectory);
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          /* best-effort cleanup */
        }
      }
      if (existsSync(temporary)) {
        try {
          unlinkSync(temporary);
        } catch {
          /* best-effort cleanup */
        }
      }
      throw new WorkflowPersistenceError(`Could not durably save workflow state ${state.workflowId}`, {
        cause: error,
      });
    }
  }

  private path(id: string): string {
    const safe = id.trim().toLowerCase();
    if (!isWorkflowId(safe)) throw new Error("Workflow id must use 1-80 lowercase letters, numbers, dashes or underscores");
    return join(this.stateDirectory, `${safe}.json`);
  }
}

export function hashWorkflowDefinition(definition: WorkflowDefinition): string {
  validateWorkflow(definition);
  return createHash("sha256").update(canonicalJson(definition), "utf8").digest("hex");
}

function readWorkflowLock(path: string, workflowId: string): WorkflowLockOwner {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size < 2 || metadata.size > MAX_WORKFLOW_LOCK_BYTES) {
      throw new Error("lock is not a bounded regular file");
    }
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      !isPlainRecord(value) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) < 1 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(value.token) ||
      typeof value.createdAt !== "string" ||
      !isIsoDate(value.createdAt)
    ) {
      throw new Error("lock owner metadata is invalid");
    }
    return { pid: Number(value.pid), token: value.token, createdAt: value.createdAt };
  } catch (error) {
    throw new WorkflowPersistenceError(`Workflow lock for ${workflowId} is unreadable or ambiguous; inspect it before removing it manually`, { cause: error });
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Workflow definitions cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isPlainRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("Workflow definitions must contain only JSON values");
}

function validateWorkflow(definition: WorkflowDefinition): void {
  if (!isWorkflowId(definition.id) || !definition.title.trim()) {
    throw new Error("Workflow id must be lowercase and title is required");
  }
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    throw new Error("Workflow requires at least one step");
  }
  const ids = new Set<string>();
  for (const step of definition.steps) {
    if (!isStepId(step.id) || ids.has(step.id)) throw new Error(`Invalid or duplicate workflow step id: ${step.id}`);
    ids.add(step.id);
    if (step.type === "agent") {
      if (!step.prompt.trim()) throw new Error(`Agent workflow step ${step.id} requires a prompt`);
      if (step.retries !== undefined && (!Number.isInteger(step.retries) || step.retries < 0)) {
        throw new Error(`Agent workflow step ${step.id} retries must be a non-negative integer`);
      }
    } else if (step.type === "approval") {
      if (!step.prompt.trim()) throw new Error(`Approval workflow step ${step.id} requires a prompt`);
    } else if (step.type === "memory") {
      if (!step.content.trim() || !step.label.trim()) {
        throw new Error(`Memory workflow step ${step.id} requires content and label`);
      }
    } else {
      throw new Error("Unsupported workflow step type");
    }
  }
}

function validateState(value: unknown): asserts value is WorkflowState {
  if (!isPlainRecord(value)) throw new Error("Workflow state must be an object");
  if (typeof value.workflowId !== "string" || !isWorkflowId(value.workflowId)) throw new Error("Workflow state has an invalid workflowId");
  if (value.definitionHash !== undefined && (typeof value.definitionHash !== "string" || !/^[a-f0-9]{64}$/.test(value.definitionHash))) {
    throw new Error("Workflow state has an invalid definitionHash");
  }
  if (!new Set(["running", "paused", "completed", "failed"]).has(String(value.status))) {
    throw new Error("Workflow state has an invalid status");
  }
  if (!Number.isInteger(value.cursor) || Number(value.cursor) < 0) throw new Error("Workflow state has an invalid cursor");
  validateNumberRecord(value.attempts, "attempts");
  if (!isPlainRecord(value.outputs)) throw new Error("Workflow state outputs must be an object");
  if (value.error !== undefined && typeof value.error !== "string") throw new Error("Workflow state has an invalid error");
  if (typeof value.updatedAt !== "string" || !isIsoDate(value.updatedAt)) throw new Error("Workflow state has an invalid updatedAt");
  if (value.journal !== undefined) validateJournal(value.journal);
}

function validateJournal(value: unknown): void {
  if (!isPlainRecord(value)) throw new Error("Workflow state journal must be an object");
  const statuses = new Set<WorkflowJournalStatus>(["started", "completed", "failed", "paused", "retry_authorized", "recovered_completed", "recovered_failed"]);
  const stepTypes = new Set<WorkflowStep["type"]>(["agent", "approval", "memory"]);
  for (const [stepId, entries] of Object.entries(value)) {
    if (!isStepId(stepId)) throw new Error(`Workflow journal has an invalid step id: ${stepId}`);
    if (!Array.isArray(entries)) throw new Error(`Workflow journal ${stepId} must be an array`);
    for (const entry of entries) {
      if (!isPlainRecord(entry) || entry.stepId !== stepId) throw new Error(`Workflow journal ${stepId} contains an invalid entry`);
      if (!stepTypes.has(entry.stepType as WorkflowStep["type"])) throw new Error(`Workflow journal ${stepId} has an invalid step type`);
      if (!Number.isInteger(entry.attempt) || Number(entry.attempt) < 0) throw new Error(`Workflow journal ${stepId} has an invalid attempt`);
      if (typeof entry.idempotencyKey !== "string" || !/^wf_[a-f0-9]{64}$/.test(entry.idempotencyKey))
        throw new Error(`Workflow journal ${stepId} has an invalid idempotency key`);
      if (typeof entry.idempotencyEstablished !== "boolean") throw new Error(`Workflow journal ${stepId} has invalid idempotency provenance`);
      if (!statuses.has(entry.status as WorkflowJournalStatus)) throw new Error(`Workflow journal ${stepId} has an invalid status`);
      if (typeof entry.startedAt !== "string" || !isIsoDate(entry.startedAt)) throw new Error(`Workflow journal ${stepId} has an invalid start time`);
      if (entry.finishedAt !== undefined && (typeof entry.finishedAt !== "string" || !isIsoDate(entry.finishedAt))) {
        throw new Error(`Workflow journal ${stepId} has an invalid finish time`);
      }
      if (entry.error !== undefined && typeof entry.error !== "string") throw new Error(`Workflow journal ${stepId} has an invalid error`);
      if (entry.status !== "started" && entry.finishedAt === undefined) {
        throw new Error(`Workflow journal ${stepId} has a terminal entry without a finish time`);
      }
    }
  }
}

function validateNumberRecord(value: unknown, name: string): void {
  if (!isPlainRecord(value)) throw new Error(`Workflow state ${name} must be an object`);
  for (const [key, item] of Object.entries(value)) {
    if (!isStepId(key)) throw new Error(`Workflow state ${name} has an invalid step id: ${key}`);
    if (!Number.isInteger(item) || Number(item) < 0) throw new Error(`Workflow state ${name}.${key} must be a non-negative integer`);
  }
}

function newState(workflowId: string, definitionHash: string): WorkflowState {
  return {
    workflowId,
    definitionHash,
    status: "running",
    cursor: 0,
    attempts: {},
    outputs: {},
    journal: {},
    updatedAt: new Date().toISOString(),
  };
}

function isPristineLegacyState(state: WorkflowState): boolean {
  return (
    state.status !== "completed" &&
    state.cursor === 0 &&
    Object.keys(state.attempts).length === 0 &&
    Object.keys(state.outputs).length === 0 &&
    Object.keys(state.journal ?? {}).length === 0
  );
}

function assertCursorMatchesDefinition(state: WorkflowState, definition: WorkflowDefinition): void {
  if (state.cursor > definition.steps.length) {
    throw new Error(`Workflow state cursor ${state.cursor} exceeds definition length ${definition.steps.length}`);
  }
  if (state.status === "completed" && state.cursor !== definition.steps.length) {
    throw new Error(`Completed workflow state cursor ${state.cursor} does not match definition length ${definition.steps.length}`);
  }
}

function assertDefinitionMatches(state: WorkflowState, definitionHash: string): void {
  if (state.definitionHash !== definitionHash) {
    throw new Error(`Workflow definition drift detected for ${state.workflowId}: persisted ${state.definitionHash ?? "legacy"}, current ${definitionHash}`);
  }
}

function assertStateMatchesDefinition(state: WorkflowState, definition: WorkflowDefinition, definitionHash: string): void {
  assertStateStepIdsKnown(state, definition);
  const steps = new Map(definition.steps.map((step) => [step.id, step]));
  for (const [stepId, entries] of Object.entries(state.journal ?? {})) {
    const step = steps.get(stepId);
    if (!step) continue;
    const expectedKey = stepIdempotencyKey(definition.id, definitionHash, stepId);
    let priorAttempt = -1;
    for (const entry of entries) {
      if (entry.stepType !== step.type) throw new Error(`Workflow journal ${stepId} does not match the definition step type`);
      if (entry.idempotencyKey !== expectedKey) throw new Error(`Workflow journal ${stepId} has an inconsistent idempotency key`);
      if (entry.attempt < priorAttempt) throw new Error(`Workflow journal ${stepId} attempts are out of order`);
      priorAttempt = entry.attempt;
    }
  }
}

function assertStateStepIdsKnown(state: WorkflowState, definition: WorkflowDefinition): void {
  const steps = new Map(definition.steps.map((step) => [step.id, step]));
  for (const stepId of Object.keys(state.attempts)) {
    if (steps.get(stepId)?.type !== "agent") throw new Error(`Workflow attempts refer to unknown or non-agent step ${stepId}`);
  }
  for (const stepId of Object.keys(state.outputs)) {
    if (!steps.has(stepId)) throw new Error(`Workflow outputs refer to unknown step ${stepId}`);
  }
  for (const stepId of Object.keys(state.journal ?? {})) {
    if (!steps.has(stepId)) throw new Error(`Workflow journal refers to unknown step ${stepId}`);
  }
}

function stepIdempotencyKey(workflowId: string, definitionHash: string, stepId: string): string {
  const digest = createHash("sha256").update(`superai-workflow-v1\0${workflowId}\0${definitionHash}\0${stepId}`, "utf8").digest("hex");
  return `wf_${digest}`;
}

function journalEntries(state: WorkflowState, stepId: string): WorkflowJournalEntry[] {
  state.journal = state.journal ?? {};
  const existing = state.journal[stepId];
  if (existing) return existing;
  const created: WorkflowJournalEntry[] = [];
  state.journal[stepId] = created;
  return created;
}

function latestJournalEntry(state: WorkflowState, stepId: string): WorkflowJournalEntry | undefined {
  const entries = state.journal?.[stepId];
  return entries?.[entries.length - 1];
}

function finishJournalEntry(entry: WorkflowJournalEntry, status: WorkflowJournalStatus, error?: string): void {
  entry.status = status;
  entry.finishedAt = new Date().toISOString();
  if (error !== undefined) entry.error = error;
  else delete entry.error;
}

function maxAgentAttempts(step: Extract<WorkflowStep, { type: "agent" }>): number {
  return Math.max(1, (step.retries ?? 1) + 1);
}

function unknownEffectMessage(stepId: string): string {
  return (
    `Workflow step ${stepId} was interrupted after its durable start marker. Its effect is unknown; ` +
    "automatic replay is blocked until resolveUnknownStep() records a human decision."
  );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isWorkflowId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value);
}

function isStepId(value: string): boolean {
  return isWorkflowId(value) && value !== "constructor" && value !== "prototype";
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function assertJsonSerializable(value: unknown, context: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${context} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${context} contains a non-JSON value`);
  if (seen.has(value)) throw new Error(`${context} contains a circular value`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonSerializable(item, context, seen);
  } else {
    for (const item of Object.values(value)) assertJsonSerializable(item, context, seen);
  }
  seen.delete(value);
}
