import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { redactSecrets } from "../security/secrets.js";
import type { AgentTraceEvent } from "../types.js";

const reconciledConnections = new WeakSet<object>();
const runtimeOwnerId = `${process.pid}:${randomUUID()}`;

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  rootDevice?: string;
  rootInode?: string;
  rootBirthtimeNanoseconds?: string;
  linked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  sequence: number;
  input: string;
  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  model?: string;
  output?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface RuntimeSessionRecord {
  id: string;
  projectId: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
  preferredModel?: string;
}

export type RuntimeTaskStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface RuntimeTaskRecord {
  id: string;
  projectId: string;
  sessionId: string;
  turnId?: string;
  title: string;
  prompt: string;
  status: RuntimeTaskStatus;
  output: string;
  model?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateRuntimeTaskOptions {
  id?: string;
  status?: Extract<RuntimeTaskStatus, "queued" | "running">;
}

export interface RuntimeTaskUpdate {
  model?: string;
  output?: string;
  error?: string;
}

export interface SearchHit {
  sessionId: string;
  projectId: string;
  projectName: string;
  role: string;
  content: string;
  createdAt: string;
  rank: number;
}

export class RuntimeStore {
  constructor(private readonly database: DatabaseSync) {
    this.migrate();
    if (!reconciledConnections.has(database)) {
      this.reconcileInterruptedWork();
      reconciledConnections.add(database);
    }
    this.ensureProjectSingleFlight();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        root_device TEXT,
        root_inode TEXT,
        root_birthtime_ns TEXT,
        linked INTEGER NOT NULL DEFAULT 1 CHECK(linked IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS runtime_preferences (
        id INTEGER PRIMARY KEY CHECK(id=1),
        current_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_approval','completed','failed','cancelled')),
        model TEXT,
        output TEXT,
        error TEXT,
        owner_instance TEXT,
        owner_pid INTEGER,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS runtime_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        phase TEXT NOT NULL,
        label TEXT NOT NULL,
        detail TEXT,
        model TEXT,
        tool TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tool_effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('started','completed','failed','unknown')),
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        result_hash TEXT,
        UNIQUE(turn_id, tool_call_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','completed','failed','cancelled')),
        output TEXT NOT NULL DEFAULT '',
        model TEXT,
        error TEXT,
        owner_instance TEXT,
        owner_pid INTEGER,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS steering_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        classification TEXT NOT NULL CHECK(classification IN ('steer','follow_up','stop','status')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','delivered','failed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS provider_health (
        selector TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('unknown','healthy','degraded','unavailable','auth_required')),
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error_class TEXT,
        last_error TEXT,
        latency_ms INTEGER,
        circuit_open_until TEXT,
        checked_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS runtime_events_turn_idx ON runtime_events(turn_id, id);
      CREATE INDEX IF NOT EXISTS runtime_tasks_project_idx ON runtime_tasks(project_id, updated_at DESC);
    `);
    ensureColumn(this.database, "sessions", "project_id", "TEXT REFERENCES projects(id)");
    ensureColumn(this.database, "projects", "linked", "INTEGER NOT NULL DEFAULT 1");
    const addedRootDevice = ensureColumn(this.database, "projects", "root_device", "TEXT");
    const addedRootInode = ensureColumn(this.database, "projects", "root_inode", "TEXT");
    const addedRootBirthtime = ensureColumn(this.database, "projects", "root_birthtime_ns", "TEXT");
    ensureColumn(this.database, "sessions", "status", "TEXT NOT NULL DEFAULT 'idle'");
    ensureColumn(this.database, "sessions", "preferred_model", "TEXT");
    ensureColumn(this.database, "runtime_tasks", "prompt", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, "runtime_tasks", "output", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, "runtime_tasks", "model", "TEXT");
    ensureColumn(this.database, "runtime_tasks", "error", "TEXT");
    ensureColumn(this.database, "runtime_tasks", "started_at", "TEXT");
    ensureColumn(this.database, "runtime_tasks", "completed_at", "TEXT");
    ensureColumn(this.database, "runtime_tasks", "owner_instance", "TEXT");
    ensureColumn(this.database, "runtime_tasks", "owner_pid", "INTEGER");
    ensureColumn(this.database, "turns", "owner_instance", "TEXT");
    ensureColumn(this.database, "turns", "owner_pid", "INTEGER");
    if (addedRootDevice || addedRootInode || addedRootBirthtime) {
      const rootsMissingIdentity = this.database
        .prepare(`SELECT id, root_path FROM projects
        WHERE root_device IS NULL OR root_inode IS NULL OR root_birthtime_ns IS NULL`)
        .all() as unknown as Array<{ id: string; root_path: string }>;
      const persistRootIdentity = this.database.prepare(`UPDATE projects SET root_device=?, root_inode=?, root_birthtime_ns=? WHERE id=?`);
      for (const project of rootsMissingIdentity) {
        try {
          const identity = rootIdentity(project.root_path);
          persistRootIdentity.run(identity.device, identity.inode, identity.birthtimeNanoseconds, project.id);
        } catch {
          // Missing workspaces during the one-time migration remain untrusted.
          // They acquire a fixed identity only through an explicit relink.
        }
      }
    }
    this.database.exec(`
      CREATE TRIGGER IF NOT EXISTS sessions_linked_project_insert BEFORE INSERT ON sessions
      WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id AND linked=1)
      BEGIN SELECT RAISE(ABORT, 'session project is not linked'); END;
      CREATE TRIGGER IF NOT EXISTS sessions_linked_project_update BEFORE UPDATE OF project_id ON sessions
      WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id AND linked=1)
      BEGIN SELECT RAISE(ABORT, 'session project is not linked'); END;
      CREATE TRIGGER IF NOT EXISTS sessions_project_immutable BEFORE UPDATE OF project_id ON sessions
      WHEN OLD.project_id IS NOT NULL AND NEW.project_id IS NOT OLD.project_id
      BEGIN SELECT RAISE(ABORT, 'session project binding is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS turns_session_immutable BEFORE UPDATE OF session_id ON turns
      WHEN NEW.session_id IS NOT OLD.session_id
      BEGIN SELECT RAISE(ABORT, 'turn session binding is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS runtime_tasks_linked_project_insert BEFORE INSERT ON runtime_tasks
      WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id AND linked=1)
      BEGIN SELECT RAISE(ABORT, 'task project is not linked'); END;
      CREATE TRIGGER IF NOT EXISTS runtime_tasks_session_project_insert BEFORE INSERT ON runtime_tasks
      WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND project_id=NEW.project_id)
      BEGIN SELECT RAISE(ABORT, 'task session does not belong to task project'); END;
      CREATE TRIGGER IF NOT EXISTS runtime_tasks_turn_session_insert BEFORE INSERT ON runtime_tasks
      WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM turns WHERE id=NEW.turn_id AND session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT, 'task turn does not belong to task session'); END;
      CREATE TRIGGER IF NOT EXISTS runtime_tasks_scope_immutable BEFORE UPDATE OF project_id, session_id ON runtime_tasks
      WHEN NEW.project_id IS NOT OLD.project_id OR NEW.session_id IS NOT OLD.session_id
      BEGIN SELECT RAISE(ABORT, 'task project and session bindings are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS runtime_tasks_turn_binding_update BEFORE UPDATE OF turn_id ON runtime_tasks
      WHEN (OLD.turn_id IS NOT NULL AND NEW.turn_id IS NOT OLD.turn_id)
        OR (NEW.turn_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM turns WHERE id=NEW.turn_id AND session_id=NEW.session_id))
      BEGIN SELECT RAISE(ABORT, 'task turn does not belong to task session'); END;
      CREATE TRIGGER IF NOT EXISTS runtime_events_turn_session_insert BEFORE INSERT ON runtime_events
      WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM turns WHERE id=NEW.turn_id AND session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT, 'event turn does not belong to event session'); END;
    `);
    this.database.exec(`
      UPDATE runtime_tasks SET prompt=title WHERE prompt='';
      UPDATE runtime_tasks SET started_at=created_at WHERE started_at IS NULL;
    `);
    const invalidBinding = this.database
      .prepare(`SELECT task.id FROM runtime_tasks task
      LEFT JOIN sessions session ON session.id=task.session_id
      LEFT JOIN turns turn_record ON turn_record.id=task.turn_id
      WHERE session.id IS NULL OR session.project_id IS NOT task.project_id
        OR (task.turn_id IS NOT NULL AND (turn_record.id IS NULL OR turn_record.session_id IS NOT task.session_id))
      LIMIT 1`)
      .get() as { id: string } | undefined;
    if (invalidBinding) {
      throw new Error(`Runtime database task ${invalidBinding.id} violates its task/turn/session/project binding`);
    }
    this.database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    const indexed = this.database.prepare("SELECT COUNT(*) count FROM messages_fts").get() as { count: number };
    const messages = this.database.prepare("SELECT COUNT(*) count FROM messages").get() as { count: number };
    if (Number(indexed.count) !== Number(messages.count)) this.database.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  }

  ensureProject(rootPath: string, name?: string): ProjectRecord {
    const canonical = realpathSync.native(resolve(rootPath));
    if (!statSync(canonical).isDirectory()) throw new Error(`Project root is not a directory: ${canonical}`);
    const safeName = validateProjectName(name?.trim() || basename(canonical));
    const identity = process.platform === "win32" ? canonical.toLocaleLowerCase() : canonical;
    const id = `project_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
    const idConflict = this.getProject(id);
    if (idConflict && !sameCanonicalPath(idConflict.rootPath, canonical)) {
      throw new Error("Project identity collision; the workspace was not registered");
    }
    const physicalIdentity = rootIdentity(canonical);
    const existing = this.listProjects(true).find((project) => sameCanonicalPath(project.rootPath, canonical));
    if (existing?.linked && !projectRootIdentityMatches(existing, physicalIdentity)) {
      throw new Error("Linked project directory identity changed; unlink and explicitly relink the workspace before trusting its replacement");
    }
    if (existing) {
      this.database
        .prepare(`UPDATE projects SET name=?, linked=1, root_device=?, root_inode=?, root_birthtime_ns=?, updated_at=datetime('now')
        WHERE id=?`)
        .run(safeName, physicalIdentity.device, physicalIdentity.inode, physicalIdentity.birthtimeNanoseconds, existing.id);
      const updated = this.getProject(existing.id);
      if (!updated) throw new Error(`Project ${existing.id} disappeared during relink`);
      return updated;
    }
    this.database
      .prepare(`INSERT INTO projects(id, name, root_path, root_device, root_inode, root_birthtime_ns, linked)
      VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run(id, safeName, canonical, physicalIdentity.device, physicalIdentity.inode, physicalIdentity.birthtimeNanoseconds);
    const created = this.getProject(id);
    if (!created) throw new Error(`Project ${id} disappeared during registration`);
    return created;
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.database.prepare("SELECT * FROM projects WHERE id=?").get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : undefined;
  }

  getProjectByRoot(rootPath: string): ProjectRecord | undefined {
    const canonical = realpathSync.native(resolve(rootPath));
    const projects = this.listProjects(true);
    const project = projects.find((candidate) => sameCanonicalPath(candidate.rootPath, canonical));
    if (!project) return undefined;
    return projectRootIdentityMatches(project, rootIdentity(canonical)) ? project : undefined;
  }

  listProjects(includeUnlinked = false): ProjectRecord[] {
    const rows = this.database
      .prepare(`SELECT * FROM projects ${includeUnlinked ? "" : "WHERE linked=1"} ORDER BY updated_at DESC, name`)
      .all() as unknown as ProjectRow[];
    return rows.map(mapProject);
  }

  currentProject(): ProjectRecord | undefined {
    const row = this.database
      .prepare(`SELECT p.* FROM runtime_preferences r
      JOIN projects p ON p.id=r.current_project_id WHERE r.id=1 AND p.linked=1`)
      .get() as ProjectRow | undefined;
    return row ? mapProject(row) : undefined;
  }

  useProject(projectId: string): ProjectRecord {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.getProject(projectId);
      if (!project?.linked) throw new Error(`Unknown or unlinked project: ${projectId}`);
      this.database
        .prepare(`INSERT INTO runtime_preferences(id, current_project_id) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET current_project_id=excluded.current_project_id`)
        .run(project.id);
      this.database.prepare("UPDATE projects SET updated_at=datetime('now') WHERE id=?").run(project.id);
      const selected = this.getProject(project.id);
      if (!selected) throw new Error(`Project disappeared while selecting it: ${project.id}`);
      this.database.exec("COMMIT");
      return selected;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeProject(projectId: string): ProjectRecord {
    let removed: ProjectRecord | undefined;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.getProject(projectId);
      if (!project?.linked) throw new Error(`Unknown or already unlinked project: ${projectId}`);
      const active = this.database
        .prepare(`SELECT id FROM runtime_tasks WHERE project_id=?
        AND status IN ('queued','running','waiting') LIMIT 1`)
        .get(projectId) as { id: string } | undefined;
      if (active) throw new Error(`Project has active task ${active.id}; stop or finish it before unlinking the workspace`);
      this.database.prepare("UPDATE projects SET linked=0, updated_at=datetime('now') WHERE id=?").run(projectId);
      this.database.prepare("UPDATE runtime_preferences SET current_project_id=NULL WHERE id=1 AND current_project_id=?").run(projectId);
      removed = this.getProject(projectId);
      if (!removed) throw new Error(`Project disappeared while unlinking it: ${projectId}`);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (!removed) throw new Error(`Project unlink did not produce a record: ${projectId}`);
    return removed;
  }

  attachSession(projectId: string, sessionId: string, title?: string): void {
    const project = this.getProject(projectId);
    if (!project?.linked) throw new Error(`Cannot attach a session to an unknown or unlinked project: ${projectId}`);
    const existing = this.database.prepare("SELECT project_id FROM sessions WHERE id=?").get(sessionId) as { project_id: string | null } | undefined;
    if (existing?.project_id && existing.project_id !== projectId) {
      throw new Error(`Session ${sessionId} already belongs to project ${existing.project_id}`);
    }
    this.database.prepare("INSERT OR IGNORE INTO sessions(id, title, project_id) VALUES (?, ?, ?)").run(sessionId, title ?? null, projectId);
    this.database
      .prepare(`UPDATE sessions SET project_id=?, title=COALESCE(title, ?), updated_at=datetime('now') WHERE id=?`)
      .run(projectId, title ?? null, sessionId);
  }

  listSessions(projectId?: string, limit = 100): RuntimeSessionRecord[] {
    const sql = `SELECT s.id, s.project_id, s.title, s.status, s.preferred_model, s.created_at, s.updated_at, COUNT(m.id) messages
      FROM sessions s LEFT JOIN messages m ON m.session_id=s.id
      ${projectId ? "WHERE s.project_id=?" : "WHERE s.project_id IS NOT NULL"}
      GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ?`;
    const rows = (projectId ? this.database.prepare(sql).all(projectId, limit) : this.database.prepare(sql).all(limit)) as unknown as SessionRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: Number(row.messages),
      ...(row.preferred_model ? { preferredModel: row.preferred_model } : {}),
    }));
  }

  getSession(sessionId: string): RuntimeSessionRecord | undefined {
    const row = this.database
      .prepare(`SELECT s.id, s.project_id, s.title, s.status, s.preferred_model,
      s.created_at, s.updated_at, COUNT(m.id) messages FROM sessions s
      LEFT JOIN messages m ON m.session_id=s.id WHERE s.id=? GROUP BY s.id`)
      .get(sessionId) as SessionRow | undefined;
    if (!row?.project_id) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: Number(row.messages),
      ...(row.preferred_model ? { preferredModel: row.preferred_model } : {}),
    };
  }

  sessionPreferredModel(sessionId: string): string | undefined {
    const row = this.database.prepare("SELECT preferred_model FROM sessions WHERE id=?").get(sessionId) as { preferred_model: string | null } | undefined;
    return row?.preferred_model ?? undefined;
  }

  setSessionPreferredModel(sessionId: string, model?: string): void {
    const selector = model?.trim();
    if (selector && (selector.length > 240 || !/^[^\s/]+\/.+$/u.test(selector) || /[\u0000-\u001f\u007f-\u009f]/u.test(selector))) {
      throw new Error("Session model must be a safe provider/model selector");
    }
    const result = this.database.prepare("UPDATE sessions SET preferred_model=?, updated_at=datetime('now') WHERE id=?").run(selector || null, sessionId);
    if (Number(result.changes) !== 1) throw new Error(`Unknown session: ${sessionId}`);
  }

  beginTurn(sessionId: string, input: string): TurnRecord {
    const id = randomUUID();
    const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 sequence FROM turns WHERE session_id=?").get(sessionId) as { sequence: number };
    const safe = redactSecrets(input).slice(0, 200_000);
    this.database
      .prepare(`INSERT INTO turns(id, session_id, sequence, input, status, owner_instance, owner_pid)
      VALUES (?, ?, ?, ?, 'running', ?, ?)`)
      .run(id, sessionId, Number(row.sequence), safe, runtimeOwnerId, process.pid);
    this.database.prepare("UPDATE sessions SET status='running', updated_at=datetime('now') WHERE id=?").run(sessionId);
    const turn = this.getTurn(id);
    if (!turn) throw new Error(`Turn disappeared immediately after creation: ${id}`);
    return turn;
  }

  getTurn(id: string): TurnRecord | undefined {
    const row = this.database.prepare("SELECT * FROM turns WHERE id=?").get(id) as TurnRow | undefined;
    return row ? mapTurn(row) : undefined;
  }

  completeTurn(id: string, model: string, output: string): void {
    const result = this.database
      .prepare(`UPDATE turns SET status='completed', model=?, output=?, completed_at=datetime('now')
      WHERE id=? AND status IN ('queued','running','waiting_approval')`)
      .run(model, redactSecrets(output).slice(0, 200_000), id);
    if (Number(result.changes) === 0 && this.getTurn(id)?.status !== "completed") throw new Error(`Turn ${id} is terminal and cannot complete`);
    this.updateSessionFromTurn(id, "idle");
  }

  failTurn(id: string, error: string, cancelled = false): void {
    const status = cancelled ? "cancelled" : "failed";
    const result = this.database
      .prepare(`UPDATE turns SET status=?, error=?, completed_at=datetime('now')
      WHERE id=? AND status IN ('queued','running','waiting_approval')`)
      .run(status, redactSecrets(error).slice(0, 12_000), id);
    if (Number(result.changes) === 0 && this.getTurn(id)?.status !== status) throw new Error(`Turn ${id} is terminal and cannot transition to ${status}`);
    this.updateSessionFromTurn(id, "idle");
  }

  appendEvent(sessionId: string, turnId: string | undefined, event: AgentTraceEvent): void {
    this.database
      .prepare(`INSERT INTO runtime_events(session_id, turn_id, kind, phase, label, detail, model, tool)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        sessionId,
        turnId ?? null,
        event.kind,
        event.phase,
        redactSecrets(event.label).slice(0, 500),
        event.detail ? redactSecrets(event.detail).slice(0, 4_000) : null,
        event.model ?? null,
        event.tool ?? null,
      );
  }

  listEvents(sessionId: string, afterId = 0, limit = 500): Array<AgentTraceEvent & { id: number; turnId?: string }> {
    const rows = this.database
      .prepare(`SELECT * FROM runtime_events WHERE session_id=? AND id>? ORDER BY id LIMIT ?`)
      .all(sessionId, afterId, limit) as unknown as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      at: `${row.created_at.replace(" ", "T")}Z`,
      kind: row.kind as AgentTraceEvent["kind"],
      phase: row.phase as AgentTraceEvent["phase"],
      label: row.label,
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.tool ? { tool: row.tool } : {}),
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
    }));
  }

  startEffect(turnId: string, toolCallId: string, capability: string, arguments_: unknown): boolean {
    const fingerprint = createHash("sha256").update(JSON.stringify(arguments_)).digest("hex");
    const result = this.database
      .prepare(`INSERT INTO tool_effects(turn_id, tool_call_id, capability, fingerprint, status)
      VALUES (?, ?, ?, ?, 'started') ON CONFLICT(turn_id, tool_call_id) DO NOTHING`)
      .run(turnId, toolCallId, capability, fingerprint);
    if (Number(result.changes) === 1) return true;
    const existing = this.database
      .prepare(`SELECT capability, fingerprint, status FROM tool_effects
      WHERE turn_id=? AND tool_call_id=?`)
      .get(turnId, toolCallId) as { capability: string; fingerprint: string; status: string } | undefined;
    if (!existing || existing.capability !== capability || existing.fingerprint !== fingerprint) {
      throw new Error(`Tool effect ${toolCallId} conflicts with its durable ledger entry`);
    }
    return false;
  }

  finishEffect(turnId: string, toolCallId: string, status: "completed" | "failed" | "unknown", result?: unknown): void {
    const resultHash = result === undefined ? null : createHash("sha256").update(JSON.stringify(result)).digest("hex");
    this.database
      .prepare(`UPDATE tool_effects SET status=?, result_hash=?, completed_at=datetime('now') WHERE turn_id=? AND tool_call_id=?`)
      .run(status, resultHash, turnId, toolCallId);
  }

  hasConsequentialEffect(turnId: string): boolean {
    const row = this.database.prepare("SELECT 1 found FROM tool_effects WHERE turn_id=? LIMIT 1").get(turnId) as { found: number } | undefined;
    return Boolean(row);
  }

  createTask(projectId: string, sessionId: string, prompt: string, turnId?: string, options: CreateRuntimeTaskOptions = {}): string {
    const id = options.id ?? randomUUID();
    const status = options.status ?? "running";
    const safePrompt = redactSecrets(prompt).slice(0, 200_000);
    const existing = this.getTask(id);
    if (existing) {
      if (existing.status !== "queued" || status !== "running") {
        throw new Error(`Task ${id} already exists with status ${existing.status}; persisted tasks are never resumed`);
      }
      if (existing.projectId !== projectId || existing.sessionId !== sessionId || existing.prompt !== safePrompt) {
        throw new Error(`Task ${id} does not match its persisted project, session and prompt`);
      }
      const ownership = this.database.prepare("SELECT owner_instance FROM runtime_tasks WHERE id=?").get(id) as { owner_instance: string | null };
      if (ownership.owner_instance !== runtimeOwnerId) throw new Error(`Task ${id} belongs to another runtime instance and cannot be claimed`);
      this.database
        .prepare(`UPDATE runtime_tasks SET turn_id=COALESCE(?, turn_id), status='running',
        owner_instance=?, owner_pid=?, updated_at=datetime('now') WHERE id=?`)
        .run(turnId ?? null, runtimeOwnerId, process.pid, id);
      return id;
    }
    this.database
      .prepare(`INSERT INTO runtime_tasks(id, project_id, session_id, turn_id, title, prompt, status, owner_instance, owner_pid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, sessionId, turnId ?? null, safePrompt.slice(0, 160), safePrompt, status, runtimeOwnerId, process.pid);
    return id;
  }

  getTask(id: string): RuntimeTaskRecord | undefined {
    const row = this.database.prepare("SELECT * FROM runtime_tasks WHERE id=?").get(id) as RuntimeTaskRow | undefined;
    return row ? mapTask(row) : undefined;
  }

  listTasks(projectId?: string, sessionId?: string, limit = 500): RuntimeTaskRecord[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (projectId) {
      clauses.push("project_id=?");
      parameters.push(projectId);
    }
    if (sessionId) {
      clauses.push("session_id=?");
      parameters.push(sessionId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(5_000, Math.trunc(limit))) : 500;
    parameters.push(boundedLimit);
    const rows = this.database
      .prepare(`SELECT * FROM runtime_tasks ${where} ORDER BY started_at DESC, created_at DESC LIMIT ?`)
      .all(...parameters) as unknown as RuntimeTaskRow[];
    return rows.map(mapTask);
  }

  updateTask(id: string, status: RuntimeTaskStatus, turnId?: string, update: RuntimeTaskUpdate = {}): void {
    const current = this.getTask(id);
    if (current && ["completed", "failed", "cancelled"].includes(current.status)) {
      if (current.status === status) return;
      throw new Error(`Task ${id} is terminal (${current.status}) and cannot transition to ${status}`);
    }
    const model = update.model === undefined ? null : redactSecrets(update.model).slice(0, 500);
    const output = update.output === undefined ? null : redactSecrets(update.output).slice(0, 200_000);
    const error = update.error === undefined ? null : redactSecrets(update.error).slice(0, 12_000);
    const terminal = status === "completed" || status === "failed" || status === "cancelled";
    this.database
      .prepare(`UPDATE runtime_tasks SET status=?, turn_id=COALESCE(?, turn_id),
      model=COALESCE(?, model), output=COALESCE(?, output), error=COALESCE(?, error),
      completed_at=CASE WHEN ? THEN COALESCE(completed_at, datetime('now')) ELSE NULL END,
      updated_at=datetime('now') WHERE id=?`)
      .run(status, turnId ?? null, model, output, error, terminal ? 1 : 0, id);
  }

  setTaskOutput(id: string, output: string): void {
    this.database.prepare("UPDATE runtime_tasks SET output=?, updated_at=datetime('now') WHERE id=?").run(redactSecrets(output).slice(0, 200_000), id);
  }

  completeTaskTurn(taskId: string, turnId: string, sessionId: string, model: string, output: string): void {
    const safeOutput = redactSecrets(output).slice(0, 200_000);
    const provider = model.includes("/") ? (model.split("/", 1)[0] ?? null) : null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const binding = this.assertTaskTurnBinding(taskId, turnId, sessionId);
      const turn = this.database
        .prepare(`UPDATE turns SET status='completed', model=?, output=?, completed_at=datetime('now')
        WHERE id=? AND session_id=? AND status IN ('queued','running','waiting_approval')`)
        .run(model, safeOutput, turnId, binding.sessionId);
      const task = this.database
        .prepare(`UPDATE runtime_tasks SET status='completed', model=?, output=?,
        completed_at=datetime('now'), updated_at=datetime('now')
        WHERE id=? AND project_id=? AND session_id=? AND turn_id=?
          AND status IN ('queued','running','waiting')`)
        .run(model, safeOutput, taskId, binding.projectId, binding.sessionId, turnId);
      if (Number(turn.changes) !== 1 || Number(task.changes) !== 1) throw new Error("Task or turn was no longer active during completion");
      this.database
        .prepare("INSERT INTO messages(session_id, role, content, provider, model) VALUES (?, 'assistant', ?, ?, ?)")
        .run(binding.sessionId, safeOutput, provider, model);
      this.updateSessionFromTurn(turnId, "idle");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  failTaskTurn(taskId: string, turnId: string | undefined, error: string, cancelled = false, output?: string): void {
    const status = cancelled ? "cancelled" : "failed";
    const safeError = redactSecrets(error).slice(0, 12_000);
    const safeOutput = output === undefined ? null : redactSecrets(output).slice(0, 200_000);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const binding = this.assertTaskTurnBinding(taskId, turnId);
      if (turnId) {
        const turn = this.database
          .prepare(`UPDATE turns SET status=?, error=?, completed_at=datetime('now')
          WHERE id=? AND session_id=? AND status IN ('queued','running','waiting_approval')`)
          .run(status, safeError, turnId, binding.sessionId);
        if (Number(turn.changes) !== 1) throw new Error(`Turn ${turnId} was no longer active during failure finalization`);
      }
      const turnPredicate = turnId ? "turn_id=?" : "turn_id IS NULL";
      const task = this.database
        .prepare(`UPDATE runtime_tasks SET status=?, error=?, output=COALESCE(?, output),
        completed_at=datetime('now'), updated_at=datetime('now')
        WHERE id=? AND project_id=? AND session_id=? AND ${turnPredicate}
          AND status IN ('queued','running','waiting')`)
        .run(status, safeError, safeOutput, taskId, binding.projectId, binding.sessionId, ...(turnId ? [turnId] : []));
      if (Number(task.changes) !== 1) throw new Error(`Task ${taskId} was no longer active during failure finalization`);
      if (turnId) this.updateSessionFromTurn(turnId, "idle");
      this.database.exec("COMMIT");
    } catch (failure) {
      this.database.exec("ROLLBACK");
      throw failure;
    }
  }

  queueSteering(turnId: string, classification: "steer" | "follow_up" | "stop" | "status", content: string): number {
    const result = this.database
      .prepare(`INSERT INTO steering_messages(turn_id, classification, content, status) VALUES (?, ?, ?, 'queued')`)
      .run(turnId, classification, redactSecrets(content).slice(0, 50_000));
    return Number(result.lastInsertRowid);
  }

  markSteering(id: number, delivered: boolean): void {
    this.database
      .prepare(`UPDATE steering_messages SET status=?, delivered_at=${delivered ? "datetime('now')" : "NULL"} WHERE id=?`)
      .run(delivered ? "delivered" : "failed", id);
  }

  searchMessages(query: string, limit = 50, projectId?: string, sessionId?: string): SearchHit[] {
    const tokens =
      query
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}_-]{2,}/gu)
        ?.slice(0, 16) ?? [];
    if (!tokens.length) return [];
    const expression = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
    const filters = ["messages_fts MATCH ?", "p.linked=1"];
    const parameters: Array<string | number> = [expression];
    if (projectId) {
      filters.push("s.project_id=?");
      parameters.push(projectId);
    }
    if (sessionId) {
      filters.push("m.session_id=?");
      parameters.push(sessionId);
    }
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 50;
    parameters.push(boundedLimit);
    const rows = this.database
      .prepare(`SELECT m.session_id, s.project_id, p.name project_name, m.role, m.content, m.created_at, bm25(messages_fts) rank
      FROM messages_fts f JOIN messages m ON m.id=f.rowid JOIN sessions s ON s.id=m.session_id JOIN projects p ON p.id=s.project_id
      WHERE ${filters.join(" AND ")} ORDER BY rank LIMIT ?`)
      .all(...parameters) as unknown as SearchRow[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      projectId: row.project_id,
      projectName: row.project_name,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      rank: Number(row.rank),
    }));
  }

  recordProviderSuccess(selector: string, latencyMs: number): void {
    this.database
      .prepare(`INSERT INTO provider_health(selector, status, consecutive_failures, latency_ms, checked_at)
      VALUES (?, 'healthy', 0, ?, datetime('now')) ON CONFLICT(selector) DO UPDATE SET status='healthy', consecutive_failures=0,
      last_error_class=NULL, last_error=NULL, latency_ms=excluded.latency_ms, circuit_open_until=NULL, checked_at=datetime('now')`)
      .run(selector, Math.max(0, Math.round(latencyMs)));
  }

  recordProviderFailure(selector: string, errorClass: string, error: string): void {
    const current = this.database.prepare("SELECT consecutive_failures failures FROM provider_health WHERE selector=?").get(selector) as
      | { failures: number }
      | undefined;
    const failures = Number(current?.failures ?? 0) + 1;
    const circuitSeconds = failures >= 3 ? Math.min(300, 15 * 2 ** Math.min(4, failures - 3)) : 0;
    this.database
      .prepare(`INSERT INTO provider_health(selector, status, consecutive_failures, last_error_class, last_error, circuit_open_until, checked_at)
      VALUES (?, ?, ?, ?, ?, CASE WHEN ? > 0 THEN datetime('now', '+' || ? || ' seconds') END, datetime('now'))
      ON CONFLICT(selector) DO UPDATE SET status=excluded.status, consecutive_failures=excluded.consecutive_failures,
      last_error_class=excluded.last_error_class, last_error=excluded.last_error, circuit_open_until=excluded.circuit_open_until, checked_at=datetime('now')`)
      .run(
        selector,
        errorClass === "auth" ? "auth_required" : failures >= 3 ? "unavailable" : "degraded",
        failures,
        errorClass,
        redactSecrets(error).slice(0, 2_000),
        circuitSeconds,
        circuitSeconds,
      );
  }

  circuitOpen(selector: string): boolean {
    const row = this.database.prepare("SELECT circuit_open_until > datetime('now') open FROM provider_health WHERE selector=?").get(selector) as
      | { open: number }
      | undefined;
    return Boolean(row?.open);
  }

  private updateSessionFromTurn(turnId: string, status: string): void {
    this.database
      .prepare(`UPDATE sessions SET status=CASE WHEN EXISTS (
      SELECT 1 FROM turns active WHERE active.session_id=sessions.id AND active.status IN ('queued','running','waiting_approval')
    ) THEN 'running' ELSE ? END, updated_at=datetime('now')
      WHERE id=(SELECT session_id FROM turns WHERE id=?)`)
      .run(status, turnId);
  }

  private assertTaskTurnBinding(taskId: string, turnId?: string, expectedSessionId?: string): TaskTurnBinding {
    const row = this.database
      .prepare(`SELECT task.project_id task_project_id, task.session_id task_session_id,
      task.turn_id task_turn_id, session.project_id session_project_id,
      turn_record.session_id turn_session_id, turn_session.project_id turn_project_id
      FROM runtime_tasks task
      LEFT JOIN sessions session ON session.id=task.session_id
      LEFT JOIN turns turn_record ON turn_record.id=?
      LEFT JOIN sessions turn_session ON turn_session.id=turn_record.session_id
      WHERE task.id=?`)
      .get(turnId ?? null, taskId) as TaskTurnBindingRow | undefined;
    if (!row) throw new Error(`Unknown runtime task: ${taskId}`);
    const mismatch =
      row.session_project_id !== row.task_project_id ||
      (expectedSessionId !== undefined && row.task_session_id !== expectedSessionId) ||
      (turnId === undefined
        ? row.task_turn_id !== null
        : row.task_turn_id !== turnId || row.turn_session_id !== row.task_session_id || row.turn_project_id !== row.task_project_id);
    if (mismatch) {
      throw new Error(`Runtime task ${taskId} does not match its bound turn, session and project`);
    }
    return { projectId: row.task_project_id, sessionId: row.task_session_id };
  }

  private ensureProjectSingleFlight(): void {
    try {
      this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS runtime_tasks_one_active_per_project
        ON runtime_tasks(project_id) WHERE status IN ('running','waiting')`);
    } catch (error) {
      throw new Error(
        "Runtime database contains concurrent active tasks for one project; stop the extra Axiomux process and reconcile those tasks before continuing",
        { cause: error },
      );
    }
  }

  private reconcileInterruptedWork(): void {
    const explanation = "Interrupted by process restart; execution was not resumed.";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const tasks = this.database
        .prepare(`SELECT id, owner_instance, owner_pid FROM runtime_tasks
        WHERE status IN ('queued','running','waiting')`)
        .all() as unknown as ActiveOwnerRow[];
      const turns = this.database
        .prepare(`SELECT id, owner_instance, owner_pid FROM turns
        WHERE status IN ('queued','running','waiting_approval')`)
        .all() as unknown as ActiveOwnerRow[];
      const failTask = this.database.prepare(`UPDATE runtime_tasks SET status='failed', error=COALESCE(NULLIF(error, ''), ?),
        completed_at=COALESCE(completed_at, datetime('now')), updated_at=datetime('now') WHERE id=?`);
      const failTurn = this.database.prepare(`UPDATE turns SET status='failed', error=COALESCE(NULLIF(error, ''), ?),
        completed_at=COALESCE(completed_at, datetime('now')) WHERE id=?`);
      for (const task of tasks) if (!runtimeOwnerAlive(task)) failTask.run(explanation, task.id);
      for (const turn of turns) if (!runtimeOwnerAlive(turn)) failTurn.run(explanation, turn.id);
      this.database.exec(`UPDATE steering_messages SET status='failed'
        WHERE status='queued' AND turn_id IN (SELECT id FROM turns WHERE status IN ('failed','cancelled','completed'))`);
      this.database.exec(`UPDATE sessions SET status='idle', updated_at=datetime('now')
        WHERE status<>'idle' AND NOT EXISTS (
          SELECT 1 FROM turns WHERE turns.session_id=sessions.id AND turns.status IN ('queued','running','waiting_approval')
        )`);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  root_device: string | null;
  root_inode: string | null;
  root_birthtime_ns: string | null;
  linked: number;
  created_at: string;
  updated_at: string;
}
interface SessionRow {
  id: string;
  project_id: string;
  title: string | null;
  status: string;
  preferred_model: string | null;
  created_at: string;
  updated_at: string;
  messages: number;
}
interface TurnRow {
  id: string;
  session_id: string;
  sequence: number;
  input: string;
  status: TurnRecord["status"];
  model: string | null;
  output: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}
