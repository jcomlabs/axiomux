export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";

export interface CommandAdapterConfig {
  enabled: boolean;
  command: string;
  envAllowlist: string[];
}

export interface BrowserAdapterConfig extends CommandAdapterConfig {
  allowedDomains: string[];
}

export interface SuperAIConfig {
  model: string;
  fallbackModels: string[];
  thinkingLevel: ThinkingLevel;
  ompExecutable: string;
  ompProfile: string;
  ompTools: string[];
  ompEnvAllowlist: string[];
  ompIsolation: {
    mode: "strict";
    rejectUntrustedExtensions: boolean;
  };
  approvalMode: "always-ask";
  autoLearn: boolean;
  persona: {
    intensity: 0 | 1 | 2 | 3;
  };
  selfEvaluation: {
    enabled: boolean;
    retentionDays: number;
  };
  memory: {
    recallLimit: number;
    maxContextCharacters: number;
    halfLifeDays: number;
    episodic: {
      enabled: boolean;
      retentionDays: number;
      maxCharacters: number;
    };
  };
  fusion: {
    enabled: boolean;
    mode: "moa" | "fusion";
    models: string[];
    synthesisModel: string;
    maxParallel: number;
    candidateTimeoutMs: number;
  };
  adapters: {
    browserUse: BrowserAdapterConfig;
    computerUse: CommandAdapterConfig;
  };
}

export type AgentTraceKind = "lifecycle" | "reasoning" | "tool" | "provider" | "memory" | "steering" | "verification";

export interface AgentTraceEvent {
  at: string;
  kind: AgentTraceKind;
  phase: "started" | "progress" | "completed" | "failed" | "queued";
  label: string;
  detail?: string;
  model?: string;
  tool?: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  selector: string;
  name?: string;
  contextWindow?: number | null;
  reasoning?: boolean;
  input?: string[];
}

export interface MemoryItem {
  id: number;
  content: string;
  kind: "evidence" | "instruction" | "preference" | "procedure";
  reviewStatus: "pending" | "approved" | "rejected";
  confidence: number;
  importance: number;
  scope: string;
  sourceUri: string;
  sourceLabel: string;
  createdAt: string;
  lastAccessedAt?: string;
  accessCount: number;
  expiresAt?: string;
  supersededBy?: number;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  status: "core" | "active" | "quarantine";
  contentHash: string;
}

export interface HostToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

export interface HostToolContext {
  toolCallId: string;
  signal: AbortSignal;
}

export interface HostTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  loadMode?: "always" | "discoverable";
  execute(arguments_: Record<string, unknown>, context: HostToolContext): Promise<HostToolResult>;
}
