import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { SkillRecord } from "../types.js";
import { containsSecret, redactValue } from "../security/secrets.js";

export interface SkillScanFinding {
  severity: "warning" | "danger";
  rule: string;
  detail: string;
}

export interface SkillProposal {
  skill: SkillRecord;
  findings: SkillScanFinding[];
}

export interface SkillVersionRecord {
  skillId: string;
  contentHash: string;
  path: string;
  createdAt: string;
}

export interface SkillEvaluation {
  timestamp: string;
  skillId: string;
  contentHash: string;
  passed: boolean;
  summary: string;
  actor: string;
}

export class SkillManager {
  private readonly coreDir: string;
  private readonly userDir: string;
  private readonly quarantineDir: string;
  private readonly auditPath: string;
  private readonly versionsDir: string;
  private readonly evaluationsPath: string;

  constructor(root: string) {
    this.coreDir = join(root, "skills", "core");
    this.userDir = join(root, ".superai", "skills", "user");
    this.quarantineDir = join(root, ".superai", "skills", "quarantine");
    this.auditPath = join(root, ".superai", "skill-audit.jsonl");
    this.versionsDir = join(root, ".superai", "skill-versions");
    this.evaluationsPath = join(root, ".superai", "skill-evaluations.jsonl");
    for (const path of [this.coreDir, this.userDir, this.quarantineDir, this.versionsDir, dirname(this.auditPath)]) {
      mkdirSync(path, { recursive: true });
    }
  }

  list(): SkillRecord[] {
    return [
      ...this.scanDirectory(this.coreDir, "core"),
      ...this.scanDirectory(this.userDir, "active"),
      ...this.scanDirectory(this.quarantineDir, "quarantine"),
    ];
  }

  get(id: string): SkillRecord | undefined {
    return this.list().find((skill) => skill.id === normalizeId(id));
  }

  read(skill: SkillRecord): string {
    return readSkillText(skill.path);
  }

  activePromptMetadata(): string {
    const skills = this.list()
      .filter((skill) => skill.status === "core" || skill.status === "active")
      .filter((skill) => {
        const danger = scanSkill(this.read(skill)).find((finding) => finding.severity === "danger");
        if (!danger) return true;
        this.audit("blocked-at-load", skill.id, "system", { rule: danger.rule, detail: danger.detail });
        return false;
      });
    if (skills.length === 0) return "No active skills.";
    return skills.map((skill) => `- ${skill.id}: ${skill.description}`).join("\n");
  }

