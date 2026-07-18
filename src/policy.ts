export type RiskLevel = "read" | "workspace-write" | "external" | "destructive";

export interface PolicyDecision {
  risk: RiskLevel;
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

export class PolicyEngine {
  assess(tool: string, input: Record<string, unknown>): PolicyDecision {
    const text = `${tool} ${JSON.stringify(input)}`.toLocaleLowerCase();
    if (/\b(?:delete|remove|rm\b|format|shutdown|restart|reboot|payment|purchase|publish|send_email|post_message)\b/.test(text)) {
      return { risk: "destructive", allowed: false, requiresApproval: true, reason: "Irreversible or consequential action" };
    }
    if (["computer_use", "browser_task", "login"].includes(tool) || /\b(?:oauth|external|https?)\b/.test(text)) {
      return { risk: "external", allowed: false, requiresApproval: true, reason: "External system or account boundary" };
    }
    if (["memory_remember", "skill_propose", "source_ingest"].includes(tool) || /\b(?:write|edit|patch|create|remember)\b/.test(text)) {
      return { risk: "workspace-write", allowed: true, requiresApproval: false, reason: "Reversible local write with audit trail" };
    }
    return { risk: "read", allowed: true, requiresApproval: false, reason: "Read-only operation" };
  }
}
