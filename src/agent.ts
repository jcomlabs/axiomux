import { createHash, randomUUID } from "node:crypto";
import type { AuditLog } from "./audit.js";
import { CommandAdapter } from "./adapters/command-adapter.js";
import type { AgentTraceEvent, SuperAIConfig, HostTool, HostToolContext, MemoryItem } from "./types.js";
import type { MemoryStore } from "./memory/store.js";
import { PromptComposer } from "./persona.js";
import { PolicyEngine } from "./policy.js";
import type { SkillManager } from "./skills/manager.js";
import { SkillLearner } from "./skills/learner.js";
import { assertAgentSourceIngestionAllowed, SourceHub, sourceApprovalLabel } from "./sources.js";
import { OMP_CONTRACT_VERSION, OmpRpcClient, type OmpClientOptions, type OmpTurnResult, type OmpUiHandler } from "./rpc/omp-client.js";
import { redactSecrets, redactValue } from "./security/secrets.js";
import { getOmpIsolation, getProviderRuntimeArgs } from "./config.js";
import { RuntimeStore, type RuntimeTaskRecord } from "./runtime/store.js";
import { createWorkspaceIdentity, revalidateWorkspaceIdentity, sameWorkspaceIdentity, type WorkspaceIdentity } from "./runtime/project-boundary.js";
import { NeuralwattProvider } from "./providers/neuralwatt.js";
import { FusionEngine, OmpFusionRunner, type FusionTelemetryEvent } from "./fusion/index.js";
import { createWorkspaceTools, partitionOmpTools, type WorkspaceToolAuditEvent } from "./tools/workspace-tools.js";
import { responseLanguageInstruction, type ResponseLanguage } from "./response-language.js";

export interface AgentTurnOptions {
  sessionId?: string;
  taskId?: string;
  onDelta?: (delta: string) => void;
  approve?: (description: string) => Promise<boolean>;
  uiHandler?: OmpUiHandler;
  onTrace?: (event: AgentTraceEvent) => void;
  onControl?: (control: AgentTurnControl | undefined) => void;
  model?: string;
  /** Web UI presentation preference. It affects model prose, never protocol or stored authority. */
  responseLanguage?: ResponseLanguage;
  /** Opt-in for the global TUI: expose bounded read-only search across linked projects. */
  crossProjectSearch?: boolean;
  /** Stable workflow key for trace/audit correlation only; never enters the model prompt. */
  workflowIdempotencyKey?: string;
}

export interface AgentTurnControl {
  turnId: string;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  stop(): Promise<void>;
}

export class AgentTurnCancelledError extends Error {
  constructor(message = "Turn cancelled by explicit user request") {
    super(message);
    this.name = "AgentTurnCancelledError";
  }
}

export class AgentTurnFailedError extends Error {
  readonly effectsMayHaveOccurred: boolean;

  constructor(message: string, effectsMayHaveOccurred: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentTurnFailedError";
    this.effectsMayHaveOccurred = effectsMayHaveOccurred;
  }
}

export interface AgentTurnResult {
  text: string;
  model: string;
  sessionId: string;
  recalledMemoryIds: number[];
  toolCalls: number;
  learningCandidateId?: number;
  selfEvaluationMemoryId?: number;
  episodicMemoryId?: number;
  trace: AgentTraceEvent[];
  turnId: string;
  taskId?: string;
}

interface AgentProviderClient {
  readonly approvedConsequentialAction: boolean;
  readonly turnActive: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  registerTools(tools: HostTool[]): Promise<void>;
  prompt(message: string, onDelta?: (delta: string) => void): Promise<OmpTurnResult>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
}

type AgentProviderClientFactory = (options: OmpClientOptions) => AgentProviderClient;

export interface SuperAgentOptions {
  /** Canonical folder exposed to OMP and governed workspace tools. */
  workspaceRoot?: string;
}

export class SuperAgent {
  private readonly composer: PromptComposer;
  private readonly learner: SkillLearner;
  private readonly policy = new PolicyEngine();
  private readonly runtime: RuntimeStore;
  private readonly sources: SourceHub;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly memoryScope: string;
  private readonly workspaceIdentity: WorkspaceIdentity;
  private readonly neuralwatt: NeuralwattProvider;
  private readonly createProviderClient: AgentProviderClientFactory;

  constructor(
    private readonly root: string,
    private readonly config: SuperAIConfig,
    private readonly ompExecutable: string,
    private readonly memory: MemoryStore,
    skills: SkillManager,
    sources: SourceHub,
    private readonly audit: AuditLog,
    createProviderClient: AgentProviderClientFactory = (options) => new OmpRpcClient(options),
    options: SuperAgentOptions = {},
  ) {
    this.workspaceIdentity = createWorkspaceIdentity(root, options.workspaceRoot ?? root);
    this.workspaceRoot = this.workspaceIdentity.rootPath;
    this.composer = new PromptComposer(root, skills, () => config.persona.intensity);
    this.learner = new SkillLearner(skills, memory);
    this.runtime = new RuntimeStore(memory.database);
    this.projectId = (this.runtime.getProjectByRoot(this.workspaceRoot) ?? this.runtime.ensureProject(this.workspaceRoot)).id;
    this.memoryScope = this.projectId;
    if (!sameWorkspaceIdentity(sources.workspaceIdentity, this.workspaceIdentity)) {
      throw new Error("SourceHub workspace does not match the SuperAgent project workspace");
    }
    this.sources = new SourceHub(memory, this.workspaceRoot, this.memoryScope, this.workspaceIdentity);
    this.neuralwatt = new NeuralwattProvider(root);
    this.createProviderClient = createProviderClient;
  }

