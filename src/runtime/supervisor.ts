import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AgentTurnCancelledError, type AgentTurnControl, type AgentTurnResult, type SuperAgent } from "../agent.js";
import type { OmpUiHandler } from "../rpc/omp-client.js";
import type { AgentTraceEvent } from "../types.js";
import type { RuntimeTaskRecord } from "./store.js";
import type { ResponseLanguage } from "../response-language.js";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type UpdateClassification = "steer" | "follow_up" | "stop" | "status";

export interface SupervisedTaskSnapshot {
  id: string;
  projectId?: string;
  sessionId: string;
  prompt: string;
  status: TaskStatus;
  output: string;
  model?: string;
  turnId?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  trace: AgentTraceEvent[];
}

export interface SupervisorUpdate {
  classification: UpdateClassification;
  acknowledgement: string;
  task: SupervisedTaskSnapshot;
}

export interface StartTaskOptions {
  sessionId?: string;
  approve?: (description: string) => Promise<boolean>;
  uiHandler?: OmpUiHandler;
  model?: string;
  responseLanguage?: ResponseLanguage;
  crossProjectSearch?: boolean;
}

interface TaskState extends SupervisedTaskSnapshot {
  control: AgentTurnControl | undefined;
  pending: Array<{ classification: Exclude<UpdateClassification, "status">; content: string }>;
  followUps: Array<{ id: string; prompt: string }>;
  completion: Promise<AgentTurnResult>;
  resolveCompletion: (result: AgentTurnResult) => void;
  rejectCompletion: (error: Error) => void;
}

export class TaskSupervisor {
  private readonly tasks = new Map<string, TaskState>();
  private readonly activeBySession = new Map<string, string>();
  private readonly events = new EventEmitter();
  private activeTaskId: string | undefined;

  constructor(
    private readonly agent: SuperAgent,
    private readonly projectId = agent.projectId,
  ) {
    this.events.setMaxListeners(200);
  }

  start(prompt: string, options: StartTaskOptions = {}): SupervisedTaskSnapshot {
    return this.launch(prompt, options, randomUUID(), false);
  }

