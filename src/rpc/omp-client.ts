import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostTool, ModelInfo, ThinkingLevel } from "../types.js";
import { buildChildEnvironment } from "../security/environment.js";
import { resolveWindowsSystemExecutable } from "../security/executable.js";
import { redactSecrets } from "../security/secrets.js";
import { prepareOmpIsolation, type OmpIsolation } from "../security/omp-isolation.js";
import { verifyOmpRuntime } from "../security/omp-runtime.js";
import { writePrivateFileAtomic } from "../security/state.js";
import { WORKSPACE_HOST_TOOL_NAMES } from "../tools/names.js";

type JsonObject = Record<string, unknown>;

export { OMP_CONTRACT_VERSION } from "../security/omp-runtime.js";
const MAX_RPC_FRAME_BYTES = 1024 * 1024;
const MAX_HOST_TOOL_ARGUMENT_BYTES = 128 * 1024;
const MAX_ASSISTANT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_REASONING_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_HOST_TOOL_RESULT_BYTES = 256 * 1024;
const MAX_HOST_TOOL_REGISTRATION_BYTES = 512 * 1024;
const MAX_OUTBOUND_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_RPC_FRAMES_PER_OPERATION = 10_000;
const MAX_RPC_FRAMES_PER_PROCESS = 1_000_000;
const MAX_UI_REQUESTS_PER_OPERATION = 256;
const MAX_CONCURRENT_UI_REQUESTS = 8;
const MAX_HOST_TOOL_CALLS_PER_TURN = 64;
const MAX_CONCURRENT_HOST_TOOLS = 4;
const MAX_MUTATING_TOOL_CALLS_PER_NAME = 8;
const MAX_SYSTEM_PROMPT_CHARACTERS = process.platform === "win32" ? 24_000 : 256_000;
const MUTATING_HOST_TOOLS = new Set([
  WORKSPACE_HOST_TOOL_NAMES.edit,
  WORKSPACE_HOST_TOOL_NAMES.write,
  WORKSPACE_HOST_TOOL_NAMES.bash,
  WORKSPACE_HOST_TOOL_NAMES.python,
  "browser_task",
  "computer_use",
  "memory_remember",
  "skill_propose",
  "source_ingest",
]);

export interface OmpUiRequest extends JsonObject {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "cancel" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | "open_url";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  url?: string;
  launchUrl?: string;
  instructions?: string;
}

export type OmpUiHandler = (request: OmpUiRequest) => Promise<JsonObject | undefined>;

export interface OmpClientOptions {
  executable: string;
  /** Exact executable version whose discovery/approval contract was audited. */
  versionContract: string;
  /** Arguments inserted before OMP flags; used by wrappers and protocol tests. */
  extraArgs?: string[];
  cwd: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  profile?: string;
  approvalMode?: "always-ask";
  tools?: string[];
  envAllowlist?: string[];
  timeoutMs?: number;
  uiHandler?: OmpUiHandler;
  onEvent?: (event: JsonObject) => void;
  isolation?: OmpIsolation;
  onActivity?: (event: OmpActivityEvent) => void;
  /** Secrets/config injected directly into this child only; never persisted by the client. */
  environmentOverrides?: NodeJS.ProcessEnv;
  /** Allows provider discovery/login in a fresh isolated vault before any model is authenticated. */
  bootstrapWithoutModel?: boolean;
}

export interface OmpActivityEvent {
  kind: "reasoning" | "tool" | "provider" | "steering";
  phase: "started" | "progress" | "completed" | "failed" | "queued";
  label: string;
  detail?: string;
  tool?: string;
}