  prepareTask(taskId: string, sessionId: string, prompt: string): void {
    revalidateWorkspaceIdentity(this.workspaceIdentity);
    const normalizedPrompt = validateUserText(prompt);
    const normalizedTaskId = validateTaskId(taskId);
    this.runtime.attachSession(this.projectId, sessionId, normalizedPrompt.slice(0, 100));
    this.runtime.createTask(this.projectId, sessionId, normalizedPrompt, undefined, { id: normalizedTaskId, status: "queued" });
  }

  listPersistedTasks(sessionId?: string, limit = 500): RuntimeTaskRecord[] {
    return this.runtime.listTasks(this.projectId, sessionId, limit);
  }

  getPersistedTask(taskId: string): RuntimeTaskRecord | undefined {
    const task = this.runtime.getTask(taskId);
    return task?.projectId === this.projectId ? task : undefined;
  }

  listPersistedTaskEvents(task: RuntimeTaskRecord): AgentTraceEvent[] {
    return this.runtime
      .listEvents(task.sessionId)
      .filter((event) => event.turnId === task.turnId)
      .map(({ id: _id, turnId: _turnId, ...event }) => event);
  }

  async runTurn(userText: string, options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
    const normalizedUserText = validateUserText(userText);
    const sessionId = options.sessionId ?? randomUUID();
    const taskId = validateTaskId(options.taskId ?? randomUUID());
    const workflowIdempotencyKey = options.workflowIdempotencyKey === undefined ? undefined : validateWorkflowIdempotencyKey(options.workflowIdempotencyKey);
    const trace: AgentTraceEvent[] = [];
    let turnId: string | undefined;
    let selfEvaluationMemoryId: number | undefined;
    let episodicMemoryId: number | undefined;
    let selfEvaluationRecorded = false;
    let streamedOutput = "";
    let persistedOutputCharacters = 0;
    let outputPersistedAt = 0;
    const persistStreamedOutput = (): void => {
      const now = performance.now();
      if (outputPersistedAt === 0 || now - outputPersistedAt >= 250 || streamedOutput.length - persistedOutputCharacters >= 4_096) {
        this.runtime.setTaskOutput(taskId, streamedOutput);
        persistedOutputCharacters = streamedOutput.length;
        outputPersistedAt = now;
      }
    };

    try {
      revalidateWorkspaceIdentity(this.workspaceIdentity);
      this.runtime.attachSession(this.projectId, sessionId, normalizedUserText.slice(0, 100));
      this.runtime.createTask(this.projectId, sessionId, normalizedUserText, undefined, { id: taskId, status: "running" });
      const memories = this.memory.recall(normalizedUserText, sessionId, this.config.memory.recallLimit, this.memoryScope);
      const recent = this.memory.recentMessages(sessionId, 14);
      this.memory.addMessage(sessionId, "user", normalizedUserText);
      const turn = this.runtime.beginTurn(sessionId, normalizedUserText);
      turnId = turn.id;
      this.runtime.updateTask(taskId, "running", turn.id);
      const emit = (event: Omit<AgentTraceEvent, "at">): void => {
        const complete: AgentTraceEvent = { at: new Date().toISOString(), ...event };
        trace.push(complete);
        try {
          this.runtime.appendEvent(sessionId, turn.id, complete);
        } catch {
          /* Trace persistence is observational. */
        }
        invokeObserver(options.onTrace, complete);
      };
      emit({
        kind: "lifecycle",
        phase: "started",
        label: "Turn started",
        detail: `session=${sessionId}${workflowIdempotencyKey ? `; workflow_key=${workflowIdempotencyKey}` : ""}`,
      });
      emit({
        kind: "memory",
        phase: "completed",
        label: "Governed memory recalled",
        detail: `${memories.length} item(s): ${memories.map((item) => item.id).join(", ") || "none"}`,
      });
      let lastError: Error | undefined;
      let stopRequested = false;
      let activeClient: AgentProviderClient | undefined;
      const turnController = new AbortController();
      const steeringHistory: string[] = [];

      invokeObserver(options.onControl, {
        turnId: turn.id,
        steer: async (message) => {
          const text = validateControlText(message);
          const steeringId = this.runtime.queueSteering(turn.id, "steer", text);
          steeringHistory.push(text);
          try {
            if (activeClient?.turnActive) await activeClient.steer(text);
            this.runtime.markSteering(steeringId, true);
            emit({
              kind: "steering",
              phase: activeClient?.turnActive ? "completed" : "queued",
              label: activeClient?.turnActive ? "User update delivered to the active model" : "User update will be included before the model starts",
            });
          } catch (error) {
            this.runtime.markSteering(steeringId, false);
            throw error;
          }
        },
        followUp: async (message) => {
          const text = validateControlText(message);
          const steeringId = this.runtime.queueSteering(turn.id, "follow_up", text);
          try {
            if (activeClient?.turnActive) await activeClient.followUp(text);
            else steeringHistory.push(`Follow-up requested while preparing: ${text}`);
            this.runtime.markSteering(steeringId, true);
          } catch (error) {
            this.runtime.markSteering(steeringId, false);
            throw error;
          }
        },
        stop: async () => {
          const steeringId = this.runtime.queueSteering(turn.id, "stop", "/stop");
          stopRequested = true;
          turnController.abort(new AgentTurnCancelledError());
          try {
            await activeClient?.abort();
            this.runtime.markSteering(steeringId, true);
          } catch (error) {
            this.runtime.markSteering(steeringId, false);
            throw error;
          }
        },
      });

      const sessionModel = this.runtime.sessionPreferredModel(sessionId);
      const exactModel = options.model ?? sessionModel;
      const primaryModel = exactModel ? validateModelSelector(exactModel) : this.config.model;
      // An explicit per-request or per-session choice is an exact privacy/routing
      // decision. It disables both cross-provider fallback and the Fusion fan-out.
      const models = exactModel ? [primaryModel] : [primaryModel, ...this.config.fallbackModels.filter((model) => model !== primaryModel)];
      let fusionContext = "";
      if (this.config.fusion.enabled && exactModel) {
        emit({
          kind: "reasoning",
          phase: "completed",
          label: "Fusion skipped for exact model route",
          detail: `model=${primaryModel}; no consultant received the prompt`,
        });
      } else if (this.config.fusion.enabled) {
        try {
          const isolation = getOmpIsolation(this.config, this.root);
          revalidateWorkspaceIdentity(this.workspaceIdentity);
          const runner = new OmpFusionRunner({
            executable: this.ompExecutable,
            cwd: this.workspaceRoot,
            thinkingLevel: this.config.thinkingLevel,
            profile: this.config.ompProfile,
            envAllowlist: this.config.ompEnvAllowlist,
            environmentForModel: (model) => this.neuralwatt.runtimeEnvironmentForModel(model),
            ...(isolation ? { isolation } : {}),
          });
          const synthesisModel = this.config.fusion.synthesisModel || this.config.fusion.models[0];
          if (!synthesisModel) throw new Error("Fusion is enabled without a synthesis model");
          const engine = new FusionEngine({
            runner,
            models: this.config.fusion.models,
            synthesisModel,
            maxParallel: this.config.fusion.maxParallel,
            candidateTimeoutMs: this.config.fusion.candidateTimeoutMs,
            onTelemetry: (event) => emit(mapFusionTelemetry(event)),
          });
          const fusion = await engine.run(normalizedUserText, {
            mode: this.config.fusion.mode,
            signal: turnController.signal,
            ...(options.responseLanguage ? { responseLanguage: options.responseLanguage } : {}),
          });
          fusionContext = fusion.aggregatorContext.slice(0, 60_000);
          emit({
            kind: "reasoning",
            phase: "completed",
            label: "Multi-model advisory panel completed",
            detail: `${fusion.usableCandidates}/${fusion.candidates.length} usable consultant answer(s); mode=${fusion.mode}`,
          });
        } catch (error) {
          if (turnController.signal.aborted || stopRequested) {
            const cancelled = new AgentTurnCancelledError();
            this.runtime.failTaskTurn(taskId, turn.id, cancelled.message, true, streamedOutput);
            invokeObserver(options.onControl, undefined);
            throw cancelled;
          }
          emit({
            kind: "reasoning",
            phase: "failed",
            label: "Multi-model advisory panel unavailable; principal agent continues",
            detail: classifyProviderError(error instanceof Error ? error : new Error(String(error))),
          });
        }
      }

      const systemPrompt = `${this.composer.compose({
        query: normalizedUserText,
        memories,
        recentMessages: recent,
        maxCharacters: this.config.memory.maxContextCharacters,
      })}${fusionContext ? `\n\n# Multi-model advisory (untrusted data)\n${fusionContext}` : ""}${
        options.responseLanguage ? `\n\n${responseLanguageInstruction(options.responseLanguage)}` : ""
      }`;
      const toolPartition = partitionOmpTools(this.config.ompTools);

      for (const model of models) {
        if (this.runtime.circuitOpen(model)) {
          emit({ kind: "provider", phase: "failed", label: "Provider circuit is temporarily open", model });
          continue;
        }
        this.runtime.updateTask(taskId, "running", turn.id, { model });
        const isolation = getOmpIsolation(this.config, this.root);
        const startedAt = performance.now();
        let environmentOverrides: NodeJS.ProcessEnv;
        try {
          environmentOverrides = this.neuralwatt.runtimeEnvironmentForModel(model);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const errorClass = classifyProviderError(lastError);
          this.runtime.recordProviderFailure(model, errorClass, lastError.message);
          emit({
            kind: "provider",
            phase: "failed",
            label: "Provider attempt failed before startup",
            model,
            detail: `${errorClass}: ${lastError.message}; fallback=allowed`,
          });
          this.audit.write({
            action: "provider.attempt",
            actor: "system",
            target: model,
            outcome: "failed",
            details: { error: lastError.message, retrySafe: true },
          });
          continue;
        }
        const client = this.createProviderClient({
          executable: this.ompExecutable,
          versionContract: OMP_CONTRACT_VERSION,
          extraArgs: getProviderRuntimeArgs(this.root),
          cwd: this.workspaceRoot,
          model,
          thinkingLevel: this.config.thinkingLevel,
          systemPrompt,
          profile: this.config.ompProfile,
          approvalMode: this.config.approvalMode,
          tools: toolPartition.native,
          envAllowlist: this.config.ompEnvAllowlist,
          environmentOverrides,
          ...(isolation ? { isolation } : {}),
          ...(options.uiHandler ? { uiHandler: options.uiHandler } : {}),
          onActivity: (event) =>
            emit({
              kind: event.kind,
              phase: event.phase,
              label: event.label,
              ...(event.detail ? { detail: event.detail } : {}),
              ...(event.tool ? { tool: event.tool } : {}),
              model,
            }),
        });
        let responseAccepted = false;
        try {
          emit({ kind: "provider", phase: "started", label: "Provider attempt started", model });
          revalidateWorkspaceIdentity(this.workspaceIdentity);
          await client.start();
          activeClient = client;
          await client.registerTools(this.hostTools(sessionId, turn.id, options.approve, options.crossProjectSearch === true));
          const providerPrompt = steeringHistory.length
            ? `${normalizedUserText}\n\nUser updates received while this task was running:\n${steeringHistory.map((message, index) => `${index + 1}. ${message}`).join("\n")}`
            : normalizedUserText;
          const result = await client.prompt(providerPrompt, (delta) => {
            streamedOutput += delta;
            persistStreamedOutput();
            invokeObserver(options.onDelta, delta);
          });
          if (stopRequested) throw new AgentTurnCancelledError();
          responseAccepted = true;
          this.runtime.recordProviderSuccess(model, performance.now() - startedAt);
          this.runtime.completeTaskTurn(taskId, turn.id, sessionId, model, result.text);
          let candidate: number | undefined;
          try {
            candidate = this.config.autoLearn ? this.learner.maybePropose(sessionId, normalizedUserText, result.text) : undefined;
          } catch {
            candidate = undefined;
          }
          emit({ kind: "provider", phase: "completed", label: "Provider attempt completed", model, detail: `${result.toolCalls} tool call(s)` });
          selfEvaluationMemoryId = this.recordSelfEvaluation({
            taskId,
            turnId: turn.id,
            outcome: "completed",
            model,
            toolCalls: result.toolCalls,
            recalledMemories: memories.length,
            trace,
          });
          selfEvaluationRecorded = true;
          if (selfEvaluationMemoryId)
            emit({ kind: "memory", phase: "completed", label: "Operational self-evaluation stored for review", detail: `memory=${selfEvaluationMemoryId}` });
          episodicMemoryId = this.recordEpisodicSummary({
            sessionId,
            taskId,
            turnId: turn.id,
            model,
            userText: normalizedUserText,
            answer: result.text,
            toolCalls: result.toolCalls,
          });
          if (episodicMemoryId)
            emit({ kind: "memory", phase: "completed", label: "Local episodic summary stored for review", detail: `memory=${episodicMemoryId}` });
          emit({ kind: "lifecycle", phase: "completed", label: "Turn completed", model });
          try {
            this.audit.write({
              action: "agent.turn",
              actor: "agent",
              target: sessionId,
              outcome: "completed",
              details: {
                model,
                toolCalls: result.toolCalls,
                recalledMemoryIds: memories.map((memory) => memory.id),
                learningCandidateId: candidate,
                selfEvaluationMemoryId,
                episodicMemoryId,
                ...(workflowIdempotencyKey ? { workflowIdempotencyKey } : {}),
              },
            });
          } catch {
            /* A completed answer is not replayed because an auxiliary audit sink failed. */
          }
          activeClient = undefined;
          await client.stop().catch(() => undefined);
          invokeObserver(options.onControl, undefined);
          return {
            text: result.text,
            model,
            sessionId,
            recalledMemoryIds: memories.map((memory) => memory.id),
            toolCalls: result.toolCalls,
            trace,
            turnId: turn.id,
            taskId,
            ...(candidate ? { learningCandidateId: candidate } : {}),
            ...(selfEvaluationMemoryId ? { selfEvaluationMemoryId } : {}),
            ...(episodicMemoryId ? { episodicMemoryId } : {}),
          };
        } catch (error) {
          activeClient = undefined;
          lastError = error instanceof Error ? error : new Error(String(error));
          if (responseAccepted) {
            await client.stop().catch(() => undefined);
            throw lastError instanceof AgentTurnFailedError ? lastError : new AgentTurnFailedError(lastError.message, true, { cause: lastError });
          }
          if (stopRequested || lastError instanceof AgentTurnCancelledError) {
            await client.stop().catch(() => undefined);
            invokeObserver(options.onControl, undefined);
            break;
          }
          const errorClass = classifyProviderError(lastError);
          this.runtime.recordProviderFailure(model, errorClass, lastError.message);
          const retrySafe = !client.approvedConsequentialAction && !this.runtime.hasConsequentialEffect(turn.id);
          emit({
            kind: "provider",
            phase: "failed",
            label: "Provider attempt failed",
            model,
            detail: `${errorClass}: ${lastError.message}; fallback=${retrySafe ? "allowed" : "blocked by side-effect ledger"}`,
          });
          this.audit.write({
            action: "provider.attempt",
            actor: "system",
            target: model,
            outcome: "failed",
            details: { error: lastError.message, retrySafe },
          });
          await client.stop().catch(() => undefined);
          if (!retrySafe) {
            lastError = new AgentTurnFailedError(lastError.message, true, { cause: lastError });
            break;
          }
        }
      }
      const terminalError = lastError?.message ?? "No provider model is configured";
      this.runtime.failTaskTurn(taskId, turn.id, terminalError, stopRequested, streamedOutput);
      selfEvaluationMemoryId = this.recordSelfEvaluation({
        taskId,
        turnId: turn.id,
        outcome: stopRequested ? "cancelled" : "failed",
        toolCalls: 0,
        recalledMemories: memories.length,
        trace,
      });
      selfEvaluationRecorded = true;
      emit({
        kind: "lifecycle",
        phase: stopRequested ? "completed" : "failed",
        label: stopRequested ? "Turn cancelled" : "Turn failed",
        detail: terminalError,
      });
      invokeObserver(options.onControl, undefined);
      throw stopRequested ? new AgentTurnCancelledError() : (lastError ?? new Error("No provider model is configured"));
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const cancelled = normalized instanceof AgentTurnCancelledError;
      const persisted = this.runtime.getTask(taskId);
      if (persisted && ["queued", "running", "waiting"].includes(persisted.status)) {
        this.runtime.failTaskTurn(taskId, turnId, normalized.message, cancelled, streamedOutput);
      }
      if (!selfEvaluationRecorded) {
        this.recordSelfEvaluation({
          taskId,
          ...(turnId ? { turnId } : {}),
          outcome: cancelled ? "cancelled" : "failed",
          toolCalls: 0,
          recalledMemories: 0,
          trace,
        });
      }
      invokeObserver(options.onControl, undefined);
      throw normalized;
    }
  }

  private recordSelfEvaluation(input: {
    taskId: string;
    turnId?: string;
    outcome: "completed" | "failed" | "cancelled";
    model?: string;
    toolCalls: number;
    recalledMemories: number;
    trace: AgentTraceEvent[];
  }): number | undefined {
    if (!this.config.selfEvaluation.enabled) return undefined;
    try {
      const providerFailures = input.trace.filter((event) => event.kind === "provider" && event.phase === "failed").length;
      const toolFailures = input.trace.filter((event) => event.kind === "tool" && event.phase === "failed").length;
      const steeringUpdates = input.trace.filter((event) => event.kind === "steering" && ["completed", "queued"].includes(event.phase)).length;
      const fusionCompleted = input.trace.some((event) => event.kind === "reasoning" && event.label === "Multi-model advisory panel completed");
      const wentWell =
        input.outcome === "completed"
          ? `Accepted response with ${input.toolCalls} tool call(s), ${input.recalledMemories} recalled memory item(s)${fusionCompleted ? " and a completed Fusion panel" : ""}.`
          : `The task state was preserved as ${input.outcome}; no false completion was recorded.`;
      const improve =
        providerFailures || toolFailures
          ? `${providerFailures} provider attempt(s) and ${toolFailures} tool call(s) failed; review the public trace and provider health before retrying.`
          : input.outcome === "completed"
            ? "No operational failure was observed; the factual quality of the response still requires human validation."
            : "The task ended before a response was accepted; review the public trace and resume with explicit context.";
      const content = redactSecrets(
        [
          "Axiomux operational self-evaluation v1",
          `Outcome: ${input.outcome}.`,
          `What went well: ${wentWell}`,
          `What to improve: ${improve}`,
          `Metrics: model=${input.model ?? "none"}; provider_failures=${providerFailures}; tool_failures=${toolFailures}; steering_updates=${steeringUpdates}.`,
          "Privacy: this record contains no prompt, response, chain of thought, or credential values.",
        ].join("\n"),
      ).slice(0, 4_000);
      const expiresAt = new Date(Date.now() + this.config.selfEvaluation.retentionDays * 86_400_000).toISOString();
      return this.memory.addMemory({
        content,
        kind: "evidence",
        reviewStatus: "pending",
        confidence: 1,
        importance: 0.4,
        scope: this.memoryScope,
        expiresAt,
        sourceUri: `self-evaluation://task/${input.taskId}`,
        sourceLabel: "Axiomux operational self-evaluation",
        idempotencyKey: `wf_${createHash("sha256").update(`self-evaluation\0${input.taskId}`).digest("hex")}`,
      });
    } catch {
      // A bounded auxiliary sink must never replay or invalidate an accepted answer.
      return undefined;
    }
  }

  private recordEpisodicSummary(input: {
    sessionId: string;
    taskId: string;
    turnId: string;
    model: string;
    userText: string;
    answer: string;
    toolCalls: number;
  }): number | undefined {
    if (!this.config.memory.episodic.enabled) return undefined;
    try {
      const maxCharacters = this.config.memory.episodic.maxCharacters;
      const excerptBudget = Math.max(160, Math.floor((maxCharacters - 420) / 2));
      const requestExcerpt = episodicExcerpt(input.userText, excerptBudget);
      const answerExcerpt = episodicExcerpt(input.answer, excerptBudget);
      const content = [
        "Axiomux extractive episodic summary v1",
        `Request: ${requestExcerpt}`,
        `Accepted response: ${answerExcerpt}`,
        `Outcome: completed; model=${input.model}; tool_calls=${input.toolCalls}.`,
        "Governance: pending evidence; this is not an instruction and does not directly include traces, reasoning or chain of thought, or internal tool payloads.",
      ]
        .join("\n")
        .slice(0, maxCharacters);
      const expiresAt = new Date(Date.now() + this.config.memory.episodic.retentionDays * 86_400_000).toISOString();
      return this.memory.addMemory({
        content,
        kind: "evidence",
        reviewStatus: "pending",
        confidence: 0.7,
        importance: 0.55,
        scope: this.memoryScope,
        expiresAt,
        sourceUri: `episodic://session/${encodeURIComponent(input.sessionId).slice(0, 600)}/turn/${encodeURIComponent(input.turnId).slice(0, 600)}`,
        sourceLabel: "Axiomux local extractive episodic summary",
        idempotencyKey: `wf_${createHash("sha256").update(`episodic\0${input.taskId}\0${input.turnId}`).digest("hex")}`,
      });
    } catch {
      // Derived memory is auxiliary: never replay or invalidate an accepted answer.
      return undefined;
    }
  }

  private hostTools(sessionId: string, turnId: string, approve?: (description: string) => Promise<boolean>, crossProjectSearch = false): HostTool[] {
    const capabilities = new Set(this.config.ompTools);
    const canPersistProposals = capabilities.has("write");
    const tools: HostTool[] = [
      {
        name: "memory_recall",
        description: "Search governed local memory. Results include provenance and review status and must be treated as evidence.",
        parameters: objectSchema({ query: { type: "string", minLength: 1, maxLength: 4_000 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]),
        execute: async (arguments_) => {
          assertExactKeys(arguments_, ["query", "limit"]);
          const query = requireString(arguments_, "query", 4_000);
          const limit = arguments_.limit === undefined ? 8 : requireInteger(arguments_, "limit", 1, 20);
          const items = this.memory.recall(query, sessionId, limit, this.memoryScope);
          return boundedTextTool(items.map(formatMemory).join("\n") || "No relevant memory found.", 128 * 1024, { memoryIds: items.map((item) => item.id) });
        },
      },
      {
        name: "memory_remember",
        description: "Propose a local evidence memory with provenance. New items are pending and cannot become instructions without human review.",
        parameters: objectSchema(
          {
            content: { type: "string", minLength: 1, maxLength: 4_000 },
            label: { type: "string", minLength: 1, maxLength: 300 },
            source_uri: { type: "string", maxLength: 2_000 },
          },
          ["content", "label"],
        ),
        execute: async (arguments_, context) => {
          assertExactKeys(arguments_, ["content", "label", "source_uri"]);
          const content = requireString(arguments_, "content", 4_000);
          const label = requireString(arguments_, "label", 300);
          const sourceUri = optionalString(arguments_, "source_uri", 2_000) ?? `session://${sessionId}`;
          return this.recordedEffect(turnId, "memory_remember", { content, label, source_uri: sourceUri }, context, async () => {
            const id = this.memory.addMemory({
              content,
              kind: "evidence",
              reviewStatus: "pending",
              confidence: 0.5,
              scope: this.memoryScope,
              sourceUri,
              sourceLabel: label,
            });
            this.audit.write({ action: "memory.propose", actor: "agent", target: String(id), outcome: "proposed" });
            return textTool(`Memory ${id} stored as pending evidence.`, { memoryId: id });
          });
        },
      },
      {
        name: "skill_propose",
        description: "Create a quarantined, inactive skill proposal from a reusable procedure. Human approval is required before activation.",
        parameters: objectSchema(
          {
            id: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-z0-9][a-z0-9_-]*$" },
            description: { type: "string", minLength: 1, maxLength: 300 },
            procedure: { type: "string", minLength: 1, maxLength: 4_000 },
          },
          ["id", "description", "procedure"],
        ),
        execute: async (arguments_, context) => {
          assertExactKeys(arguments_, ["id", "description", "procedure"]);
          const id = requireSkillId(arguments_);
          const description = requireString(arguments_, "description", 300);
          const procedure = requireString(arguments_, "procedure", 4_000);
          return this.recordedEffect(turnId, "skill_propose", { id, description, procedure }, context, async () => {
            const proposal = this.learner.proposeFromText(id, description, procedure, sessionId);
            return textTool(`Skill ${proposal.skill.id} is quarantined with ${proposal.findings.length} review finding(s).`, { skillId: proposal.skill.id });
          });
        },
      },
      {
        name: "source_ingest",
        description: "Ingest a local file or HTTP(S) page into pending evidence memory with source provenance.",
        parameters: objectSchema({ source: { type: "string", minLength: 1, maxLength: 4_096 } }, ["source"]),
        execute: async (arguments_, context) => {
          assertExactKeys(arguments_, ["source"]);
          const source = requireString(arguments_, "source", 4_096);
          assertAgentSourceIngestionAllowed(source);
          const decision = this.policy.assess("source_ingest", { source });
          if (!approve || !(await approve(`${decision.reason}: read/fetch and persist ${sourceApprovalLabel(source)}?`))) {
            throw new Error("Source ingestion was not approved");
          }
          return this.recordedEffect(turnId, "source_ingest", { source }, context, async () => {
            const id = /^https?:\/\//i.test(source) ? await this.sources.ingestUrl(source) : await this.sources.ingestFile(source);
            return textTool(`Source ingested as pending memory ${id}.`, { memoryId: id });
          });
        },
      },
    ];
    if (crossProjectSearch) {
      tools.push({
        name: "project_search",
        description:
          "Search persisted sessions and governed memories across every currently linked Axiomux project. Read-only, bounded, and intended for the explicitly global TUI.",
        parameters: objectSchema(
          {
            query: { type: "string", minLength: 1, maxLength: 4_000 },
            limit: { type: "integer", minimum: 1, maximum: 30 },
          },
          ["query"],
        ),
        execute: async (arguments_) => {
          assertExactKeys(arguments_, ["query", "limit"]);
          const query = requireString(arguments_, "query", 4_000);
          const limit = arguments_.limit === undefined ? 12 : requireInteger(arguments_, "limit", 1, 30);
          const messages = this.runtime.searchMessages(query, limit);
          const memories = new Map<number, MemoryItem>();
          for (const item of this.memory.recall(query, sessionId, limit, "global", false)) memories.set(item.id, item);
          for (const linkedProject of this.runtime.listProjects()) {
            for (const item of this.memory.recall(query, sessionId, limit, linkedProject.id, false)) memories.set(item.id, item);
          }
          const memoryItems = [...memories.values()].slice(0, limit);
          try {
            this.audit.write({
              action: "memory.cross_project_search",
              actor: "agent",
              target: `linked-projects:${this.runtime.listProjects().length}`,
              outcome: "completed",
              details: { queryLength: query.length, messages: messages.length, memories: memoryItems.length },
            });
          } catch {
            /* Read-only audit observation cannot change search results. */
          }
          const text =
            [
              ...messages.map((item) => `[session/${item.projectName}] ${item.sessionId} ${item.role} ${item.createdAt}\n${item.content}`),
              ...memoryItems.map(formatMemory),
            ].join("\n\n") || "No cross-project result found.";
          return boundedTextTool(text, 128 * 1024, {
            projectCount: this.runtime.listProjects().length,
            sessionHits: messages.length,
            memoryIds: memoryItems.map((item) => item.id),
          });
        },
      });
    }
    if (!canPersistProposals) tools.splice(1, 3);
    tools.push(
      ...createWorkspaceTools({
        root: this.workspaceRoot,
        rootIdentity: this.workspaceIdentity,
        capabilities: this.config.ompTools,
        ...(approve ? { approve } : {}),
        effect: (capability, arguments_, context, run) => this.recordedEffect(turnId, capability, arguments_, context, run),
        audit: (event) => this.auditWorkspaceTool(event),
      }),
    );
    if (capabilities.has("browser_task") && this.config.adapters.browserUse.enabled) {
      tools.push(
        this.externalTool(
          turnId,
          "browser_task",
          "Run an autonomous Browser Use task with structured history in an ephemeral profile.",
          this.config.adapters.browserUse,
          approve,
          { allowed_domains: this.config.adapters.browserUse.allowedDomains },
        ),
      );
    }
    if (capabilities.has("computer_use") && this.config.adapters.computerUse.enabled) {
      tools.push(
        this.externalTool(turnId, "computer_use", "Control a computer through a configured trusted JSON adapter.", this.config.adapters.computerUse, approve),
      );
    }
    return tools;
  }

  private auditWorkspaceTool(event: WorkspaceToolAuditEvent): void {
    if (event.outcome === "requested") return;
    this.audit.write({
      action: `workspace.${event.capability}`,
      actor: "agent",
      target: event.target,
      outcome: event.outcome,
      ...(event.details ? { details: event.details } : {}),
    });
  }

  private externalTool(
    turnId: string,
    name: string,
    description: string,
    config: { enabled: boolean; command: string; envAllowlist: string[] },
    approve?: (description: string) => Promise<boolean>,
    fixedPayload: Record<string, unknown> = {},
  ): HostTool {
    return {
      name,
      description: `${description} Disabled adapters return a configuration error; use only after explicit approval.`,
      parameters: objectSchema({ task: { type: "string", minLength: 1, maxLength: 4_000 }, max_steps: { type: "integer", minimum: 1, maximum: 100 } }, [
        "task",
      ]),
      execute: async (arguments_, context) => {
        if (!config.enabled) throw new Error(`${name} adapter is disabled in .superai/config.json`);
        assertExactKeys(arguments_, ["task", "max_steps"]);
        const task = requireString(arguments_, "task", 4_000);
        const maxSteps = arguments_.max_steps === undefined ? undefined : requireInteger(arguments_, "max_steps", 1, 100);
        const effectiveEnvironment = adapterEnvironmentAllowlist(name, config.envAllowlist);
        const adapter = new CommandAdapter(config.command, 180_000, effectiveEnvironment, this.root);
        const decision = this.policy.assess(name, arguments_);
        const capabilityWarning =
          name === "computer_use"
            ? "WARNING: NOT AN OS SANDBOX. THIS NATIVE ADAPTER CAN OBSERVE, CLICK AND TYPE IN ANY APPLICATION AVAILABLE TO THE CURRENT DESKTOP USER."
            : "WARNING: NOT AN OS SANDBOX. THIS NATIVE BROWSER ADAPTER AND ITS DEPENDENCIES MAY ACCESS THE FILESYSTEM AND NETWORK; THE DOMAIN ALLOWLIST IS ENFORCED BY CODE YOU ARE TRUSTING.";
        const approvalDescription = `${capabilityWarning}\nEnvironment variable names exposed to the adapter=${JSON.stringify(effectiveEnvironment)}\n${decision.reason}\n${adapter.describeCommand()}\n${name} task=${JSON.stringify(task)}\nfixed adapter policy=${JSON.stringify(fixedPayload)}`;
        if (Buffer.byteLength(approvalDescription) > 7_500) throw new Error(`${name} approval payload is too large to display safely`);
        if (!approve || !(await approve(approvalDescription))) {
          throw new Error(`${name} was not approved`);
        }
        this.audit.write({
          action: `adapter.${name}`,
          actor: "agent",
          outcome: "allowed",
          details: { taskLength: task.length, taskHash: createHash("sha256").update(task).digest("hex") },
        });
        const payload = { task, ...(maxSteps === undefined ? {} : { max_steps: maxSteps }), ...fixedPayload };
        return this.recordedEffect(turnId, name, payload, context, async () => {
          const result = redactValue(await adapter.run(payload, context.signal)) as Record<string, unknown>;
          return textTool(JSON.stringify(result, null, 2), result);
        });
      },
    };
  }

  private async recordedEffect<T>(turnId: string, capability: string, arguments_: unknown, context: HostToolContext, run: () => Promise<T>): Promise<T> {
    const claimed = this.runtime.startEffect(turnId, context.toolCallId, capability, arguments_);
    if (!claimed) throw new Error(`Tool effect ${context.toolCallId} already exists; automatic replay is blocked`);
    try {
      const result = await run();
      this.runtime.finishEffect(turnId, context.toolCallId, "completed", result);
      return result;
    } catch (error) {
      this.runtime.finishEffect(turnId, context.toolCallId, "unknown");
      throw error;
    }
  }
}

