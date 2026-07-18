import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { escapeBidiControls } from "../security/display.js";

export interface UiApprovalRequest {
  id: string;
  taskId: string;
  description: string;
  createdAt: string;
  expiresAt: string;
}

export type UiApprovalEvent =
  | ({ type: "approval.requested" } & UiApprovalRequest)
  | { type: "approval.resolved"; id: string; taskId: string; approved: boolean; reason: "user" | "timeout" | "task-ended" | "shutdown" };

interface PendingApproval extends UiApprovalRequest {
  timer: NodeJS.Timeout;
  settle: (approved: boolean) => void;
}

/**
 * In-memory, fail-closed hand-off between an agent tool approval and the local
 * web UI. Approval identifiers are random, single-use and expire automatically.
 */
export class UiApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly events = new EventEmitter();
  private closed = false;

  constructor(private readonly timeoutMs = 5 * 60_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) {
      throw new Error("UI approval timeout must be between 1 second and 30 minutes");
    }
    this.events.setMaxListeners(200);
  }

  request(taskId: string, description: string): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const safeTaskId = boundedText(taskId, "task id", 256);
    const safeDescription = boundedText(escapeBidiControls(description), "approval description", 8_000);
    const id = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.timeoutMs);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id, false, "timeout"), this.timeoutMs);
      timer.unref();
      const approval: PendingApproval = {
        id,
        taskId: safeTaskId,
        description: safeDescription,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        timer,
        settle: resolve,
      };
      this.pending.set(id, approval);
      this.events.emit("approval", this.publicRequest(approval));
    });
  }

  resolve(id: string, approved: boolean): UiApprovalEvent {
    const safeId = boundedText(id, "approval id", 256);
    const approval = this.pending.get(safeId);
    if (!approval) throw new Error("Unknown or expired approval request");
    return this.finish(safeId, approved, "user");
  }

  list(taskId?: string): UiApprovalRequest[] {
    return [...this.pending.values()]
      .filter((item) => !taskId || item.taskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((item) => ({
        id: item.id,
        taskId: item.taskId,
        description: item.description,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
      }));
  }

  cancelTask(taskId: string): void {
    for (const approval of this.pending.values()) {
      if (approval.taskId === taskId) this.finish(approval.id, false, "task-ended");
    }
  }

  subscribe(listener: (event: UiApprovalEvent) => void): () => void {
    this.events.on("approval", listener);
    return () => this.events.off("approval", listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const approval of [...this.pending.values()]) this.finish(approval.id, false, "shutdown");
    this.events.removeAllListeners();
  }

  private publicRequest(approval: PendingApproval): UiApprovalEvent {
    return {
      type: "approval.requested",
      id: approval.id,
      taskId: approval.taskId,
      description: approval.description,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
    };
  }

  private finish(id: string, approved: boolean, reason: Extract<UiApprovalEvent, { type: "approval.resolved" }>["reason"]): UiApprovalEvent {
    const approval = this.pending.get(id);
    if (!approval) throw new Error("Unknown or expired approval request");
    this.pending.delete(id);
    clearTimeout(approval.timer);
    approval.settle(approved);
    const event: UiApprovalEvent = { type: "approval.resolved", id, taskId: approval.taskId, approved, reason };
    this.events.emit("approval", event);
    return event;
  }
}

function boundedText(value: string, name: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
    throw new Error(`${name} must contain 1-${maximum} printable characters`);
  }
  return normalized;
}