interface PendingRequest {
  resolve: (frame: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveTurn {
  text: string;
  toolCalls: number;
  resolve: (value: OmpTurnResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onDelta?: (delta: string) => void;
  reasoningCharacters: number;
  reasoningBytes: number;
  assistantBytes: number;
  seenToolRequestIds: Set<string>;
  mutatingToolCalls: Map<string, number>;
  finishing: boolean;
  inboundFrames: number;
}

export interface OmpTurnResult {
  text: string;
  toolCalls: number;
  consequentialApproval: boolean;
}

export class OmpRpcClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private requestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly tools = new Map<string, HostTool>();
  private readonly toolControllers = new Map<string, AbortController>();
  private readyPromise?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private activeTurn: ActiveTurn | undefined;
  private stderr = "";
  private consequentialApproval = false;
  private bootstrapModelPath: string | undefined;
  private systemPromptPath: string | undefined;
  private systemPromptHash: string | undefined;
  private stdoutDecoder: JsonlFrameDecoder | undefined;
  private protocolFailed = false;
  private lifetimeInboundFrames = 0;
  private idleOperationFrames = 0;
  private uiRequestCount = 0;
  private readonly seenUiRequestIds = new Set<string>();
  private readonly activeUiRequestIds = new Set<string>();
  private readonly outboundQueue: Array<{ data: string; bytes: number }> = [];
  private outboundQueueBytes = 0;
  private stdinBackpressured = false;
  private stopping = false;

  constructor(private readonly options: OmpClientOptions) {}

  get approvedConsequentialAction(): boolean {
    return this.consequentialApproval;
  }

  async start(): Promise<void> {
    if (this.process) return;
    this.protocolFailed = false;
    this.stopping = false;
    this.lifetimeInboundFrames = 0;
    this.idleOperationFrames = 0;
    this.resetUiRequestBudget();
    this.activeUiRequestIds.clear();
    this.clearOutboundQueue();
    validateChildEnvironmentOptions(this.options);
    if (this.options.isolation && this.options.profile?.trim()) {
      throw new Error("Named OMP profiles are incompatible with strict isolation because they bypass the isolated agent directory");
    }
    const unsafeEnvironment = this.options.envAllowlist?.find(isRuntimeControlEnvironmentName);
    if (this.options.isolation && unsafeEnvironment) {
      throw new Error(`OMP strict isolation refuses runtime-control environment variable ${unsafeEnvironment}`);
    }
    rejectExecutableExtensionArgs(this.options.extraArgs ?? [], Boolean(this.options.isolation));
    const prepared = this.options.isolation ? prepareOmpIsolation(this.options.isolation, this.options.cwd, this.options.tools ?? []) : undefined;
    const isolatedBaseEnvironment: NodeJS.ProcessEnv = {
      NO_COLOR: "1",
      ...(this.options.isolation
        ? {
            HOME: this.options.isolation.homeDir,
            USERPROFILE: this.options.isolation.homeDir,
            APPDATA: join(this.options.isolation.homeDir, "AppData", "Roaming"),
            LOCALAPPDATA: join(this.options.isolation.homeDir, "AppData", "Local"),
            XDG_CONFIG_HOME: join(this.options.isolation.homeDir, ".config"),
            PI_CODING_AGENT_DIR: this.options.isolation.agentDir,
            // Never import credentials from globally installed desktop apps into
            // the isolated Axiomux vault (notably Perplexity on macOS).
            PI_AUTH_NO_BORROW: "1",
          }
        : {}),
    };
    for (const directory of [isolatedBaseEnvironment.APPDATA, isolatedBaseEnvironment.LOCALAPPDATA, isolatedBaseEnvironment.XDG_CONFIG_HOME]) {
      if (directory) mkdirSync(directory, { recursive: true });
    }
    verifyOmpRuntime(
      this.options.executable,
      this.options.versionContract,
      prepared?.launchDir ?? this.options.cwd,
      buildChildEnvironment([], isolatedBaseEnvironment),
    );
    if (this.options.bootstrapWithoutModel && this.options.isolation) {
      cleanupOrphanedLoginBootstrap(this.options.isolation.agentDir);
      this.bootstrapModelPath = createLoginBootstrapModel(this.options.isolation.agentDir);
    }
    const args = [
      ...(this.options.extraArgs ?? []),
      "--mode",
      "rpc",
      "--cwd",
      this.options.cwd,
      ...(prepared ? ["--config", prepared.safetyConfigPath] : []),
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--no-pty",
      "--approval-mode",
      this.options.approvalMode ?? "always-ask",
    ];
    if (this.options.tools) {
      if (this.options.tools.length) args.push("--tools", this.options.tools.join(","));
      else args.push("--no-tools");
    }
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.thinkingLevel) args.push("--thinking", this.options.thinkingLevel);
    if (this.options.systemPrompt) args.push("--system-prompt", this.stageSystemPrompt());
    if (this.options.profile) args.push("--profile", this.options.profile);

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const child = spawn(this.options.executable, args, {
      // OMP imports dotenv before applying --cwd. Launching from this empty,
      // private directory prevents a project .env from bypassing our env allowlist.
      cwd: prepared?.launchDir ?? this.options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildChildEnvironment(this.options.envAllowlist, {
        ...isolatedBaseEnvironment,
        ...(this.options.environmentOverrides ?? {}),
      }),
    });
    this.process = child;
    this.stdoutDecoder = new JsonlFrameDecoder(
      MAX_RPC_FRAME_BYTES,
      (frame) => this.handleFrame(frame),
      (error) => this.protocolFailure(error),
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-12_000);
    });
    child.stdout.on("data", (chunk) => {
      this.stdoutDecoder?.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.stdout.on("end", () => this.stdoutDecoder?.end());
    child.stdin.on("error", (error) => {
      if (!this.stopping && this.process === child) this.protocolFailure(new Error(`OMP RPC stdin failed: ${redactSecrets(error.message)}`));
    });
    child.on("error", (error) => {
      this.failAll(error);
      this.cleanupSystemPrompt();
    });
    child.on("exit", (code) => {
      if (code !== 0 || this.pending.size || this.activeTurn) {
        this.failAll(new Error(`OMP RPC exited with code ${code}. ${redactSecrets(this.stderr.trim())}`));
      }
      this.abortHostTools(true);
      this.clearOutboundQueue();
      this.process = undefined;
      this.stopping = false;
      this.cleanupBootstrapModel();
      this.cleanupSystemPrompt();
    });
    const timeout = setTimeout(() => this.readyReject?.(new Error(`OMP RPC did not become ready. ${redactSecrets(this.stderr.trim())}`)), 20_000);
    try {
      await this.readyPromise;
      // OMP resolves --system-prompt before emitting ready; the private file is
      // no longer needed and must not retain recalled memory on disk.
      this.cleanupSystemPrompt();
    } catch (error) {
      this.cleanupBootstrapModel();
      this.cleanupSystemPrompt();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abortHostTools(true);
    this.clearOutboundQueue();
    this.activeUiRequestIds.clear();
    if (!this.process) {
      this.cleanupBootstrapModel();
      this.cleanupSystemPrompt();
      return;
    }
    this.process.stdin.end();
    const child = this.process;
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          terminateProcessTree(child);
          resolve();
        }, 3_000),
      ),
    ]);
    this.process = undefined;
    this.cleanupBootstrapModel();
    this.cleanupSystemPrompt();
  }

  async registerTools(tools: HostTool[]): Promise<void> {
    if (tools.length > 128) throw new Error("At most 128 host tools may be registered");
    const names = new Set<string>();
    for (const tool of tools) {
      validateHostToolDefinition(tool);
      if (names.has(tool.name) || this.tools.has(tool.name)) throw new Error(`Duplicate host tool name: ${tool.name}`);
      names.add(tool.name);
    }
    if (tools.length === 0) return;
    const definitions = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      loadMode: tool.loadMode ?? "discoverable",
    }));
    if (Buffer.byteLength(JSON.stringify(definitions), "utf8") > MAX_HOST_TOOL_REGISTRATION_BYTES) {
      throw new Error(`Host tool registration exceeded ${MAX_HOST_TOOL_REGISTRATION_BYTES} bytes`);
    }
    await this.request({ type: "set_host_tools", tools: definitions });
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  async prompt(message: string, onDelta?: (delta: string) => void): Promise<OmpTurnResult> {
    if (this.activeTurn) throw new Error("An OMP turn is already active");
    this.consequentialApproval = false;
    this.resetUiRequestBudget();
    const timeoutMs = this.options.timeoutMs ?? 900_000;
    const resultPromise = new Promise<OmpTurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.activeTurn?.timer !== timer) return;
        this.activeTurn = undefined;
        this.abortHostTools();
        void this.request({ type: "abort" }, 5_000).catch(() => terminateProcessTree(this.process));
        reject(new Error(`OMP turn timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.activeTurn = {
        text: "",
        toolCalls: 0,
        reasoningCharacters: 0,
        reasoningBytes: 0,
        assistantBytes: 0,
        seenToolRequestIds: new Set(),
        mutatingToolCalls: new Map(),
        finishing: false,
        inboundFrames: 0,
        resolve,
        reject,
        timer,
        ...(onDelta ? { onDelta } : {}),
      };
    });
    try {
      const response = await this.request({ type: "prompt", message }, 30_000);
      if (response.success === false) {
        this.rejectTurn(new Error(String(response.error ?? "OMP rejected the prompt")));
      }
    } catch (error) {
      this.rejectTurn(error instanceof Error ? error : new Error(String(error)));
    }
    return resultPromise;
  }

  get turnActive(): boolean {
    return this.activeTurn !== undefined;
  }

  async steer(message: string): Promise<void> {
    if (!this.activeTurn) throw new Error("No active OMP turn to steer");
    const text = validateControlMessage(message);
    await this.request({ type: "steer", message: text });
    this.emitActivity({ kind: "steering", phase: "queued", label: "User update steered into the active run" });
  }

  async followUp(message: string): Promise<void> {
    const text = validateControlMessage(message);
    await this.request({ type: "follow_up", message: text });
    this.emitActivity({ kind: "steering", phase: "queued", label: "Follow-up queued after the active run" });
  }

  async abort(): Promise<void> {
    if (!this.process) return;
    await this.request({ type: "abort" });
    this.emitActivity({ kind: "steering", phase: "completed", label: "Active run interrupted by explicit user request" });
  }

  async getModels(): Promise<ModelInfo[]> {
    const response = await this.request({ type: "get_available_models" });
    try {
      return validateModelList((response.data as JsonObject | undefined)?.models);
    } catch (error) {
      const protocolError = new Error(`Invalid OMP model catalog: ${error instanceof Error ? error.message : String(error)}`);
      this.protocolFailure(protocolError);
      throw protocolError;
    }
  }

  async setModel(selector: string): Promise<void> {
    const [provider, ...rest] = selector.split("/");
    const modelId = rest.join("/");
    if (!provider || !modelId) throw new Error("Model must be provider/model");
    const response = await this.request({ type: "set_model", provider, modelId });
    if (response.success === false) throw new Error(String(response.error));
  }

  async getLoginProviders(): Promise<Array<{ id: string; name: string; available: boolean; authenticated: boolean }>> {
    const response = await this.request({ type: "get_login_providers" });
    try {
      return validateLoginProviderList((response.data as JsonObject | undefined)?.providers);
    } catch (error) {
      const protocolError = new Error(`Invalid OMP login provider list: ${error instanceof Error ? error.message : String(error)}`);
      this.protocolFailure(protocolError);
      throw protocolError;
    }
  }

  async login(providerId: string): Promise<void> {
    this.resetUiRequestBudget();
    const response = await this.request({ type: "login", providerId }, 660_000);
    if (response.success === false) throw new Error(String(response.error));
  }

  private request(command: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
    if (this.protocolFailed) throw new Error("OMP RPC protocol is in a failed state");
    if (!this.process?.stdin.writable) throw new Error("OMP RPC is not running");
    if (!this.activeTurn) this.idleOperationFrames = 0;
    const id = `superai_${++this.requestId}`;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for OMP ${String(command.type)}. ${redactSecrets(this.stderr.trim())}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ ...command, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleFrame(bytes: Buffer): void {
    if (this.protocolFailed) return;
    let frame: JsonObject;
    try {
      const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = JSON.parse(line) as unknown;
      frame = validateIncomingFrame(parsed);
    } catch (error) {
      this.protocolFailure(new Error(`Invalid OMP RPC frame: ${redactSecrets(error instanceof Error ? error.message : String(error))}`));
      return;
    }
    if (!this.consumeInboundFrameQuota()) return;
    if (frame.type === "ready") {
      this.readyResolve?.();
      return;
    }
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.success === false) pending.reject(new Error(String(frame.error ?? `OMP ${String(frame.command)} failed`)));
        else pending.resolve(frame);
      }
      return;
    }
    if (frame.type === "host_tool_call") {
      void this.handleToolCall(frame);
      return;
    }
    if (frame.type === "host_tool_cancel") {
      this.cancelHostTool(frame.targetId as string);
      return;
    }
    if (frame.type === "extension_ui_request") {
      const request = frame as OmpUiRequest;
      if (!this.reserveUiRequest(request.id)) return;
      void this.handleUiRequest(request).finally(() => this.activeUiRequestIds.delete(request.id));
      return;
    }
    this.emitEvent(frame);
    if (frame.type === "message_end" && this.activeTurn) {
      const message = frame.message as JsonObject | undefined;
      if (message?.role === "assistant" && message.stopReason === "error") {
        const status = typeof message.errorStatus === "number" ? `HTTP ${message.errorStatus}: ` : "";
        this.rejectTurn(new Error(`${status}${String(message.errorMessage ?? "Provider returned an error")}`));
        return;
      }
    }
    if (frame.type === "message_update" && this.activeTurn) {
      const event = frame.assistantMessageEvent as JsonObject | undefined;
      if (event?.type === "text_delta" && typeof event.delta === "string") {
        const deltaBytes = Buffer.byteLength(event.delta, "utf8");
        if (this.activeTurn.assistantBytes + deltaBytes > MAX_ASSISTANT_OUTPUT_BYTES) {
          this.protocolFailure(new Error(`OMP assistant output exceeded ${MAX_ASSISTANT_OUTPUT_BYTES} bytes in one turn`));
          return;
        }
        this.activeTurn.assistantBytes += deltaBytes;
        this.activeTurn.text += event.delta;
        this.emitDelta(this.activeTurn, event.delta);
      }
      if (event?.type === "thinking_start") {
        this.emitActivity({ kind: "reasoning", phase: "started", label: "Provider reasoning started" });
      } else if (event?.type === "thinking_delta" && typeof event.delta === "string") {
        const reasoningBytes = Buffer.byteLength(event.delta, "utf8");
        if (this.activeTurn.reasoningBytes + reasoningBytes > MAX_REASONING_STREAM_BYTES) {
          this.protocolFailure(new Error(`OMP reasoning stream exceeded ${MAX_REASONING_STREAM_BYTES} bytes in one turn`));
          return;
        }
        this.activeTurn.reasoningBytes += reasoningBytes;
        this.activeTurn.reasoningCharacters += event.delta.length;
        if (this.activeTurn.reasoningCharacters % 800 < event.delta.length) {
          this.emitActivity({
            kind: "reasoning",
            phase: "progress",
            label: "Provider reasoning in progress",
            detail: `${this.activeTurn.reasoningCharacters} private reasoning characters processed`,
          });
        }
      } else if (event?.type === "thinking_end") {
        this.emitActivity({
          kind: "reasoning",
          phase: "completed",
          label: "Provider reasoning completed",
          detail: `${this.activeTurn.reasoningCharacters} private reasoning characters processed; content not persisted`,
        });
      }
    }
    if (frame.type === "agent_end" && this.activeTurn) void this.finishTurn();
  }

  private async finishTurn(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn || turn.finishing) return;
    turn.finishing = true;
    try {
      const response = await this.request({ type: "get_last_assistant_text" });
      const data = response.data as { text?: string | null } | undefined;
      const text = data?.text?.trim() || turn.text.trim();
      if (Buffer.byteLength(text, "utf8") > MAX_ASSISTANT_OUTPUT_BYTES) {
        throw new Error(`OMP assistant output exceeded ${MAX_ASSISTANT_OUTPUT_BYTES} bytes in one turn`);
      }
      clearTimeout(turn.timer);
      this.activeTurn = undefined;
      turn.resolve({ text, toolCalls: turn.toolCalls, consequentialApproval: this.consequentialApproval });
    } catch (error) {
      turn.finishing = false;
      this.rejectTurn(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async handleToolCall(frame: JsonObject): Promise<void> {
    const id = frame.id as string;
    const name = frame.toolName as string;
    const toolCallId = frame.toolCallId as string;
    const turn = this.activeTurn;
    if (!turn) {
      this.protocolFailure(new Error("OMP requested a host tool outside an active turn"));
      return;
    }
    if (turn.seenToolRequestIds.has(id) || this.toolControllers.has(id)) {
      this.protocolFailure(new Error(`OMP reused host tool request id ${id}`));
      return;
    }
    turn.seenToolRequestIds.add(id);
    turn.toolCalls += 1;
    if (turn.toolCalls > MAX_HOST_TOOL_CALLS_PER_TURN) {
      this.protocolFailure(new Error(`OMP exceeded ${MAX_HOST_TOOL_CALLS_PER_TURN} host tool calls in one turn`));
      return;
    }
    const normalizedName = name.toLowerCase();
    if (MUTATING_HOST_TOOLS.has(normalizedName)) {
      const count = (turn.mutatingToolCalls.get(normalizedName) ?? 0) + 1;
      turn.mutatingToolCalls.set(normalizedName, count);
      if (count > MAX_MUTATING_TOOL_CALLS_PER_NAME) {
        this.safeWrite({ type: "host_tool_result", id, isError: true, result: textResult(`Host tool mutation quota exceeded for ${name}`) });
        return;
      }
    }
    if (this.toolControllers.size >= MAX_CONCURRENT_HOST_TOOLS) {
      this.safeWrite({
        type: "host_tool_result",
        id,
        isError: true,
        result: textResult(`Host tool concurrency limit of ${MAX_CONCURRENT_HOST_TOOLS} reached`),
      });
      return;
    }
    const tool = this.tools.get(name);
    if (!tool) {
      this.safeWrite({ type: "host_tool_result", id, isError: true, result: textResult(`Host tool not registered: ${name}`) });
      return;
    }
    this.emitActivity({ kind: "tool", phase: "started", label: `Tool ${name}`, tool: name });
    const controller = new AbortController();
    this.toolControllers.set(id, controller);
    let result: unknown;
    let isError = false;
    try {
      result = await tool.execute(frame.arguments as Record<string, unknown>, {
        toolCallId,
        signal: controller.signal,
      });
    } catch (error) {
      isError = true;
      result = textResult(redactSecrets(error instanceof Error ? error.message : String(error)));
    } finally {
      if (this.toolControllers.get(id) === controller) this.toolControllers.delete(id);
    }
    if (controller.signal.aborted) return;
    const boundedResult = normalizeHostToolResult(result);
    result = boundedResult.result;
    if (boundedResult.isError) isError = true;
    this.emitActivity({ kind: "tool", phase: isError ? "failed" : "completed", label: `Tool ${name}`, tool: name });
    this.safeWrite({ type: "host_tool_result", id, ...(isError ? { isError: true } : {}), result });
  }

  private cancelHostTool(targetId: string): void {
    const controller = this.toolControllers.get(targetId);
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    this.emitActivity({ kind: "tool", phase: "failed", label: "Host tool cancelled by OMP" });
  }

  private async handleUiRequest(request: OmpUiRequest): Promise<void> {
    try {
      if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url", "cancel"].includes(request.method)) {
        await this.options.uiHandler?.(request);
        return;
      }
      const response = await this.options.uiHandler?.(request);
      if (isConsequentialApproval(request, response)) this.consequentialApproval = true;
      this.safeWrite({ type: "extension_ui_response", id: request.id, ...(response ?? { cancelled: true }) });
    } catch {
      this.safeWrite({ type: "extension_ui_response", id: request.id, cancelled: true });
    }
  }

  private write(frame: JsonObject): void {
    if (this.protocolFailed) throw new Error("OMP RPC protocol is in a failed state");
    if (!this.process?.stdin.writable) throw new Error("OMP RPC stdin is closed");
    const data = `${JSON.stringify(frame)}\n`;
    const bytes = Buffer.byteLength(data, "utf8");
    if (this.stdinBackpressured) {
      if (this.outboundQueueBytes + bytes > MAX_OUTBOUND_QUEUE_BYTES) {
        const error = new Error(`OMP RPC outbound queue exceeded ${MAX_OUTBOUND_QUEUE_BYTES} bytes`);
        this.protocolFailure(error);
        throw error;
      }
      this.outboundQueue.push({ data, bytes });
      this.outboundQueueBytes += bytes;
      return;
    }
    this.writeToStdin(data);
  }

  private safeWrite(frame: JsonObject): void {
    try {
      this.write(frame);
    } catch (error) {
      if (!this.stopping) this.protocolFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectTurn(error: Error): void {
    const turn = this.activeTurn;
    if (!turn) return;
    clearTimeout(turn.timer);
    this.activeTurn = undefined;
    this.abortHostTools();
    turn.reject(error);
  }

  private failAll(error: Error): void {
    this.readyReject?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.rejectTurn(error);
  }

  private abortHostTools(clear = false): void {
    for (const controller of this.toolControllers.values()) controller.abort();
    if (clear) this.toolControllers.clear();
  }

  private protocolFailure(error: Error): void {
    if (this.protocolFailed) return;
    this.protocolFailed = true;
    this.failAll(error);
    this.abortHostTools(true);
    this.clearOutboundQueue();
    terminateProcessTree(this.process);
  }

  private consumeInboundFrameQuota(): boolean {
    this.lifetimeInboundFrames += 1;
    if (this.lifetimeInboundFrames > MAX_RPC_FRAMES_PER_PROCESS) {
      this.protocolFailure(new Error(`OMP exceeded ${MAX_RPC_FRAMES_PER_PROCESS} RPC frames in one process`));
      return false;
    }
    if (this.activeTurn) {
      this.activeTurn.inboundFrames += 1;
      if (this.activeTurn.inboundFrames > MAX_RPC_FRAMES_PER_OPERATION) {
        this.protocolFailure(new Error(`OMP exceeded ${MAX_RPC_FRAMES_PER_OPERATION} RPC frames in one turn`));
        return false;
      }
    } else {
      this.idleOperationFrames += 1;
      if (this.idleOperationFrames > MAX_RPC_FRAMES_PER_OPERATION) {
        this.protocolFailure(new Error(`OMP exceeded ${MAX_RPC_FRAMES_PER_OPERATION} RPC frames in one operation`));
        return false;
      }
    }
    return true;
  }

  private reserveUiRequest(id: string): boolean {
    this.uiRequestCount += 1;
    if (this.uiRequestCount > MAX_UI_REQUESTS_PER_OPERATION) {
      this.protocolFailure(new Error(`OMP exceeded ${MAX_UI_REQUESTS_PER_OPERATION} UI requests in one operation`));
      return false;
    }
    if (this.seenUiRequestIds.has(id) || this.activeUiRequestIds.has(id)) {
      this.protocolFailure(new Error(`OMP reused extension UI request id ${id}`));
      return false;
    }
    if (this.activeUiRequestIds.size >= MAX_CONCURRENT_UI_REQUESTS) {
      this.protocolFailure(new Error(`OMP exceeded ${MAX_CONCURRENT_UI_REQUESTS} concurrent UI requests`));
      return false;
    }
    this.seenUiRequestIds.add(id);
    this.activeUiRequestIds.add(id);
    return true;
  }

  private resetUiRequestBudget(): void {
    this.uiRequestCount = 0;
    this.seenUiRequestIds.clear();
  }

  private writeToStdin(data: string): void {
    const stream = this.process?.stdin;
    if (!stream?.writable) throw new Error("OMP RPC stdin is closed");
    const accepted = stream.write(data, (error) => {
      if (error && !this.stopping) this.protocolFailure(new Error(`OMP RPC stdin write failed: ${redactSecrets(error.message)}`));
    });
    if (accepted) return;
    this.stdinBackpressured = true;
    stream.once("drain", () => {
      if (this.process?.stdin !== stream || this.protocolFailed || this.stopping) return;
      this.stdinBackpressured = false;
      this.flushOutboundQueue();
    });
  }

  private flushOutboundQueue(): void {
    while (!this.stdinBackpressured && this.outboundQueue.length > 0) {
      const next = this.outboundQueue.shift();
      if (!next) break;
      this.outboundQueueBytes -= next.bytes;
      try {
        this.writeToStdin(next.data);
      } catch (error) {
        this.protocolFailure(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private clearOutboundQueue(): void {
    this.outboundQueue.length = 0;
    this.outboundQueueBytes = 0;
    this.stdinBackpressured = false;
  }

  private emitActivity(event: OmpActivityEvent): void {
    invokeProtectedCallback(() => this.options.onActivity?.(event));
  }

  private emitEvent(event: JsonObject): void {
    invokeProtectedCallback(() => this.options.onEvent?.(event));
  }

  private emitDelta(turn: ActiveTurn, delta: string): void {
    invokeProtectedCallback(() => turn.onDelta?.(delta));
  }

  private cleanupBootstrapModel(): void {
    const path = this.bootstrapModelPath;
    this.bootstrapModelPath = undefined;
    if (!path) return;
    try {
      if (readFileSync(path, "utf8") === LOGIN_BOOTSTRAP_YAML) rmSync(path, { force: true });
    } catch {
      // A concurrent process or user replaced it; never delete content we do not own.
    }
  }

  private stageSystemPrompt(): string {
    const prompt = this.options.systemPrompt;
    if (!prompt) throw new Error("System prompt is empty");
    if (!this.options.isolation) {
      if (prompt.length > MAX_SYSTEM_PROMPT_CHARACTERS) {
        throw new Error(`System prompt exceeds the safe local process argument limit (${MAX_SYSTEM_PROMPT_CHARACTERS} characters)`);
      }
      return prompt;
    }
    const path = join(this.options.isolation.agentDir, `.superai-system-prompt-${randomUUID()}.md`);
    writePrivateFileAtomic(path, prompt);
    this.systemPromptPath = path;
    this.systemPromptHash = createHash("sha256").update(prompt, "utf8").digest("hex");
    return path;
  }

  private cleanupSystemPrompt(): void {
    const path = this.systemPromptPath;
    const expectedHash = this.systemPromptHash;
    this.systemPromptPath = undefined;
    this.systemPromptHash = undefined;
    if (!path || !expectedHash) return;
    try {
      const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (actualHash === expectedHash) rmSync(path, { force: true });
    } catch {
      // Never delete a path whose content no longer matches this client.
    }
  }
}

function validateChildEnvironmentOptions(options: OmpClientOptions): void {
  const allowlistedProviderSecret = options.envAllowlist?.find((name) => name.toUpperCase() === "NEURALWATT_API_KEY");
  if (allowlistedProviderSecret) {
    throw new Error("OMP environment allowlist cannot expose the Neuralwatt provider secret to every model child");
  }
  for (const [name, value] of Object.entries(options.environmentOverrides ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_()]{0,127}$/.test(name)) throw new Error(`OMP child environment override name is invalid: ${name}`);
    if (isRuntimeControlEnvironmentName(name)) throw new Error(`OMP child environment override cannot replace runtime-control variable ${name}`);
    if (name.toUpperCase() === "NEURALWATT_API_KEY" && options.model?.split("/", 1)[0]?.toLowerCase() !== "neuralwatt") {
      throw new Error("Neuralwatt credential may only be injected into a Neuralwatt model child");
    }
    if (value !== undefined && (value.length > 16_384 || value.includes("\0"))) {
      throw new Error(`OMP child environment override ${name} exceeded the safe value limit`);
    }
  }
}

function isRuntimeControlEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return (
    ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"].includes(normalized) ||
    normalized.startsWith("OMP_") ||
    normalized.startsWith("PI_") ||
    normalized.startsWith("NODE_") ||
    normalized.startsWith("BUN_")
  );
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}

function normalizeHostToolResult(value: unknown): { result: JsonObject; isError: boolean } {
  try {
    validatePlainJsonObjectPayload(value, "host tool result", MAX_HOST_TOOL_RESULT_BYTES);
    if (!Array.isArray(value.content) || value.content.length > 128) {
      throw new Error("result must contain at most 128 content blocks");
    }
    for (const block of value.content) {
      if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") {
        throw new Error("only text content blocks are supported");
      }
    }
    if (value.details !== undefined && !isPlainObject(value.details)) throw new Error("details must be a plain object");
    const serialized = JSON.stringify(value);
    const normalized = JSON.parse(serialized) as unknown;
    if (!isPlainObject(normalized)) throw new Error("serialized result was not an object");
    return { result: normalized, isError: false };
  } catch (error) {
    const reason = redactSecrets(error instanceof Error ? error.message : String(error));
    return { result: textResult(`Host tool result rejected by RPC boundary: ${reason}`), isError: true };
  }
}

function validateHostToolDefinition(tool: HostTool): void {
  validateBoundedIdentifierValue(tool.name, "host tool name", 128);
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(tool.name)) throw new Error(`Host tool name contains unsupported characters: ${tool.name}`);
  validateDisplayText(tool.description, `host tool ${tool.name} description`, 64 * 1024);
  validatePlainJsonObjectPayload(tool.parameters, `host tool ${tool.name} parameters`, MAX_HOST_TOOL_ARGUMENT_BYTES);
  if (tool.loadMode !== undefined && tool.loadMode !== "always" && tool.loadMode !== "discoverable") {
    throw new Error(`Host tool ${tool.name} has an invalid load mode`);
  }
  if (typeof tool.execute !== "function") throw new Error(`Host tool ${tool.name} has no executable handler`);
}

class JsonlFrameDecoder {
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private failed = false;

  constructor(
    private readonly maximumFrameBytes: number,
    private readonly onFrame: (frame: Buffer) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.failed || chunk.length === 0) return;
    let offset = 0;
    while (offset < chunk.length && !this.failed) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segmentLength = end - offset;
      if (this.bufferedBytes + segmentLength > this.maximumFrameBytes) {
        this.fail(new Error(`OMP RPC frame exceeded ${this.maximumFrameBytes} bytes`));
        return;
      }
      if (segmentLength > 0) {
        this.chunks.push(chunk.subarray(offset, end));
        this.bufferedBytes += segmentLength;
      }
      if (newline === -1) return;
      this.emitFrame();
      offset = newline + 1;
    }
  }

  end(): void {
    if (this.failed || this.bufferedBytes === 0) return;
    this.fail(new Error("OMP RPC stdout ended with an unterminated JSONL frame"));
  }

  private emitFrame(): void {
    const first = this.chunks[0];
    let frame = this.chunks.length === 1 && first ? first : Buffer.concat(this.chunks, this.bufferedBytes);
    this.chunks.length = 0;
    this.bufferedBytes = 0;
    if (frame.length > 0 && frame[frame.length - 1] === 0x0d) frame = frame.subarray(0, -1);
    if (frame.length === 0) {
      this.fail(new Error("OMP RPC emitted an empty JSONL frame"));
      return;
    }
    this.onFrame(frame);
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.chunks.length = 0;
    this.bufferedBytes = 0;
    this.onError(error);
  }
}

function validateIncomingFrame(value: unknown): JsonObject {
  if (!isPlainObject(value)) throw new Error("frame must be a plain JSON object");
  rejectPrototypeKeys(value, "frame");
  validateIdentifier(value, "type", true);
  for (const field of ["id", "toolName", "toolCallId", "targetId"] as const) {
    validateIdentifier(value, field, false);
  }
  if (value.type === "host_tool_call") {
    validateIdentifier(value, "id", true);
    validateIdentifier(value, "toolName", true);
    validateIdentifier(value, "toolCallId", true);
    validateHostToolArguments(value.arguments);
  } else if (value.type === "host_tool_cancel") {
    validateIdentifier(value, "targetId", true);
  } else if (value.type === "extension_ui_request") {
    validateIdentifier(value, "id", true);
    validateIdentifier(value, "method", true);
    const allowed = new Set(["select", "confirm", "input", "editor", "cancel", "notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"]);
    if (!allowed.has(value.method as string)) throw new Error("extension_ui_request.method is unsupported");
    validateOptionalDisplayText(value, "title", 2_048);
    validateOptionalDisplayText(value, "message", 64 * 1024);
    validateOptionalDisplayText(value, "placeholder", 16 * 1024);
    validateOptionalDisplayText(value, "prefill", 128 * 1024);
    validateOptionalDisplayText(value, "url", 64 * 1024);
    validateOptionalDisplayText(value, "launchUrl", 64 * 1024);
    validateOptionalDisplayText(value, "instructions", 64 * 1024);
    if (value.options !== undefined) {
      if (!Array.isArray(value.options) || value.options.length > 256) throw new Error("extension_ui_request.options must contain at most 256 strings");
      for (const option of value.options) validateDisplayText(option, "extension_ui_request option", 4_096);
    }
  }
  return value;
}

function validateModelList(value: unknown): ModelInfo[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2_048) throw new Error("models must be an array of at most 2048 entries");
  const models: ModelInfo[] = [];
  for (const candidate of value) {
    if (!isPlainObject(candidate)) throw new Error("model entry must be a plain object");
    const provider = validateBoundedIdentifierValue(candidate.provider, "model.provider", 256);
    const id = validateBoundedIdentifierValue(candidate.id, "model.id", 512);
    if (provider === "superai-bootstrap") continue;
    const model: ModelInfo = { provider, id, selector: `${provider}/${id}` };
    if (candidate.name !== undefined) model.name = validateDisplayText(candidate.name, "model.name", 1_024);
    if (candidate.contextWindow !== undefined) {
      if (
        candidate.contextWindow !== null &&
        (typeof candidate.contextWindow !== "number" || !Number.isSafeInteger(candidate.contextWindow) || candidate.contextWindow < 0)
      ) {
        throw new Error("model.contextWindow must be a non-negative safe integer or null");
      }
      model.contextWindow = candidate.contextWindow as number | null;
    }
    if (candidate.reasoning !== undefined) {
      if (typeof candidate.reasoning !== "boolean") throw new Error("model.reasoning must be boolean");
      model.reasoning = candidate.reasoning;
    }
    if (candidate.input !== undefined) {
      if (!Array.isArray(candidate.input) || candidate.input.length > 16) throw new Error("model.input must contain at most 16 entries");
      model.input = candidate.input.map((input) => validateBoundedIdentifierValue(input, "model.input", 64));
    }
    models.push(model);
  }
  return models;
}

function validateLoginProviderList(value: unknown): Array<{ id: string; name: string; available: boolean; authenticated: boolean }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw new Error("providers must be an array of at most 256 entries");
  return value.map((candidate) => {
    if (!isPlainObject(candidate)) throw new Error("login provider entry must be a plain object");
    const id = validateBoundedIdentifierValue(candidate.id, "provider.id", 256);
    const name = validateDisplayText(candidate.name, "provider.name", 1_024);
    if (typeof candidate.available !== "boolean" || typeof candidate.authenticated !== "boolean") {
      throw new Error("provider availability and authentication flags must be boolean");
    }
    return { id, name, available: candidate.available, authenticated: candidate.authenticated };
  });
}

function validateBoundedIdentifierValue(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} must be a safe string of 1-${maximumLength} characters`);
  }
  return value;
}