function episodicExcerpt(value: string, maxCharacters: number): string {
  const text = redactSecrets(value).replace(/\s+/gu, " ").trim();
  if (text.length <= maxCharacters) return text;
  const marker = " … ";
  const available = Math.max(0, maxCharacters - marker.length);
  const head = Math.ceil(available * 0.65);
  const tail = available - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

function adapterEnvironmentAllowlist(name: string, configured: string[]): string[] {
  if (name !== "browser_task") return [...configured];
  if (process.env.BROWSER_USE_API_KEY?.trim()) return configured.filter((value) => value !== "OPENAI_API_KEY");
  if (process.env.OPENAI_API_KEY?.trim()) return configured.filter((value) => value !== "BROWSER_USE_API_KEY");
  return configured.filter((value) => value !== "BROWSER_USE_API_KEY" && value !== "OPENAI_API_KEY");
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function requireString(value: Record<string, unknown>, key: string, maxLength = 8_000): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) throw new Error(`${key} is required`);
  const trimmed = result.trim();
  if (trimmed.length > maxLength) throw new Error(`${key} exceeds ${maxLength} characters`);
  return trimmed;
}

function optionalString(value: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string") throw new Error(`${key} must be a string`);
  const trimmed = result.trim();
  if (trimmed.length > maxLength) throw new Error(`${key} exceeds ${maxLength} characters`);
  return trimmed;
}

