import type { ThinkingLevel } from "../types.js";
import { OMP_CONTRACT_VERSION, OmpRpcClient, type OmpClientOptions } from "../rpc/omp-client.js";
import type { OmpIsolation } from "../security/omp-isolation.js";
import type { FusionModelRequest, FusionModelResponse, FusionModelRunner } from "./types.js";

export interface OmpFusionRunnerOptions {
  executable: string;
  versionContract?: string;
  /** Wrapper/script arguments only. Tool, extension and prompt flags are rejected. */
  extraArgs?: string[];
  cwd: string;
  thinkingLevel?: ThinkingLevel;
  profile?: string;
  envAllowlist?: string[];
  /** Resolve provider secrets for this exact model child only. */
  environmentForModel?: (modelSelector: string) => NodeJS.ProcessEnv;
  isolation?: OmpIsolation;
}

/**
 * Runs each advisory model in a fresh OMP RPC process with tools and extensions disabled.
 * It intentionally exposes no host-tool registration surface to FusionEngine.
 */
export class OmpFusionRunner implements FusionModelRunner {
  private readonly extraArgs: string[];

  constructor(private readonly options: OmpFusionRunnerOptions) {
    this.extraArgs = [...(options.extraArgs ?? [])];
    assertSafeWrapperArguments(this.extraArgs);
  }

  async run(request: FusionModelRequest): Promise<FusionModelResponse> {
    if (request.allowTools !== false) throw new Error("Fusion OMP runner refuses tool-enabled requests");
    if (request.signal.aborted) throw abortError();

    const clientOptions: OmpClientOptions = {
      executable: this.options.executable,
      versionContract: this.options.versionContract ?? OMP_CONTRACT_VERSION,
      extraArgs: this.extraArgs,
      cwd: this.options.cwd,
      model: request.model,
      systemPrompt: request.systemPrompt,
      approvalMode: "always-ask",
      tools: [],
      timeoutMs: request.timeoutMs,
      ...(this.options.thinkingLevel ? { thinkingLevel: this.options.thinkingLevel } : {}),
      ...(this.options.profile ? { profile: this.options.profile } : {}),
      ...(this.options.envAllowlist ? { envAllowlist: this.options.envAllowlist } : {}),
      ...(this.options.environmentForModel ? { environmentOverrides: this.options.environmentForModel(request.model) } : {}),
      ...(this.options.isolation ? { isolation: this.options.isolation } : {}),
    };
    const client = new OmpRpcClient(clientOptions);
    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => (stopPromise ??= client.stop());
    const onAbort = (): void => {
      void stop();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await raceWithAbort(client.start(), request.signal);
      const result = await raceWithAbort(client.prompt(request.message), request.signal);
      if (result.toolCalls !== 0) throw new Error("Fusion OMP runner detected forbidden tool activity");
      return { text: result.text };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      await stop();
    }
  }
}

const FORBIDDEN_ARGUMENTS = new Set([
  "--extension",
  "-e",
  "--tools",
  "--no-tools",
  "--skills",
  "--no-skills",
  "--rules",
  "--no-rules",
  "--system-prompt",
  "--append-system-prompt",
  "--mode",
  "--approval-mode",
  "--profile",
  "--model",
  "--thinking",
]);

function assertSafeWrapperArguments(arguments_: string[]): void {
  for (const argument of arguments_) {
    const normalized = argument.toLowerCase();
    const name = normalized.includes("=") ? normalized.slice(0, normalized.indexOf("=")) : normalized;
    if (normalized === "--" || normalized.startsWith("-e") || FORBIDDEN_ARGUMENTS.has(name)) {
      throw new Error(`OMP Fusion wrapper argument is forbidden: ${name}`);
    }
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortError(): Error {
  const error = new Error("Fusion OMP run aborted");
  error.name = "AbortError";
  return error;
}