function validateOptionalDisplayText(object: JsonObject, field: string, maximumBytes: number): void {
  if (object[field] === undefined) return;
  validateDisplayText(object[field], `extension_ui_request.${field}`, maximumBytes);
}

function validateDisplayText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} must be safe text of at most ${maximumBytes} bytes`);
  }
  return value;
}

function validateIdentifier(object: JsonObject, field: string, required: boolean): void {
  const value = object[field];
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${field} must be a safe control-free string of 1-256 characters`);
  }
}

function validateHostToolArguments(value: unknown): asserts value is Record<string, unknown> {
  validatePlainJsonObjectPayload(value, "host tool arguments", MAX_HOST_TOOL_ARGUMENT_BYTES);
}

function validatePlainJsonObjectPayload(value: unknown, label: string, maximumBytes: number): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain JSON object`);
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > 20_000 || current.depth > 64) throw new Error(`${label} is too deeply or broadly nested`);
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) throw new Error(`${label} contains a non-finite number`);
      continue;
    }
    if (!Array.isArray(current.value) && !isPlainObject(current.value)) throw new Error(`${label} contains a non-plain object`);
    if (!Array.isArray(current.value)) rejectPrototypeKeys(current.value, label);
    for (const key of Reflect.ownKeys(current.value)) {
      if (Array.isArray(current.value) && key === "length") continue;
      if (typeof key === "symbol") throw new Error(`${label} contains a symbol key`);
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor || descriptor.get || descriptor.set) throw new Error(`${label} contains an accessor property`);
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeded ${maximumBytes} bytes`);
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function rejectPrototypeKeys(object: JsonObject, label: string): void {
  for (const key of Object.keys(object)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`${label} contains forbidden prototype key ${key}`);
    }
  }
}