interface EventRow {
  id: number;
  session_id: string;
  turn_id: string | null;
  kind: string;
  phase: string;
  label: string;
  detail: string | null;
  model: string | null;
  tool: string | null;
  created_at: string;
}
interface SearchRow {
  session_id: string;
  project_id: string;
  project_name: string;
  role: string;
  content: string;
  created_at: string;
  rank: number;
}
interface RuntimeTaskRow {
  id: string;
  project_id: string;
  session_id: string;
  turn_id: string | null;
  title: string;
  prompt: string;
  status: RuntimeTaskStatus;
  output: string;
  model: string | null;
  error: string | null;
  started_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
interface ActiveOwnerRow {
  id: string;
  owner_instance: string | null;
  owner_pid: number | null;
}
interface TaskTurnBinding {
  projectId: string;
  sessionId: string;
}
interface PersistedRootIdentity {
  device: string;
  inode: string;
  birthtimeNanoseconds: string;
}
interface TaskTurnBindingRow {
  task_project_id: string;
  task_session_id: string;
  task_turn_id: string | null;
  session_project_id: string | null;
  turn_session_id: string | null;
  turn_project_id: string | null;
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    ...(row.root_device ? { rootDevice: row.root_device } : {}),
    ...(row.root_inode ? { rootInode: row.root_inode } : {}),
    ...(row.root_birthtime_ns ? { rootBirthtimeNanoseconds: row.root_birthtime_ns } : {}),
    linked: Boolean(row.linked),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateProjectName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    throw new Error("Project name must contain 1-120 printable characters");
  }
  return name;
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right;
}

