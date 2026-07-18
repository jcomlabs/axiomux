import type { ResponseLanguage } from "../response-language.js";

export type FusionMode = "moa" | "fusion";

export type FusionFailureReason = "timeout" | "runner_error" | "empty_output" | "no_candidates";

export interface FusionModelRequest {
  role: "candidate" | "synthesizer";
  model: string;
  systemPrompt: string;
  message: string;
  /** Fusion participants are advisory-only and must never receive tools. */
  allowTools: false;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface FusionModelResponse {
  /** Only the provider's public assistant text. Never return hidden reasoning events here. */
  text: string;
}

export interface FusionModelRunner {
  run(request: FusionModelRequest): Promise<FusionModelResponse>;
}

export interface FusionTelemetryEvent {
  at: string;
  kind: "run" | "candidate" | "synthesis";
  phase: "started" | "queued" | "completed" | "failed";
  model?: string;
  candidateIndex?: number;
  durationMs?: number;
  reason?: FusionFailureReason;
}

export interface FusionEngineOptions {
  runner: FusionModelRunner;
  models: readonly string[];
  synthesisModel?: string;
  maxParallel?: number;
  candidateTimeoutMs?: number;
  synthesisTimeoutMs?: number;
  maxOutputCharacters?: number;
  onTelemetry?: (event: FusionTelemetryEvent) => void;
}

export interface FusionRunOptions {
  mode: FusionMode;
  signal?: AbortSignal;
  responseLanguage?: ResponseLanguage;
}

export interface FusionCandidateResult {
  index: number;
  model: string;
  status: "fulfilled" | "failed" | "timed_out";
  /** Provider-visible final answer, scrubbed of common hidden-reasoning blocks. */
  text?: string;
  reason?: Exclude<FusionFailureReason, "no_candidates">;
  durationMs: number;
  untrusted: true;
}

export interface FusionSynthesisResult {
  model: string;
  status: "fulfilled" | "failed" | "timed_out" | "skipped";
  /** Advisory synthesis only. The principal agent remains responsible for verification. */
  text?: string;
  reason?: FusionFailureReason;
  durationMs: number;
  untrusted: true;
}

export interface FusionRunResult {
  mode: FusionMode;
  candidates: FusionCandidateResult[];
  synthesis?: FusionSynthesisResult;
  usableCandidates: number;
  /** Prompt-safe advisory block for the principal aggregator. It is never trusted instructions. */
  aggregatorContext: string;
}