function invokeProtectedCallback(callback: () => unknown): void {
  try {
    const result = callback();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Embedding callbacks are observers; they cannot corrupt the RPC state machine.
  }
}

function validateControlMessage(message: string): string {
  const text = message.trim();
  if (!text || text.length > 50_000) throw new Error("Steering message must contain 1-50,000 characters");
  return text;
}

const LOGIN_BOOTSTRAP_YAML = `# Temporary Axiomux provider-login bootstrap; contains no credentials.\nproviders:\n  superai-bootstrap:\n    baseUrl: http://127.0.0.1:9/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: login-bootstrap\n        name: Axiomux login bootstrap\n        api: openai-completions\n        reasoning: false\n        input: [text]\n        contextWindow: 4096\n        maxTokens: 1024\n        cost:\n          input: 0\n          output: 0\n          cacheRead: 0\n          cacheWrite: 0\n`;

function createLoginBootstrapModel(agentDir: string): string | undefined {
  mkdirSync(agentDir, { recursive: true });
  for (const name of ["models.yml", "models.yaml", "models.json"]) {
    if (existsSync(join(agentDir, name))) return undefined;
  }
  const path = join(agentDir, "models.yml");
  try {
    writeFileSync(path, LOGIN_BOOTSTRAP_YAML, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

function cleanupOrphanedLoginBootstrap(agentDir: string): void {
  const path = join(agentDir, "models.yml");
  try {
    if (existsSync(path) && readFileSync(path, "utf8") === LOGIN_BOOTSTRAP_YAML) rmSync(path, { force: true });
  } catch {
    // Never delete a file unless the exact, credential-free marker was read.
  }
}

function rejectExecutableExtensionArgs(args: string[], strict: boolean): void {
  const forbidden = new Set(["--extension", "-e", "--hook", "--plugin-dir", "--config", "--profile", "--approval-mode", "--auto-approve", "--yolo"]);
  const found = args.find((argument) => {
    const name = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    return argument === "--" || (strict && argument.startsWith("-")) || forbidden.has(name) || /^-e.+/.test(argument);
  });
  if (found) throw new Error(`OMP runtime override is disabled by Axiomux strict mode: ${found}`);
}

function isConsequentialApproval(request: OmpUiRequest, response: JsonObject | undefined): boolean {
  if (request.method === "confirm") return response?.confirmed === true;
  if (request.method !== "select") return false;
  const selected = typeof response?.value === "string" ? response.value.trim() : "";
  if (!selected) return false;
  // Accept an upstream Portuguese affirmative as protocol input, while all
  // Axiomux-owned prompts and diagnostics remain English.
  const approvalOption = request.options?.find((option) => /^(?:approve|allow|yes|sim)(?:\b|$)/i.test(option.trim())); // language-audit: allow-portuguese-input
  return approvalOption ? selected === approvalOption : /^(?:approve|allow|yes|sim)(?:\b|$)/i.test(selected); // language-audit: allow-portuguese-input
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams | undefined): void {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawn(resolveWindowsSystemExecutable("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
      return;
    } catch {
      // Fall through to the direct signal.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* Already exited. */
  }
}