function rootIdentity(path: string): PersistedRootIdentity {
  const info = statSync(path, { bigint: true });
  if (!info.isDirectory()) throw new Error(`Project root is not a directory: ${path}`);
  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    birthtimeNanoseconds: info.birthtimeNs.toString(),
  };
}

function projectRootIdentityMatches(project: ProjectRecord, identity: PersistedRootIdentity): boolean {
  return project.rootDevice === identity.device && project.rootInode === identity.inode && project.rootBirthtimeNanoseconds === identity.birthtimeNanoseconds;
}

function mapTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    input: row.input,
    status: row.status,
    ...(row.model ? { model: row.model } : {}),
    ...(row.output ? { output: row.output } : {}),
    ...(row.error ? { error: row.error } : {}),
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function mapTask(row: RuntimeTaskRow): RuntimeTaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    output: row.output,
    ...(row.model ? { model: row.model } : {}),
    ...(row.error ? { error: row.error } : {}),
    startedAt: row.started_at ?? row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function ensureColumn(database: DatabaseSync, table: string, column: string, definition: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return false;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

function runtimeOwnerAlive(row: ActiveOwnerRow): boolean {
  if (!row.owner_instance || !row.owner_pid) return false;
  if (row.owner_instance === runtimeOwnerId || row.owner_pid === process.pid) return true;
  try {
    process.kill(row.owner_pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