  private launch(prompt: string, options: StartTaskOptions, id: string, alreadyPrepared: boolean): SupervisedTaskSnapshot {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || cleanPrompt.length > 200_000) throw new Error("Task prompt must contain 1-200,000 characters");
    const sessionId = options.sessionId ?? randomUUID();
    if (this.activeTaskId) {
      throw new Error(`This Axiomux project already has active task ${this.activeTaskId}; steer it, stop it, or queue a follow-up`);
    }
    const existing = this.activeBySession.get(sessionId);
    if (existing) throw new Error(`Session ${sessionId} already has active task ${existing}`);
    if (!alreadyPrepared) this.agent.prepareTask?.(id, sessionId, cleanPrompt);
    let resolveCompletion!: (result: AgentTurnResult) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<AgentTurnResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    completion.catch(() => undefined);
    const state: TaskState = {
      id,
      ...(this.projectId ? { projectId: this.projectId } : {}),
      sessionId,
      prompt: cleanPrompt,
      status: "queued",
      output: "",
      startedAt: new Date().toISOString(),
      trace: [],
      pending: [],
      followUps: [],
      completion,
      resolveCompletion,
      rejectCompletion,
      control: undefined,
    };
    this.tasks.set(id, state);
    this.activeBySession.set(sessionId, id);
    this.activeTaskId = id;
    this.emit(state);
    void this.execute(state, options);
    return snapshot(state);
  }

  get(id: string): SupervisedTaskSnapshot | undefined {
    const state = this.tasks.get(id);
    if (state) return snapshot(state);
    const record = this.agent.getPersistedTask?.(id);
    if (!record) return this.listPersisted().find((task) => task.id === id);
    return persistedSnapshot(record, this.agent.listPersistedTaskEvents?.(record) ?? []);
  }

  activeForSession(sessionId: string): SupervisedTaskSnapshot | undefined {
    const id = this.activeBySession.get(sessionId);
    return id ? this.get(id) : undefined;
  }

  list(): SupervisedTaskSnapshot[] {
    const combined = new Map(this.listPersisted().map((task) => [task.id, task]));
    for (const state of this.tasks.values()) combined.set(state.id, snapshot(state));
    return [...combined.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  listPersisted(sessionId?: string): SupervisedTaskSnapshot[] {
    const records = this.agent.listPersistedTasks?.(sessionId) ?? [];
    return records.map((record) => persistedSnapshot(record));
  }

  async send(id: string, message: string): Promise<SupervisorUpdate> {
    const content = message.trim();
    if (!content || content.length > 50_000) throw new Error("Update must contain 1-50,000 characters");
    const classification = classifyUserUpdate(content);
    const state = this.tasks.get(id);
    if (!state) {
      const persisted = this.get(id);
      if (!persisted) throw new Error(`Unknown task: ${id}`);
      if (classification === "status") {
        return { classification, acknowledgement: statusAcknowledgement(persisted), task: persisted };
      }
      throw new Error(`Task ${id} is persisted as ${persisted.status}; execution is not resumed after restart`);
    }
    if (classification === "status") {
      return { classification, acknowledgement: statusAcknowledgement(state), task: snapshot(state) };
    }
    if (!["queued", "running"].includes(state.status)) {
      throw new Error(`Task ${id} is already ${state.status}; start a new turn in session ${state.sessionId}`);
    }
    const payload = stripControlPrefix(content, classification);
    if (classification === "follow_up") {
      const followUpId = randomUUID();
      this.agent.prepareTask?.(followUpId, state.sessionId, payload);
      state.followUps.push({ id: followUpId, prompt: payload });
      this.emit(state);
      return {
        classification,
        acknowledgement: "Follow-up queued as a new task after the active run; current work continues.",
        task: snapshot(state),
      };
    }
    if (state.control) {
      await deliver(state.control, classification, payload);
    } else {
      state.pending.push({ classification, content: payload });
    }
    this.emit(state);
    return { classification, acknowledgement: acknowledgement(classification, Boolean(state.control)), task: snapshot(state) };
  }

  wait(id: string): Promise<AgentTurnResult> {
    const state = this.tasks.get(id);
    if (!state) {
      const persisted = this.get(id);
      return Promise.reject(
        new Error(persisted ? `Task ${id} is persisted as ${persisted.status}; execution is not resumed after restart` : `Unknown task: ${id}`),
      );
    }
    return state.completion;
  }

  subscribe(listener: (task: SupervisedTaskSnapshot) => void): () => void {
    this.events.on("task", listener);
    return () => this.events.off("task", listener);
  }

  private async execute(state: TaskState, options: StartTaskOptions): Promise<void> {
    state.status = "running";
    this.emit(state);
    try {
      const result = await this.agent.runTurn(state.prompt, {
        sessionId: state.sessionId,
        taskId: state.id,
        onDelta: (delta) => {
          state.output += delta;
          this.emit(state);
        },
        onTrace: (event) => {
          state.trace.push(event);
          this.emit(state);
        },
        onControl: (control) => {
          state.control = control;
          if (control) {
            state.turnId = control.turnId;
            void this.drain(state, control);
          }
          this.emit(state);
        },
        ...(options.approve ? { approve: options.approve } : {}),
        ...(options.uiHandler ? { uiHandler: options.uiHandler } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.responseLanguage ? { responseLanguage: options.responseLanguage } : {}),
        ...(options.crossProjectSearch ? { crossProjectSearch: true } : {}),
      });
      if (result.taskId && result.taskId !== state.id) {
        throw new Error(`Agent returned task ${result.taskId} for supervisor task ${state.id}`);
      }
      state.status = "completed";
      state.model = result.model;
      state.turnId = result.turnId;
      state.output = result.text;
      state.completedAt = new Date().toISOString();
      state.resolveCompletion(result);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      state.status = normalized instanceof AgentTurnCancelledError ? "cancelled" : "failed";
      state.error = normalized.message;
      state.completedAt = new Date().toISOString();
      state.rejectCompletion(normalized);
    } finally {
      state.control = undefined;
      this.activeBySession.delete(state.sessionId);
      if (this.activeTaskId === state.id) this.activeTaskId = undefined;
      this.emit(state);
      const [next, ...remaining] = state.followUps;
      if (next) {
        const queued = this.launch(next.prompt, { ...options, sessionId: state.sessionId }, next.id, true);
        const queuedState = this.tasks.get(queued.id);
        if (queuedState) queuedState.followUps.push(...remaining);
      }
    }
  }

  private async drain(state: TaskState, control: AgentTurnControl): Promise<void> {
    while (state.pending.length && state.control === control && state.status === "running") {
      const update = state.pending.shift();
      if (!update) break;
      try {
        await deliver(control, update.classification, update.content);
      } catch (error) {
        state.trace.push({
          at: new Date().toISOString(),
          kind: "steering",
          phase: "failed",
          label: "Queued user update could not be delivered",
          detail: error instanceof Error ? error.message : String(error),
        });
        this.emit(state);
      }
    }
  }

  private emit(state: TaskState): void {
    const task = snapshot(state);
    for (const listener of this.events.listeners("task")) {
      try {
        listener(task);
      } catch {
        /* UI observers cannot control task execution. */
      }
    }
  }
}

export function classifyUserUpdate(message: string): UpdateClassification {
  const normalized = message.trim().toLocaleLowerCase();
  // Explicit Portuguese intent aliases keep steering safe for multilingual
  // prompts without turning the CLI/TUI into a second localized surface.
  if (/^\/(status|estado)$/.test(normalized) || /^(como vai|qual (é )?o estado|status)\??$/.test(normalized)) return "status"; // language-audit: allow-portuguese-input
  if (/^\/(stop|cancel)$/.test(normalized) || /^(para|pára|cancela|interrompe)( agora)?[.!]?$/.test(normalized)) return "stop"; // language-audit: allow-portuguese-input
  if (/^\/(next|queue|follow-?up)\b/.test(normalized)) return "follow_up";
  return "steer";
}

async function deliver(control: AgentTurnControl, classification: Exclude<UpdateClassification, "status">, content: string): Promise<void> {
  if (classification === "stop") return control.stop();
  if (classification === "follow_up") return control.followUp(content);
  return control.steer(content);
}

function stripControlPrefix(content: string, classification: Exclude<UpdateClassification, "status">): string {
  if (classification === "follow_up") return content.replace(/^\/(next|queue|follow-?up)\s*/i, "").trim() || content;
  return content;
}

function acknowledgement(classification: Exclude<UpdateClassification, "status">, delivered: boolean): string {
  if (classification === "stop")
    return delivered ? "Explicit stop sent to the active run." : "Stop recorded; it will be delivered as soon as the runtime is ready.";
  if (classification === "follow_up") return delivered ? "New task queued after the active run." : "Follow-up stored without interrupting current work.";
  return delivered ? "Update integrated into the active run; work was not cancelled." : "Update stored for steering; work continues.";
}

function statusAcknowledgement(state: Pick<SupervisedTaskSnapshot, "status" | "trace" | "output">): string {
  return `Task is ${state.status}; ${state.trace.length} event(s), ${state.output.length} character(s) produced.`;
}

function snapshot(state: TaskState): SupervisedTaskSnapshot {
  return {
    id: state.id,
    ...(state.projectId ? { projectId: state.projectId } : {}),
    sessionId: state.sessionId,
    prompt: state.prompt,
    status: state.status,
    output: state.output,
    ...(state.model ? { model: state.model } : {}),
    ...(state.turnId ? { turnId: state.turnId } : {}),
    ...(state.error ? { error: state.error } : {}),
    startedAt: state.startedAt,
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    trace: state.trace.map((event) => ({ ...event })),
  };
}

function persistedSnapshot(record: RuntimeTaskRecord, trace: AgentTraceEvent[] = []): SupervisedTaskSnapshot {
  return {
    id: record.id,
    projectId: record.projectId,
    sessionId: record.sessionId,
    prompt: record.prompt,
    status: record.status === "waiting" ? "running" : record.status,
    output: record.output,
    ...(record.model ? { model: record.model } : {}),
    ...(record.turnId ? { turnId: record.turnId } : {}),
    ...(record.error ? { error: record.error } : {}),
    startedAt: record.startedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    trace: trace.map((event) => ({ ...event })),
  };
}