function requireInteger(value: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function requireSkillId(value: Record<string, unknown>): string {
  const id = requireString(value, "id", 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(id)) throw new Error("id must be a lowercase skill identifier");
  return id;
}

function textTool(text: string, details: Record<string, unknown> = {}): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text }], details };
}

function boundedTextTool(
  text: string,
  maxBytes: number,
  details: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  const safeText = redactSecrets(text);
  const bytes = Buffer.from(safeText, "utf8");
  if (bytes.byteLength <= maxBytes) return textTool(safeText, { ...details, truncated: false });
  const notice = "\n[output truncated by Axiomux safety limits]";
  const body = bytes.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(notice))).toString("utf8");
  return textTool(`${body}${notice}`, { ...details, truncated: true });
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedSet.has(key));
  if (extra) throw new Error(`Unexpected tool argument: ${extra}`);
}

function invokeObserver<T>(observer: ((value: T) => void) | undefined, value: T): void {
  try {
    observer?.(value);
  } catch {
    /* Observers must never control provider or persistence state. */
  }
}

function formatMemory(memory: MemoryItem): string {
  return `[${memory.id}] ${memory.kind}/${memory.reviewStatus} confidence=${memory.confidence} source=${memory.sourceUri}\n${memory.content}`;
}

function classifyProviderError(error: Error): string {
  const message = error.message.toLocaleLowerCase();
  if (/\b(401|403)\b|invalid.*(token|key)|auth/.test(message)) return "auth";
  if (/\b429\b|rate.?limit|quota/.test(message)) return "rate_limit";
  if (/timeout|timed out/.test(message)) return "timeout";
  if (/econn|network|dns|socket|fetch failed/.test(message)) return "network";
  if (/abort|cancel|interrupt/.test(message)) return "cancelled";
  return "provider";
}