  selectForPrompt(query: string, limit = 4): Array<{ skill: SkillRecord; content: string }> {
    const tokens = new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
    return this.list()
      .filter((skill) => skill.status !== "quarantine")
      .map((skill) => {
        const content = this.read(skill);
        const danger = scanSkill(content).find((finding) => finding.severity === "danger");
        if (danger) {
          this.audit("blocked-at-load", skill.id, "system", { rule: danger.rule, detail: danger.detail });
          return { skill, score: -1, content };
        }
        const haystack = `${skill.name} ${skill.description} ${skill.id}`.toLocaleLowerCase();
        const score = [...tokens].filter((token) => haystack.includes(token)).length;
        return { skill, score, content };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
      .slice(0, limit)
      .map(({ skill, content }) => ({ skill, content }));
  }

  propose(id: string, markdown: string, source = "agent"): SkillProposal {
    const normalized = normalizeId(id);
    const parsed = parseSkill(markdown);
    const findings = scanSkill(markdown);
    const danger = findings.find((finding) => finding.severity === "danger");
    if (danger) {
      this.audit("rejected", normalized, source, { findings });
      throw new Error(`Skill rejected by ${danger.rule}: ${danger.detail}`);
    }
    const directory = safeChild(this.quarantineDir, normalized);
    if (existsSync(directory)) throw new Error(`A quarantined skill already exists: ${normalized}`);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "SKILL.md");
    writeFileSync(path, `${markdown.trimEnd()}\n`, { encoding: "utf8", mode: 0o600 });
    const skill = recordFromFile(normalized, path, "quarantine", parsed);
    this.audit("proposed", normalized, source, { findings, hash: skill.contentHash });
    return { skill, findings };
  }

  approve(id: string): SkillRecord {
    const normalized = normalizeId(id);
    const sourceDir = safeChild(this.quarantineDir, normalized);
    const sourceFile = join(sourceDir, "SKILL.md");
    if (!existsSync(sourceFile)) throw new Error(`Quarantined skill not found: ${normalized}`);
    const markdown = readSkillText(sourceFile);
    const findings = scanSkill(markdown);
    const danger = findings.find((finding) => finding.severity === "danger");
    if (danger) throw new Error(`Skill can no longer be approved: ${danger.detail}`);
    const destination = safeChild(this.userDir, normalized);
    if (existsSync(destination)) {
      const activeFile = join(destination, "SKILL.md");
      if (!existsSync(activeFile)) throw new Error(`Active skill directory is invalid: ${normalized}`);
      this.archiveVersion(normalized, readSkillText(activeFile));
      writeFileSync(activeFile, `${markdown.trimEnd()}\n`, { encoding: "utf8", mode: 0o600 });
      rmSync(sourceDir, { recursive: true, force: true });
    } else {
      renameSync(sourceDir, destination);
    }
    const skill = recordFromFile(normalized, join(destination, "SKILL.md"), "active", parseSkill(markdown));
    this.archiveVersion(normalized, markdown);
    this.audit("approved", normalized, "user", { hash: skill.contentHash });
    return skill;
  }

  reject(id: string): void {
    const normalized = normalizeId(id);
    const sourceDir = safeChild(this.quarantineDir, normalized);
    if (!existsSync(sourceDir)) throw new Error(`Quarantined skill not found: ${normalized}`);
    rmSync(sourceDir, { recursive: true, force: true });
    this.audit("rejected", normalized, "user");
  }

  listVersions(id: string): SkillVersionRecord[] {
    const normalized = normalizeId(id);
    const directory = safeChild(this.versionsDir, normalized);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.md$/.test(entry.name))
      .map((entry) => {
        const path = join(directory, entry.name);
        return {
          skillId: normalized,
          contentHash: entry.name.slice(0, -3),
          path,
          createdAt: lstatSync(path).birthtime.toISOString(),
        };
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.contentHash.localeCompare(right.contentHash));
  }

  recordEvaluation(id: string, passed: boolean, summary: string, actor = "user", contentHash?: string): SkillEvaluation {
    const normalized = normalizeId(id);
    const matchingSkills = this.list().filter((item) => item.id === normalized);
    const preferred =
      matchingSkills.find((item) => item.status === "quarantine") ?? matchingSkills.find((item) => item.status === "active") ?? matchingSkills[0];
    const hash = contentHash ?? preferred?.contentHash;
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Skill ${normalized} or requested version was not found`);
    const known = matchingSkills.some((item) => item.contentHash === hash) || this.listVersions(normalized).some((version) => version.contentHash === hash);
    if (!known) throw new Error(`Skill version ${hash} was not found`);
    const safeSummary = safeAuditText(summary, "evaluation summary", 4_000);
    const safeActor = safeAuditText(actor, "evaluation actor", 120);
    const evaluation: SkillEvaluation = {
      timestamp: new Date().toISOString(),
      skillId: normalized,
      contentHash: hash,
      passed,
      summary: safeSummary,
      actor: safeActor,
    };
    appendFileSync(this.evaluationsPath, `${JSON.stringify(redactValue(evaluation))}\n`, { encoding: "utf8", mode: 0o600 });
    this.audit("evaluated", normalized, safeActor, { hash, passed, summary: safeSummary });
    return evaluation;
  }

  listEvaluations(id?: string): SkillEvaluation[] {
    if (!existsSync(this.evaluationsPath)) return [];
    const normalized = id ? normalizeId(id) : undefined;
    return readFileSync(this.evaluationsPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as SkillEvaluation;
          if (!parsed.skillId || !parsed.contentHash || typeof parsed.passed !== "boolean") return [];
          return normalized && parsed.skillId !== normalized ? [] : [parsed];
        } catch {
          return [];
        }
      });
  }

  rollback(id: string, contentHash: string): SkillRecord {
    const normalized = normalizeId(id);
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error("Invalid skill version hash");
    const version = this.listVersions(normalized).find((item) => item.contentHash === contentHash);
    if (!version) throw new Error(`Skill version ${contentHash} was not found`);
    const markdown = readSkillText(version.path);
    const danger = scanSkill(markdown).find((finding) => finding.severity === "danger");
    if (danger) throw new Error(`Archived skill can no longer be activated: ${danger.detail}`);
    const destination = safeChild(this.userDir, normalized);
    mkdirSync(destination, { recursive: true });
    const activeFile = join(destination, "SKILL.md");
    if (existsSync(activeFile)) this.archiveVersion(normalized, readSkillText(activeFile));
    writeFileSync(activeFile, `${markdown.trimEnd()}\n`, { encoding: "utf8", mode: 0o600 });
    const skill = recordFromFile(normalized, activeFile, "active", parseSkill(markdown));
    this.audit("rolled-back", normalized, "user", { hash: skill.contentHash });
    return skill;
  }

  exportGovernance(): { version: 1; exportedAt: string; versions: Array<Omit<SkillVersionRecord, "path">>; evaluations: SkillEvaluation[] } {
    const ids = new Set(this.list().map((skill) => skill.id));
    if (existsSync(this.versionsDir)) {
      for (const entry of readdirSync(this.versionsDir, { withFileTypes: true })) if (entry.isDirectory()) ids.add(entry.name);
    }
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      versions: [...ids].flatMap((id) => this.listVersions(id).map(({ path: _path, ...record }) => record)),
      evaluations: this.listEvaluations(),
    };
  }

  private archiveVersion(id: string, markdown: string): SkillVersionRecord {
    const normalized = normalizeId(id);
    const hash = createHash("sha256")
      .update(Buffer.from(`${markdown.trimEnd()}\n`, "utf8"))
      .digest("hex");
    const directory = safeChild(this.versionsDir, normalized);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${hash}.md`);
    if (!existsSync(path)) writeFileSync(path, `${markdown.trimEnd()}\n`, { encoding: "utf8", mode: 0o600 });
    return { skillId: normalized, contentHash: hash, path, createdAt: lstatSync(path).birthtime.toISOString() };
  }

