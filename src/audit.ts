import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactValue } from "./security/secrets.js";

export interface AuditEvent {
  action: string;
  actor?: "user" | "agent" | "system";
  target?: string;
  outcome: "allowed" | "denied" | "proposed" | "completed" | "failed";
  details?: Record<string, unknown>;
}

export class AuditLog {
  constructor(private readonly path: string) {}

  write(event: AuditEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(redactValue({ timestamp: new Date().toISOString(), ...event }))}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