function validateUserText(value: string): string {
  const text = value.trim();
  if (!text || text.length > 200_000) throw new Error("User message must contain 1-200,000 characters");
  return text;
}

function validateTaskId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) throw new Error("Task ID must be 1-200 safe identifier characters");
  return id;
}

function validateWorkflowIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u.test(key)) {
    throw new Error("Workflow idempotency key must be 1-500 safe identifier characters");
  }
  return key;
}

function validateControlText(value: string): string {
  const text = value.trim();
  if (!text || text.length > 50_000) throw new Error("Control message must contain 1-50,000 characters");
  return text;
}

function validateModelSelector(value: string): string {
  const model = value.trim();
  if (!/^[^\s/]+\/.{1,220}$/.test(model) || /[\r\n\0]/.test(model)) throw new Error("Model must be provider/model");
  return model;
}

function mapFusionTelemetry(event: FusionTelemetryEvent): Omit<AgentTraceEvent, "at"> {
  const label =
    event.kind === "candidate"
      ? `Fusion consultant ${event.candidateIndex !== undefined ? event.candidateIndex + 1 : ""} ${event.phase}`.trim()
      : event.kind === "synthesis"
        ? `Fusion synthesis ${event.phase}`
        : `Fusion run ${event.phase}`;
  const details = [event.durationMs !== undefined ? `${event.durationMs}ms` : "", event.reason ? `reason=${event.reason}` : ""].filter(Boolean).join("; ");
  return {
    kind: "reasoning",
    phase: event.phase,
    label,
    ...(details ? { detail: details } : {}),
    ...(event.model ? { model: event.model } : {}),
  };
}