  private scanDirectory(base: string, status: SkillRecord["status"]): SkillRecord[] {
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "SKILL.md")))
      .map((entry) => {
        const path = join(base, entry.name, "SKILL.md");
        const markdown = readSkillText(path);
        return recordFromFile(entry.name, path, status, parseSkill(markdown));
      });
  }

  private audit(action: string, id: string, actor: string, details: Record<string, unknown> = {}): void {
    appendFileSync(this.auditPath, `${JSON.stringify(redactValue({ timestamp: new Date().toISOString(), action, id, actor, ...details }))}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

export function scanSkill(markdown: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > 128_000) findings.push({ severity: "danger", rule: "size", detail: "SKILL.md exceeds 128 KB" });
  if (containsSecret(markdown)) findings.push({ severity: "danger", rule: "secret", detail: "Contains material resembling a credential" });
  const rules: Array<[RegExp, SkillScanFinding]> = [
    [
      /ignore (?:all |any )?(?:previous|prior|system) instructions/i,
      { severity: "danger", rule: "prompt-injection", detail: "Attempts to override instruction hierarchy" },
    ],
    [/(?:curl|wget).*(?:\||&&).*?(?:sh|bash|powershell)/i, { severity: "danger", rule: "remote-execution", detail: "Downloads and executes remote content" }],
    [
      /(?:rm\s+-rf|Remove-Item\s+.*-Recurse|format\s+[a-z]:)/i,
      { severity: "danger", rule: "destructive-command", detail: "Contains a destructive filesystem command" },
    ],
    [
      /(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|BEGIN (?:RSA |EC )?PRIVATE KEY)/,
      { severity: "danger", rule: "secret", detail: "Contains material resembling a credential" },
    ],
    [
      /\b(?:disable|bypass).{0,30}(?:approval|sandbox|security)/i,
      { severity: "danger", rule: "policy-bypass", detail: "Requests disabling a safety boundary" },
    ],
    [/\b(?:sudo|runas|elevat(?:e|ed|ion))\b/i, { severity: "warning", rule: "privilege", detail: "Mentions elevated execution; review necessity" }],
    [/\b(?:send|publish|post|email|purchase|pay)\b/i, { severity: "warning", rule: "external-side-effect", detail: "May cause an external side effect" }],
  ];
  for (const [pattern, finding] of rules) if (pattern.test(markdown)) findings.push(finding);
  if (!markdown.startsWith("---\n")) findings.push({ severity: "warning", rule: "frontmatter", detail: "Missing YAML frontmatter" });
  return findings;
}

function parseSkill(markdown: string): { name: string; description: string } {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fields = new Map<string, string>();
  if (frontmatter?.[1]) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/);
      if (match?.[1] && match[2]) fields.set(match[1], match[2].replace(/^['"]|['"]$/g, ""));
    }
  }
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1] ?? "Unnamed skill";
  return { name: fields.get("name") ?? heading, description: fields.get("description") ?? heading };
}

function recordFromFile(id: string, path: string, status: SkillRecord["status"], parsed: { name: string; description: string }): SkillRecord {
  const content = readSkillBuffer(path);
  return {
    id: normalizeId(id),
    name: parsed.name,
    description: parsed.description,
    path,
    status,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

function readSkillText(path: string): string {
  return readSkillBuffer(path).toString("utf8");
}

function readSkillBuffer(path: string): Buffer {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) throw new Error(`Skill entry must be a regular unlinked file: ${path}`);
  if (stats.size > 128_000) throw new Error(`Skill entry exceeds 128 KB: ${path}`);
  return readFileSync(path);
}

function normalizeId(id: string): string {
  const normalized = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || normalized.length > 80) throw new Error("Invalid skill id");
  return normalized;
}

function safeChild(base: string, id: string): string {
  const child = resolve(base, id);
  const rel = relative(resolve(base), child);
  if (!rel || rel.startsWith("..") || basename(child) !== id) throw new Error("Skill path escapes its root");
  return child;
}

function safeAuditText(value: string, name: string, limit: number): string {
  const result = value.trim();
  if (!result || result.length > limit) throw new Error(`${name} must contain 1-${limit} characters`);
  if (containsSecret(result)) throw new Error(`${name} appears to contain a secret`);
  return result;
}
