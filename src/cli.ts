#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";
import { AuditLog } from "./audit.js";
import { AgentTurnFailedError, SuperAgent } from "./agent.js";
import { findProjectRoot, getOmpIsolation, getPaths, getProviderRuntimeArgs, loadConfig, resolveOmpExecutable, saveConfig } from "./config.js";
import { MemoryStore } from "./memory/store.js";
import {
  applyCredentialProviderAliases,
  buildProviderSummaries,
  countAuthenticatedCredentials,
  credentialProviderId,
  providerAuthLabel,
  providerCapabilityNote,
  providerLoginSecurityWarning,
  resolveProviderId,
  uniqueAuthenticatedCredentialProviders,
} from "./providers.js";
import { NeuralwattProvider } from "./providers/neuralwatt.js";
import { OmpAuthBrokerCli, isUnsupportedRpcPreAuthPrompt } from "./providers/omp-auth-broker.js";
import { OMP_CONTRACT_VERSION, OmpRpcClient, type OmpUiHandler, type OmpUiRequest } from "./rpc/omp-client.js";
import { isSensitivePrompt } from "./security/prompt.js";
import { verifyOmpRuntime } from "./security/omp-runtime.js";
import { SkillLearner } from "./skills/learner.js";
import { SkillManager } from "./skills/manager.js";
import { SourceHub } from "./sources.js";
import { securePrivateFile, secureStateDirectory } from "./security/state.js";
import { resolveTrustedExecutable, resolveWindowsSystemExecutable } from "./security/executable.js";
import { sanitizeTerminalText } from "./security/display.js";
import { UnknownWorkflowEffectError, WorkflowEngine, type WorkflowDefinition } from "./workflow.js";
import { TaskSupervisor, type SupervisedTaskSnapshot } from "./runtime/supervisor.js";
import { RuntimeStore, type ProjectRecord } from "./runtime/store.js";
import { canonicalWorkspaceRoot, createWorkspaceIdentity } from "./runtime/project-boundary.js";
import { FusionEngine, MAX_FALLBACK_MODELS, MAX_FUSION_PARTICIPANTS, OmpFusionRunner, selectCatalogModels } from "./fusion/index.js";
import { startLocalUi, UiApprovalBroker, type UiApprovalEvent, type UiEventsRequest, type UiRoutingSettings } from "./ui/index.js";
import { identifyToolProfile, toolsForProfile } from "./tool-profiles.js";
import { UpstreamManager, type ReviewStatus, type UpstreamCheckRecord, type UpstreamListItem } from "./upstreams/manager.js";
import { parseLoginArguments } from "./cli-options.js";

const root = findProjectRoot();
const paths = getPaths(root);
const stateSecurity = secureStateDirectory(paths.stateDir);
if (!stateSecurity.hardened) {
  console.error(`Axiomux refused to start because its private state could not be secured: ${stateSecurity.detail}`);
  console.error("No database, provider, or agent was opened. Fix the .superai directory and run the command again.");
  process.exit(1);
}
const config = loadConfig(root);
const ompExecutable = resolveOmpExecutable(config.ompExecutable);
const memory = new MemoryStore(paths.database, config.memory.halfLifeDays);
const skills = new SkillManager(root);
const audit = new AuditLog(paths.auditLog);
const learner = new SkillLearner(skills, memory);
const neuralwatt = new NeuralwattProvider(root);
const runtime = new RuntimeStore(memory.database);
let installationProject = runtime.getProjectByRoot(root) ?? runtime.ensureProject(root, "Axiomux");
if (!runtime.listProjects().length) installationProject = runtime.ensureProject(root, installationProject.name || "Axiomux");
let initialProject = runtime.currentProject();
if (!initialProject || !isProjectWorkspaceAvailable(initialProject)) {
  initialProject = runtime.listProjects().find(isProjectWorkspaceAvailable);
  if (!initialProject) initialProject = runtime.ensureProject(root, installationProject.name || "Axiomux");
  runtime.useProject(initialProject.id);
}

interface ProjectContext {
  project: ProjectRecord;
  sources: SourceHub;
  agent: SuperAgent;
  supervisor: TaskSupervisor;
}

const projectContexts = new Map<string, ProjectContext>();

function projectContext(record: ProjectRecord): ProjectContext {
  const existing = projectContexts.get(record.id);
  if (existing) {
    existing.project = record;
    return existing;
  }
  if (!record.linked) throw new Error(`Project is not linked: ${record.id}`);
  if (!isProjectWorkspaceAvailable(record)) throw new Error(`Project folder is missing or no longer resolves to its registered root: ${record.rootPath}`);
  const workspaceIdentity = createWorkspaceIdentity(root, record.rootPath);
  const projectSources = new SourceHub(memory, record.rootPath, record.id, workspaceIdentity);
  const projectAgent = new SuperAgent(root, config, ompExecutable, memory, skills, projectSources, audit, undefined, { workspaceRoot: record.rootPath });
  const context = {
    project: record,
    sources: projectSources,
    agent: projectAgent,
    supervisor: new TaskSupervisor(projectAgent, record.id),
  };
  projectContexts.set(record.id, context);
  return context;
}

let project = initialProject;
let currentContext = projectContext(project);
let sources = currentContext.sources;
let agent = currentContext.agent;
let supervisor = currentContext.supervisor;

function activateProject(record: ProjectRecord, persist = true): ProjectContext {
  if (!record.linked) throw new Error(`Project is not linked: ${record.id}`);
  project = persist ? runtime.useProject(record.id) : record;
  currentContext = projectContext(project);
  sources = currentContext.sources;
  agent = currentContext.agent;
  supervisor = currentContext.supervisor;
  return currentContext;
}

function contextForProjectId(projectId: string): ProjectContext {
  const record = runtime.getProject(projectId);
  if (!record?.linked) throw new Error(`Unknown or unlinked project: ${projectId}`);
  return projectContext(record);
}

function contextForSession(sessionId: string): ProjectContext {
  const session = runtime.getSession(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return contextForProjectId(session.projectId);
}

function contextForTask(taskId: string): ProjectContext {
  const task = runtime.getTask(taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  return contextForProjectId(task.projectId);
}

function isProjectWorkspaceAvailable(record: ProjectRecord): boolean {
  try {
    const canonical = canonicalWorkspaceRoot(root, record.rootPath);
    return runtime.getProjectByRoot(canonical)?.id === record.id;
  } catch {
    return false;
  }
}
let terminal: TerminalUi;

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "doctor":
      await doctor(rest.includes("--online"));
      return;
    case "models":
      await models(rest.join(" "));
      return;
    case "providers":
      await listProviders(rest.join(" "));
      return;
    case "provider":
      await showProvider(rest[0]);
      return;
    case "login":
      await login(parseLoginArguments(rest));
      return;
    case "logout":
      await logout(rest[0]);
      return;
    case "model":
      await setModel(rest[0]);
      return;
    case "fallback":
      await fallbackCommand(rest);
      return;
    case "tools":
      toolsCommand(rest[0]);
      return;
    case "projects":
      projectsCommand(rest);
      return;
    case "search":
      searchAcrossProjects(rest.join(" "));
      return;
    case "persona":
      personaCommand(rest[0]);
      return;
    case "memory":
      await memoryCommand(rest);
      return;
    case "sessions":
      sessionsCommand(rest);
      return;
    case "skills":
      await skillsCommand(rest);
      return;
    case "source":
      await sourceCommand(rest);
      return;
    case "workflow":
      await workflowCommand(rest);
      return;
    case "fusion":
      await fusionCommand(rest);
      return;
    case "upstream":
      await upstreamCommand(rest);
      return;
    case "ui":
      await serveUi(rest);
      return;
    case "chat":
      if (!rest.length) return interactive();
      await oneTurn(rest.join(" "), randomUUID());
      return;
    case "tui":
      await interactive();
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case undefined:
      await interactive();
      return;
    default:
      await oneTurn(args.join(" "), randomUUID());
  }
}

async function interactive(): Promise<void> {
  let sessionId = randomUUID();
  let activeTaskId: string | undefined;
  let crossProjectSearch = false;
  const rendered = new Map<string, { output: number; traces: number; status: string }>();
  let unsubscribe = (): void => undefined;
  const subscribeCurrentProject = (): void => {
    unsubscribe();
    unsubscribe = supervisor.subscribe((task) => {
      if (task.sessionId === sessionId && ["queued", "running"].includes(task.status)) activeTaskId = task.id;
      renderTaskUpdate(task, rendered);
    });
  };
  subscribeCurrentProject();
  console.log(terminalSafe(`✦ Axiomux — ${config.model} — ${project.name}`, 20_000));
  console.log(`Workspace: ${terminalSafe(project.rootPath, 20_000)}`);
  console.log(
    "Concurrent TUI: type normally to steer active work; /stop interrupts, /next queues, /status inspects; /project switches projects; /search searches manually; /global on enables cross-project retrieval for the agent.\n",
  );
  while (true) {
    const active = activeTaskId ? supervisor.get(activeTaskId) : undefined;
    if (active && !["queued", "running"].includes(active.status)) activeTaskId = undefined;
    const line = (await terminal.ask(activeTaskId ? "you [steer]> " : "you> ")).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") {
      if (activeTaskId) await supervisor.send(activeTaskId, "/stop").catch(() => undefined);
      unsubscribe();
      return;
    }
    if (activeTaskId) {
      const current = supervisor.get(activeTaskId);
      if (current && ["queued", "running"].includes(current.status)) {
        if (/^\/global(?:\s|$)/iu.test(line)) {
          console.log("Cross-project retrieval cannot change while a task is active; complete or interrupt the task first.");
          continue;
        }
        if (line.startsWith("/") && !/^\/(stop|cancel|status|next|queue|follow-?up)\b/i.test(line)) {
          if (/^\/project(?:\s+\S|s\s+use\b)/i.test(line)) {
            console.log("The project was not changed while work is active; complete or interrupt the task first.");
            continue;
          }
          try {
            const result = await slash(line, sessionId);
            if (result.newSession) console.log("The session was not changed while work is active; use /new after the queue finishes.");
          } catch (error) {
            console.log(terminalSafe(`Command rejected: ${error instanceof Error ? error.message : String(error)}`, 20_000));
          }
        } else {
          const update = await supervisor.send(activeTaskId, line);
          console.log(terminalSafe(`[${update.classification}] ${update.acknowledgement}`, 20_000));
        }
        continue;
      }
      activeTaskId = undefined;
    }
    if (/^\/global(?:\s|$)/iu.test(line)) {
      const value = line.slice("/global".length).trim().toLocaleLowerCase();
      if (!value || value === "status") {
        console.log(`Agent cross-project retrieval: ${crossProjectSearch ? "ON" : "OFF"}. /search remains available manually.`);
      } else if (["on", "enable", "1"].includes(value)) {
        crossProjectSearch = true;
        console.log("Cross-project retrieval ON: the next task may retrieve content from other projects and send it to the selected provider.");
      } else if (["off", "disable", "0"].includes(value)) {
        crossProjectSearch = false;
        console.log("Cross-project retrieval OFF: the agent is limited to the current project and global memory.");
      } else {
        console.log("Usage: /global on|off|status");
      }
      continue;
    }
    if (line.startsWith("/")) {
      try {
        const result = await slash(line, sessionId);
        if (result.newSession) sessionId = randomUUID();
        if (result.projectChanged) {
          activeTaskId = undefined;
          rendered.clear();
          subscribeCurrentProject();
          console.log(terminalSafe(`Active project: ${project.name}\nWorkspace: ${project.rootPath}`, 20_000));
        }
      } catch (error) {
        console.log(terminalSafe(`Command rejected: ${error instanceof Error ? error.message : String(error)}`, 20_000));
      }
      continue;
    }
    const task = supervisor.start(line, {
      sessionId,
      ...(crossProjectSearch ? { crossProjectSearch: true } : {}),
      approve: (description) => terminal.confirm(`Approve external action?\n${description}`),
      uiHandler: terminal.ompHandler,
    });
    activeTaskId = task.id;
    void supervisor
      .wait(task.id)
      .then((result) => {
        if (result.learningCandidateId) console.log(`\n[learning] Candidate ${result.learningCandidateId} saved for review.`);
      })
      .catch(() => undefined);
  }
}

function renderTaskUpdate(task: SupervisedTaskSnapshot, rendered: Map<string, { output: number; traces: number; status: string }>): void {
  const previous = rendered.get(task.id) ?? { output: 0, traces: 0, status: "" };
  if (task.output.length > previous.output) {
    if (previous.output === 0) process.stdout.write("\naxiomux> ");
    writeUntrustedTerminal(task.output.slice(previous.output));
  }
  for (const event of task.trace.slice(previous.traces)) {
    if (event.kind === "reasoning" || event.kind === "tool" || event.phase === "failed") {
      writeUntrustedTerminal(`\n[${event.kind}/${event.phase}] ${event.label}${event.detail ? ` — ${event.detail}` : ""}\n`);
    }
  }
  if (previous.status !== task.status && ["completed", "failed", "cancelled"].includes(task.status)) {
    writeUntrustedTerminal(`\n[task ${task.status}]${task.error ? ` ${task.error}` : ""}\n`);
  }
  rendered.set(task.id, { output: task.output.length, traces: task.trace.length, status: task.status });
}

async function slash(line: string, sessionId: string): Promise<{ newSession?: boolean; projectChanged?: boolean }> {
  const [name, ...args] = splitArgs(line.slice(1));
  switch (name) {
    case "help":
      printHelp();
      break;
    case "login":
      await login(parseLoginArguments(args));
      break;
    case "logout":
      await logout(args[0]);
      break;
    case "providers":
      await listProviders(args.join(" "));
      break;
    case "provider":
      await showProvider(args[0]);
      break;
    case "models":
      await models(args.join(" "));
      break;
    case "model":
      await setSessionModel(args[0], sessionId);
      break;
    case "fallback":
      await fallbackCommand(args);
      break;
    case "persona":
      personaCommand(args[0]);
      break;
    case "memory":
      await memoryCommand(args);
      break;
    case "sessions":
      sessionsCommand(args);
      break;
    case "projects": {
      projectsCommand(args);
      if (args[0] === "use") return { newSession: true, projectChanged: true };
      break;
    }
    case "project": {
      if (!args.length) {
        projectsCommand(["current"]);
        break;
      }
      projectsCommand(["use", ...args]);
      return { newSession: true, projectChanged: true };
    }
    case "search":
      searchAcrossProjects(args.join(" "));
      break;
    case "remember":
      await memoryCommand(["add", args.join(" ")]);
      break;
    case "skills":
      await skillsCommand(args);
      break;
    case "learn":
      await learn(args.join(" "), sessionId);
      break;
    case "source":
      await sourceCommand(args);
      break;
    case "fusion":
      await fusionCommand(args);
      break;
    case "upstream":
      await upstreamCommand(args);
      break;
    case "doctor":
      await doctor(args.includes("--online"));
      break;
    case "new":
      console.log("New local session created.");
      return { newSession: true };
    default:
      console.log(terminalSafe(`Unknown command: /${name}. Use /help.`));
  }
  return {};
}

async function oneTurn(prompt: string, sessionId: string): Promise<void> {
  process.stdout.write("axiomux> ");
  let streamed = false;
  const result = await agent.runTurn(prompt, {
    sessionId,
    onDelta: (delta) => {
      streamed = true;
      writeUntrustedTerminal(delta);
    },
    approve: (description) => terminal.confirm(`Approve external action?\n${description}`),
    uiHandler: terminal.ompHandler,
  });
  if (!streamed) writeUntrustedTerminal(result.text);
  process.stdout.write("\n");
  if (result.learningCandidateId) {
    console.log(`[learning] Candidate ${result.learningCandidateId} saved for review; nothing was activated automatically.`);
  }
  if (result.selfEvaluationMemoryId) console.log(`[self-evaluation] Memory ${result.selfEvaluationMemoryId} saved as pending evidence.`);
  if (result.episodicMemoryId) console.log(`[episode] Memory ${result.episodicMemoryId} saved locally as a pending summary.`);
}

async function login(options: { provider?: string; openBrowser: boolean }): Promise<void> {
  const provider = options.provider;
  if (provider && resolveProviderId(provider) === "neuralwatt") {
    await loginNeuralwatt(options.openBrowser);
    return;
  }
  const isolation = getOmpIsolation(config, root);
  const client = new OmpRpcClient({
    executable: ompExecutable,
    versionContract: OMP_CONTRACT_VERSION,
    extraArgs: getProviderRuntimeArgs(root),
    cwd: root,
    profile: config.ompProfile,
    approvalMode: "always-ask",
    tools: [],
    envAllowlist: config.ompEnvAllowlist,
    bootstrapWithoutModel: true,
    ...(isolation ? { isolation } : {}),
    uiHandler: terminal.ompHandlerFor({ openExternalUrls: options.openBrowser }),
  });
  try {
    await client.start();
    const providers = mergeLoginProviders(await client.getLoginProviders());
    let selected = provider ? resolveProviderId(provider) : undefined;
    if (!selected) {
      const available = providers.filter((item) => item.available);
      available.forEach((item, index) => {
        console.log(terminalSafe(`${String(index + 1).padStart(2)}. ${item.authenticated ? "✓" : "○"} ${item.name} (${item.id})`, 20_000));
      });
      const answer = await terminal.ask("Provider (number or ID): ");
      const index = Number(answer) - 1;
      selected = Number.isInteger(index) && available[index] ? available[index].id : resolveProviderId(answer);
    }
    const match = providers.find((item) => item.id === selected && item.available);
    if (!match) throw new Error(`Login provider is unavailable: ${selected}`);
    if (match.id === "neuralwatt") {
      await loginNeuralwatt(options.openBrowser);
      return;
    }
    console.log(terminalSafe(`Axiomux login: ${match.name}`));
    const callbackWarning = providerLoginSecurityWarning(match.id);
    if (callbackWarning) {
      console.log(terminalSafe(`SECURITY WARNING: ${callbackWarning}`, 20_000));
      if (!(await terminal.confirm("Continue this callback login on the current network?")))
        throw new Error("Login cancelled before opening the local callback");
    }
    try {
      await client.login(match.id);
    } catch (error) {
      if (!isUnsupportedRpcPreAuthPrompt(error, match.id)) throw error;
      // The exact pinned OMP RPC intentionally rejects providers such as
      // Perplexity when they need email/OTP input before an auth URL exists.
      // Stop its database reader, then run OMP's official local vault command
      // in the same isolated HOME/agent directory with the user's terminal.
      await client.stop();
      console.log("This provider requests input before opening a URL; continuing through OMP's official interactive route in the same isolated vault.");
      await terminal.withInheritedTerminal(() => ompAuthBrokerCli().login(match.id));
      await verifyProviderCredential(match.id, true);
    }
    console.log(terminalSafe(`Authentication completed for ${match.id}.`, 20_000));
    console.log(terminalSafe(`Next step: npm run dev -- models ${credentialProviderId(match.id)}`, 20_000));
  } finally {
    await client.stop().catch(() => undefined);
  }
}

async function logout(provider?: string): Promise<void> {
  const client = diagnosticClient();
  let selected = provider ? resolveProviderId(provider) : undefined;
  let match: { id: string; name: string; available: boolean; authenticated: boolean } | undefined;
  try {
    await client.start();
    const providers = mergeLoginProviders(await client.getLoginProviders());
    if (!selected) {
      const authenticated = uniqueAuthenticatedCredentialProviders(providers);
      if (!authenticated.length) {
        console.log("No credentials are stored in this isolated vault.");
        return;
      }
      authenticated.forEach((item, index) => {
        console.log(terminalSafe(`${String(index + 1).padStart(2)}. ${item.name} (${item.id})`, 20_000));
      });
      const answer = await terminal.ask("Provider to log out (number or ID): ");
      const index = Number(answer) - 1;
      selected = Number.isInteger(index) && authenticated[index] ? authenticated[index].id : resolveProviderId(answer);
    }
    match = providers.find((item) => item.id === selected);
    if (!match) throw new Error(`Unknown provider: ${selected}`);
    if (!match.authenticated) {
      console.log(terminalSafe(`No credential is stored for ${match.id}.`, 20_000));
      return;
    }
  } finally {
    await client.stop().catch(() => undefined);
  }

  if (!(await terminal.confirm(`Remove every credential stored for ${match.name} (${match.id}) from this isolated vault?`))) {
    console.log("Logout cancelled; no credentials were changed.");
    return;
  }
  if (match.id === "neuralwatt") {
    if (process.env.NEURALWATT_API_KEY?.trim()) {
      throw new Error("The Neuralwatt credential comes from NEURALWATT_API_KEY; remove that environment variable to log out");
    }
    if (!neuralwatt.logout()) throw new Error("No DPAPI-protected Neuralwatt credential was found");
    console.log("Neuralwatt credential removed. The secret-free catalog was preserved for a future login.");
    return;
  }
  console.log(terminalSafe(`Axiomux logout: ${match.name}`));
  const credentialId = credentialProviderId(match.id);
  await terminal.withInheritedTerminal(() => ompAuthBrokerCli().logout(credentialId));
  await verifyProviderCredential(credentialId, false);
  console.log(
    terminalSafe(`Every credential stored for ${credentialId} was removed${credentialId === match.id ? "." : ` (selected login: ${match.id}).`}`, 20_000),
  );
}

function ompAuthBrokerCli(): OmpAuthBrokerCli {
  const isolation = getOmpIsolation(config, root);
  if (!isolation) throw new Error("OMP auth-broker fallback requires strict isolation");
  return new OmpAuthBrokerCli({
    executable: ompExecutable,
    versionContract: OMP_CONTRACT_VERSION,
    cwd: root,
    isolation,
    interactiveTerminal: Boolean(input.isTTY && output.isTTY),
  });
}

async function verifyProviderCredential(providerId: string, expected: boolean): Promise<void> {
  const credentialId = credentialProviderId(providerId);
  const verification = diagnosticClient();
  try {
    await verification.start();
    const provider = (await verification.getLoginProviders()).find((item) => item.id === credentialId);
    if (!provider || provider.authenticated !== expected) {
      const operation = expected ? "login" : "logout";
      throw new Error(`OMP completed the interactive ${operation}, but the isolated vault did not report the expected ${credentialId} credential state`);
    }
  } finally {
    await verification.stop().catch(() => undefined);
  }
}

async function loginNeuralwatt(openBrowser = true): Promise<void> {
  console.log("Axiomux login: Neuralwatt Cloud");
  console.log(`${openBrowser ? "Opening" : "Open"} the Neuralwatt portal: https://portal.neuralwatt.com/`);
  console.log("Copy or create an API key, then return to this terminal.");
  if (openBrowser) openExternal("https://portal.neuralwatt.com/");
  const apiKey = await terminal.askSecret("Neuralwatt API key: ");
  const result = await neuralwatt.login(apiKey);
  console.log(`Authentication completed; the key was validated and protected with Windows DPAPI. ${result.models.length} model(s) configured.`);
  console.log("The key was not written to the repository or model file.");
}

async function listProviders(filter = ""): Promise<void> {
  const client = diagnosticClient();
  try {
    await client.start();
    const [nativeLogins, ompModels] = await Promise.all([client.getLoginProviders(), client.getModels()]);
    const availableModels = mergeAvailableModels(ompModels);
    const logins = mergeLoginProviders(nativeLogins);
    const query = filter.trim().toLocaleLowerCase();
    const summaries = buildProviderSummaries(logins, availableModels, config.model).filter(
      (item) => !query || `${item.id} ${item.name} ${providerAuthLabel(item)}`.toLocaleLowerCase().includes(query),
    );
    const width = Math.min(34, Math.max(10, ...summaries.map((item) => item.id.length)));
    console.log(`${"provider".padEnd(width)}  auth/configuration              models  name`);
    for (const item of summaries) {
      const marker = item.current ? "→" : " ";
      console.log(
        terminalSafe(
          `${marker}${item.id.padEnd(width - 1)}  ${providerAuthLabel(item).padEnd(27)}  ${String(item.modelCount).padStart(7)}  ${item.name}`,
          20_000,
        ),
      );
    }
    console.log(
      `${summaries.length} provider route(s); ${countAuthenticatedCredentials(logins)} distinct stored credential(s); ${availableModels.length} available model(s).`,
    );
  } finally {
    await client.stop().catch(() => undefined);
  }
}

async function showProvider(provider?: string): Promise<void> {
  const id = resolveProviderId(provider ?? config.model.split("/", 1)[0] ?? "");
  const client = diagnosticClient();
  try {
    await client.start();
    const [nativeLogins, ompModels] = await Promise.all([client.getLoginProviders(), client.getModels()]);
    const availableModels = mergeAvailableModels(ompModels);
    const logins = mergeLoginProviders(nativeLogins);
    const summary = buildProviderSummaries(logins, availableModels, config.model).find((item) => item.id === id);
    if (!summary) throw new Error(`Unknown provider: ${id}`);
    console.log(terminalSafe(`${summary.name} (${summary.id})`, 20_000));
    console.log(`Status: ${providerAuthLabel(summary)}; ${summary.modelCount} available model(s)${summary.current ? "; current provider" : ""}.`);
    const capabilityNote = providerCapabilityNote(summary.id);
    if (capabilityNote) console.log(`Capability: ${capabilityNote}`);
    if (summary.authenticated && summary.modelCount === 0 && !capabilityNote)
      console.log("Warning: the vault contains a credential but no usable model; renew the login and check again.");
    if (!summary.authenticated && summary.loginAvailable) console.log(`Authenticate: npm run dev -- login ${summary.id}`);
    for (const model of availableModels.filter((item) => item.provider === id).slice(0, 200)) {
      console.log(terminalSafe(`  ${model.selector}${model.reasoning ? " [reasoning]" : ""}${model.selector === config.model ? "  ← current" : ""}`, 20_000));
    }
  } finally {
    await client.stop().catch(() => undefined);
  }
}

async function models(filter = ""): Promise<void> {
  const client = diagnosticClient();
  try {
    await client.start();
    const query = filter.toLocaleLowerCase();
    const list = mergeAvailableModels(await client.getModels()).filter(
      (model) => !query || `${model.selector} ${model.name ?? ""}`.toLocaleLowerCase().includes(query),
    );
    for (const model of list.slice(0, 200)) {
      console.log(terminalSafe(`${model.selector}${model.reasoning ? " [reasoning]" : ""}${model.selector === config.model ? "  ← current" : ""}`, 20_000));
    }
    if (list.length > 200) console.log(`… and ${list.length - 200} more; use a filter.`);
    console.log(`${list.length} model(s).`);
  } finally {
    await client.stop().catch(() => undefined);
  }
}

async function setModel(selector?: string): Promise<void> {
  if (!selector) {
    console.log(terminalSafe(config.model));
    return;
  }
  const client = resolveProviderId(selector.split("/", 1)[0] ?? "") === "neuralwatt" ? modelRuntimeClient(selector) : diagnosticClient();
  try {
    await client.start();
    await client.setModel(selector);
    config.model = selector;
    saveConfig(config, root);
    console.log(terminalSafe(`Current model: ${selector}`, 20_000));
  } finally {
    await client.stop().catch(() => undefined);
  }
}

async function fallbackCommand(args: string[]): Promise<void> {
  const [action = "status", ...rest] = args;
  if (action === "status") {
    if (!config.fallbackModels.length) console.log("Global fallback: OFF (empty by default).");
    else {
      console.log(`Global fallback: ${config.fallbackModels.length} route(s), in order:`);
      config.fallbackModels.forEach((model, index) => {
        console.log(terminalSafe(`  ${index + 1}. ${model}`, 20_000));
      });
    }
    console.log(
      "Applies only to the global model when retrying is safe. A route selected explicitly per session or request is exact: it uses neither fallback nor Fusion.",
    );
    return;
  }
  if (action === "clear") {
    config.fallbackModels = [];
    saveConfig(config, root);
    console.log("Global fallback cleared; failures from the global model will no longer switch providers.");
    return;
  }
  if (action === "set") {
    if (!rest.length) throw new Error("Usage: fallback set <provider/model> [provider/model ...] | fallback clear");
    const catalog = await unifiedModelCatalog();
    const selected = selectCatalogModels(rest, catalog, {
      label: "Fallback",
      minimum: 1,
      maximum: MAX_FALLBACK_MODELS,
    });
    const fallbacks = selected.filter((model) => model !== config.model);
    if (!fallbacks.length) throw new Error(`The primary model ${config.model} cannot be its own fallback`);
    config.fallbackModels = fallbacks;
    saveConfig(config, root);
    console.log(`Global fallback saved with ${fallbacks.length} distinct route(s). It is attempted only before any consequential effect.`);
    console.log("Routes selected explicitly per session or request remain exact and never inherit this list or Fusion.");
    return;
  }
  throw new Error("Usage: fallback status|set <provider/model...>|clear");
}

async function fusionCommand(args: string[]): Promise<void> {
  const [action = "status", ...rest] = args;
  if (action === "status") {
    const synthesis = config.fusion.synthesisModel || config.fusion.models[0] || "not configured";
    console.log(`Fusion/MoA: ${config.fusion.enabled ? "ON" : "OFF"}; mode=${config.fusion.mode}; maxParallel=${config.fusion.maxParallel}`);
    console.log(
      terminalSafe(
        `Participants (${config.fusion.models.length}/${MAX_FUSION_PARTICIPANTS}): ${config.fusion.models.length ? config.fusion.models.join(", ") : "none"}`,
        100_000,
      ),
    );
    console.log(`Synthesizer/judge: ${terminalSafe(synthesis, 20_000)}${config.fusion.synthesisModel ? "" : " (automatic: first participant)"}`);
    console.log(
      config.fusion.enabled
        ? "Privacy/cost: the request text is sent to every configured participant; only the primary agent receives tools."
        : "Fusion is off; normal requests are not shared with consultants.",
    );
    console.log("A route selected explicitly per session or request never activates this fan-out or fallback.");
    return;
  }
  if (action === "disable") {
    config.fusion.enabled = false;
    saveConfig(config, root);
    console.log("Fusion/MoA disabled.");
    return;
  }
  if (action === "participants") {
    const catalog = await unifiedModelCatalog();
    config.fusion.models = selectCatalogModels(rest, catalog, {
      label: "Fusion/MoA participants",
      minimum: 2,
      maximum: MAX_FUSION_PARTICIPANTS,
    });
    saveConfig(config, root);
    console.log(`${config.fusion.models.length} participant(s) saved without changing the ${config.fusion.enabled ? "ON" : "OFF"} state.`);
    return;
  }
  if (action === "synthesis") {
    const requested = rest[0];
    if (!requested || rest.length !== 1) throw new Error("Usage: fusion synthesis <provider/model|auto>");
    if (requested === "auto") config.fusion.synthesisModel = "";
    else {
      const catalog = await unifiedModelCatalog();
      config.fusion.synthesisModel = firstSelectedModel(
        selectCatalogModels([requested], catalog, {
          label: "Fusion synthesizer",
          minimum: 1,
          maximum: 1,
        }),
      );
    }
    saveConfig(config, root);
    console.log(`Synthesizer/judge: ${config.fusion.synthesisModel || "automatic (first participant)"}.`);
    return;
  }
  if (action === "parallel") {
    if (rest.length !== 1) throw new Error(`Usage: fusion parallel <1-${MAX_FUSION_PARTICIPANTS}>`);
    config.fusion.maxParallel = parseFusionParallel(rest[0]);
    saveConfig(config, root);
    console.log(`Fusion concurrency saved: ${config.fusion.maxParallel}.`);
    return;
  }
  if (action === "mode") {
    const mode = rest[0];
    if ((mode !== "moa" && mode !== "fusion") || rest.length !== 1) throw new Error("Usage: fusion mode <moa|fusion>");
    config.fusion.mode = mode;
    saveConfig(config, root);
    console.log(`Fusion mode saved: ${mode}.`);
    return;
  }
  if (action === "enable" && rest.length === 0) {
    const catalog = await unifiedModelCatalog();
    config.fusion.models = selectCatalogModels(config.fusion.models, catalog, {
      label: "Fusion/MoA participants",
      minimum: 2,
      maximum: MAX_FUSION_PARTICIPANTS,
    });
    if (config.fusion.synthesisModel) {
      selectCatalogModels([config.fusion.synthesisModel], catalog, { label: "Fusion synthesizer", minimum: 1, maximum: 1 });
    }
    config.fusion.enabled = true;
    saveConfig(config, root);
    console.log(`Fusion/MoA enabled in ${config.fusion.mode} mode with ${config.fusion.models.length} participants.`);
    return;
  }
  if (["enable", "set", "configure"].includes(action)) {
    const parsed = parseFusionSetup(rest);
    const catalog = await unifiedModelCatalog();
    const models = selectCatalogModels(parsed.models, catalog, {
      label: "Fusion/MoA participants",
      minimum: 2,
      maximum: MAX_FUSION_PARTICIPANTS,
    });
    const synthesisModel =
      parsed.synthesisModel === undefined
        ? parsed.mode === "fusion"
          ? firstSelectedModel(models)
          : ""
        : parsed.synthesisModel === "auto"
          ? ""
          : firstSelectedModel(
              selectCatalogModels([parsed.synthesisModel], catalog, {
                label: "Fusion synthesizer",
                minimum: 1,
                maximum: 1,
              }),
            );
    config.fusion = {
      ...config.fusion,
      enabled: true,
      mode: parsed.mode,
      models,
      synthesisModel,
      maxParallel: parsed.maxParallel ?? config.fusion.maxParallel,
    };
    saveConfig(config, root);
    console.log(`${parsed.mode === "fusion" ? "Fusion" : "MoA"} enabled with ${models.length} participants and concurrency ${config.fusion.maxParallel}.`);
    console.log(
      "Every participant receives the request text; only the primary agent receives tools. Exact per-session or per-request routes bypass this panel.",
    );
    return;
  }
  if (action === "run") {
    const requestedMode = rest[0];
    const mode = requestedMode === "moa" || requestedMode === "fusion" ? requestedMode : config.fusion.mode;
    const prompt = (requestedMode === "moa" || requestedMode === "fusion" ? rest.slice(1) : rest).join(" ").trim();
    if (!prompt) throw new Error("Usage: fusion run [moa|fusion] <request>");
    const catalog = await unifiedModelCatalog();
    const participants = selectCatalogModels(config.fusion.models, catalog, {
      label: "Fusion/MoA participants",
      minimum: 2,
      maximum: MAX_FUSION_PARTICIPANTS,
    });
    const synthesisModel = config.fusion.synthesisModel
      ? firstSelectedModel(selectCatalogModels([config.fusion.synthesisModel], catalog, { label: "Fusion synthesizer", minimum: 1, maximum: 1 }))
      : firstSelectedModel(participants);
    const isolation = getOmpIsolation(config, root);
    const engine = new FusionEngine({
      runner: new OmpFusionRunner({
        executable: ompExecutable,
        cwd: project.rootPath,
        thinkingLevel: config.thinkingLevel,
        profile: config.ompProfile,
        envAllowlist: config.ompEnvAllowlist,
        environmentForModel: (model) => neuralwatt.runtimeEnvironmentForModel(model),
        ...(isolation ? { isolation } : {}),
      }),
      models: participants,
      synthesisModel,
      maxParallel: config.fusion.maxParallel,
      candidateTimeoutMs: config.fusion.candidateTimeoutMs,
    });
    const result = await engine.run(prompt, { mode });
    console.log(terminalSafe(result.aggregatorContext, 1_000_000));
    console.log(`\n${result.usableCandidates}/${result.candidates.length} usable participants.`);
    return;
  }
  throw new Error("Usage: fusion status|enable|set|participants|synthesis|parallel|mode|disable|run");
}

async function upstreamCommand(args: string[]): Promise<void> {
  const manager = new UpstreamManager({ projectRoot: root });
  const [action = "list", ...rest] = args;
  if (action === "list") {
    if (rest.length) throw new Error("Usage: upstream list");
    console.log("Selective upstream mechanism radar (GitHub metadata only; never downloads patches or applies changes):");
    for (const item of manager.list()) printUpstreamItem(item, false);
    console.log("Use `upstream check <id>` to conserve GitHub's public rate limit; `--all` is explicit and may hit rate limiting.");
    return;
  }
  if (action === "check") {
    if (rest.length === 0) {
      console.log("Choose an upstream: `upstream check <id>`. For a deliberate sweep: `upstream check --all` (may exceed GitHub's public rate limit).");
      return;
    }
    const requested = rest[0];
    if (!requested || rest.length !== 1) throw new Error("Usage: upstream check <id|--all>");
    const records = await manager.check(requested === "--all" ? undefined : requested);
    for (const record of records) printUpstreamRecord(record);
    console.log("No patches or code were downloaded or applied; only GitHub metadata was retrieved. Review it and mark each result explicitly.");
    return;
  }
  if (action === "show") {
    const id = rest[0];
    if (!id || rest.length !== 1) throw new Error("Usage: upstream show <id>");
    printUpstreamItem(manager.show(id), true);
    return;
  }
  if (action === "mark") {
    const [id, status, ...noteParts] = rest;
    if (!id || !status || !["pending", "reviewed", "dismissed"].includes(status)) {
      throw new Error("Usage: upstream mark <id> pending|reviewed|dismissed [note]");
    }
    const record = manager.mark(id, status as ReviewStatus, noteParts.length ? noteParts.join(" ") : undefined);
    printUpstreamRecord(record);
    return;
  }
  throw new Error("Usage: upstream list|check <id|--all>|show <id>|mark <id> pending|reviewed|dismissed [note]");
}

function printUpstreamItem(item: UpstreamListItem, detailed: boolean): void {
  const baseline = item.definition.baseline?.release ?? item.definition.baseline?.ref ?? "no audited baseline";
  const last = item.lastCheck ? `${item.lastCheck.checkStatus}/${item.lastCheck.reviewStatus}` : "not checked yet";
  console.log(
    terminalSafe(
      `- ${item.definition.id}: baseline=${baseline}; status=${last}; license=${item.definition.license.spdx}; reuse=${item.definition.license.codeReuseAllowed ? "allowed with review" : "ideas only"}`,
      20_000,
    ),
  );
  if (!detailed) return;
  console.log(terminalSafe(`  role: ${item.definition.role}`, 20_000));
  console.log(terminalSafe(`  repository: https://github.com/${item.definition.owner}/${item.definition.repo}`, 20_000));
  console.log(terminalSafe(`  includes: ${item.definition.monitorIncludes.join(", ")}`, 20_000));
  console.log(terminalSafe(`  ignores: ${item.definition.monitorExcludes.join(", ") || "nothing"}`, 20_000));
  if (item.lastCheck) printUpstreamRecord(item.lastCheck);
}

function printUpstreamRecord(record: UpstreamCheckRecord): void {
  const target = record.target ? `${record.target.ref}@${record.target.sha.slice(0, 12)}` : "unavailable";
  console.log(terminalSafe(`[${record.id}] check=${record.checkStatus}; review=${record.reviewStatus}; target=${target}; ${record.checkedAt}`, 20_000));
  if (record.error) console.log(terminalSafe(`  error: ${record.error}`, 20_000));
  for (const file of record.relevantFiles) console.log(terminalSafe(`  file ${file.status}: ${file.filename}`, 20_000));
  for (const commit of record.relevantCommits) {
    const message = commit.message.split(/\r?\n/u, 1)[0] ?? "commit without a message";
    console.log(terminalSafe(`  commit ${commit.sha.slice(0, 12)}: ${message}`, 20_000));
  }
}

function parseFusionSetup(args: string[]): {
  mode: "moa" | "fusion";
  models: string[];
  synthesisModel?: string;
  maxParallel?: number;
} {
  const mode = args[0];
  if (mode !== "moa" && mode !== "fusion") {
    throw new Error("Usage: fusion enable <moa|fusion> <provider/model...> [--synthesis provider/model|auto] [--max-parallel N]");
  }
  const models: string[] = [];
  let synthesisModel: string | undefined;
  let maxParallel: number | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (token === "--synthesis") {
      const value = args[index + 1];
      if (synthesisModel !== undefined || !value) throw new Error("--synthesis requires exactly one provider/model or auto");
      synthesisModel = value;
      index += 1;
    } else if (token === "--max-parallel") {
      const value = args[index + 1];
      if (maxParallel !== undefined || !value) throw new Error("--max-parallel requires exactly one number");
      maxParallel = parseFusionParallel(value);
      index += 1;
    } else if (token.startsWith("--")) {
      throw new Error(`Unknown Fusion option: ${token}`);
    } else {
      models.push(token);
    }
  }
  return { mode, models, ...(synthesisModel !== undefined ? { synthesisModel } : {}), ...(maxParallel !== undefined ? { maxParallel } : {}) };
}

function parseFusionParallel(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_FUSION_PARTICIPANTS) {
    throw new Error(`maxParallel must be an integer between 1 and ${MAX_FUSION_PARTICIPANTS}`);
  }
  return parsed;
}

function firstSelectedModel(models: readonly string[]): string {
  const first = models[0];
  if (!first) throw new Error("The model selection is empty");
  return first;
}

async function serveUi(args: string[]): Promise<void> {
  const noOpen = args.includes("--no-open");
  const portIndex = args.indexOf("--port");
  const portValue = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;
  if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65_535) throw new Error("--port must be between 0 and 65535");

  let catalogPromise: Promise<{ logins: ReturnType<typeof mergeLoginProviders>; models: Awaited<ReturnType<OmpRpcClient["getModels"]>> }> | undefined;
  let catalogExpires = 0;
  const catalog = (): Promise<{ logins: ReturnType<typeof mergeLoginProviders>; models: Awaited<ReturnType<OmpRpcClient["getModels"]>> }> => {
    if (catalogPromise && Date.now() < catalogExpires) return catalogPromise;
    catalogExpires = Date.now() + 10_000;
    catalogPromise = (async () => {
      const client = diagnosticClient();
      try {
        await client.start();
        const [nativeLogins, models] = await Promise.all([client.getLoginProviders(), client.getModels()]);
        return { logins: mergeLoginProviders(nativeLogins), models: mergeAvailableModels(models) };
      } finally {
        await client.stop().catch(() => undefined);
      }
    })().catch((error) => {
      catalogPromise = undefined;
      catalogExpires = 0;
      throw error;
    });
    return catalogPromise;
  };

  const approvals = new UiApprovalBroker();
  const uiContexts = runtime
    .listProjects()
    .filter(isProjectWorkspaceAvailable)
    .map((item) => projectContext(item));
  const routingSettings = (): UiRoutingSettings => ({
    fallbackModels: [...config.fallbackModels],
    fusion: {
      enabled: config.fusion.enabled,
      mode: config.fusion.mode,
      models: [...config.fusion.models],
      synthesisModel: config.fusion.synthesisModel,
      maxParallel: config.fusion.maxParallel,
    },
  });
  const cancelFinishedApprovals = uiContexts.map((context) =>
    context.supervisor.subscribe((task) => {
      if (["completed", "failed", "cancelled"].includes(task.status)) approvals.cancelTask(task.id);
    }),
  );
  const server = await startLocalUi({
    port: portValue,
    staticRoot: join(root, "ui"),
    callbacks: {
      listProjects: () => {
        const currentProjectId = runtime.currentProject()?.id;
        return {
          projects: runtime.listProjects().map((item) => ({
            ...item,
            available: isProjectWorkspaceAvailable(item),
            current: item.id === currentProjectId,
          })),
        };
      },
      listSessions: (projectId) => {
        const selectedProject = projectId || project.id;
        contextForProjectId(selectedProject);
        return { sessions: runtime.listSessions(selectedProject) };
      },
      listMessages: (sessionId) => {
        contextForSession(sessionId);
        return { messages: memory.recentMessages(sessionId, 200) };
      },
      createSession: (projectId, title) => {
        contextForProjectId(projectId);
        const sessionId = randomUUID();
        runtime.attachSession(projectId, sessionId, title ?? "New session");
        return runtime.listSessions(projectId).find((item) => item.id === sessionId) ?? { id: sessionId, title: title ?? "New session" };
      },
      search: (request) => {
        if (!request.query.trim()) return { items: [] };
        if (request.projectId) contextForProjectId(request.projectId);
        let scopedProjectId = request.projectId;
        if (request.sessionId) {
          const session = runtime.getSession(request.sessionId);
          if (!session || (request.projectId && session.projectId !== request.projectId)) throw new Error("Session does not belong to the selected project");
          scopedProjectId = session.projectId;
        }
        const messages = runtime.searchMessages(request.query, 50, scopedProjectId, request.sessionId);
        const memories = scopedProjectId
          ? memory.recall(request.query, request.sessionId ?? "ui-search", 12, scopedProjectId, false)
          : recallAcrossProjects(request.query, 12);
        return { items: [...memories, ...messages] };
      },
      listTasks: (sessionId) => {
        if (sessionId)
          return {
            tasks: contextForSession(sessionId)
              .supervisor.list()
              .filter((task) => task.sessionId === sessionId),
          };
        return { tasks: uiContexts.flatMap((context) => context.supervisor.list()) };
      },
      listProviders: async () => {
        const value = await catalog();
        return { providers: buildProviderSummaries(value.logins, value.models, config.model).map((item) => ({ ...item, label: item.name })) };
      },
      listModels: async (providerId) => {
        const value = await catalog();
        return {
          models: value.models
            .filter((item) => !providerId || item.provider === providerId)
            .map((item) => ({ ...item, id: item.selector, label: item.name ?? item.selector, current: item.selector === config.model }))
            .sort((left, right) => Number(right.current) - Number(left.current) || left.selector.localeCompare(right.selector)),
        };
      },
      getRouting: () => routingSettings(),
      updateRouting: async (request) => {
        const active = uiContexts.flatMap((context) => context.supervisor.list()).find((task) => ["queued", "running"].includes(task.status));
        if (active) throw new Error(`Routing cannot change while task ${active.id} is active`);
        const available = (await catalog()).models;
        const fallbackModels = selectCatalogModels(request.fallbackModels, available, {
          label: "Global fallback",
          minimum: 0,
          maximum: MAX_FALLBACK_MODELS,
        });
        if (fallbackModels.includes(config.model)) throw new Error("The primary global model cannot also be its fallback");
        const fusionModels = selectCatalogModels(request.fusion.models, available, {
          label: "Fusion/MoA participants",
          minimum: request.fusion.enabled ? 2 : 0,
          maximum: MAX_FUSION_PARTICIPANTS,
        });
        const synthesisModel = request.fusion.synthesisModel
          ? firstSelectedModel(
              selectCatalogModels([request.fusion.synthesisModel], available, {
                label: "Fusion synthesizer",
                minimum: 1,
                maximum: 1,
              }),
            )
          : "";
        config.fallbackModels = fallbackModels;
        config.fusion = {
          ...config.fusion,
          enabled: request.fusion.enabled,
          mode: request.fusion.mode,
          models: fusionModels,
          synthesisModel,
          maxParallel: request.fusion.maxParallel,
        };
        saveConfig(config, root);
        return routingSettings();
      },
      chat: async (request) => {
        const context = contextForSession(request.sessionId);
        if (request.provider && !request.model)
          throw new Error(`Provider ${request.provider} has no selected chat model; authenticate/configure one before starting`);
        if (request.provider && request.model && !request.model.startsWith(`${request.provider}/`))
          throw new Error("Selected model does not belong to the selected provider");
        if (request.model) {
          const available = (await catalog()).models.some((item) => item.selector === request.model);
          if (!available) throw new Error(`Selected model is not available in the isolated Axiomux provider catalog: ${request.model}`);
          runtime.setSessionPreferredModel(request.sessionId, request.model);
        }
        const uiHandler = createWebOmpUiHandler(request.sessionId, context.supervisor, approvals);
        const task = context.supervisor.start(request.message, {
          sessionId: request.sessionId,
          approve: (description) => {
            const active = context.supervisor.activeForSession(request.sessionId);
            return active ? approvals.request(active.id, description) : Promise.resolve(false);
          },
          uiHandler,
          ...(request.model ? { model: request.model } : {}),
          ...(request.responseLanguage ? { responseLanguage: request.responseLanguage } : {}),
        });
        return { taskId: task.id, status: task.status };
      },
      steer: (request) => contextForTask(request.taskId).supervisor.send(request.taskId, request.message),
      stop: (taskId) => {
        approvals.cancelTask(taskId);
        return contextForTask(taskId).supervisor.send(taskId, "/stop");
      },
      resolveApproval: (request) => approvals.resolve(request.id, request.approved),
      subscribeEvents: (request, emit) => subscribeUiEvents(request, emit, approvals, uiContexts),
      onError: () => console.error("[ui] A local operation failed; inspect the task trace."),
    },
  });
  console.log(`Axiomux UI: ${server.origin}`);
  console.log(`One-time local bootstrap: ${server.bootstrapUrl}`);
  console.log("Press Ctrl+C to close.");
  if (!noOpen) openExternal(server.bootstrapUrl);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  approvals.close();
  const activeTasks = uiContexts.flatMap((context) =>
    context.supervisor
      .list()
      .filter((task) => ["queued", "running"].includes(task.status))
      .map((task) => ({ context, task })),
  );
  await Promise.allSettled(activeTasks.map(({ context, task }) => context.supervisor.send(task.id, "/stop")));
  await Promise.allSettled(activeTasks.map(({ context, task }) => context.supervisor.wait(task.id)));
  await server.close();
  for (const cancel of cancelFinishedApprovals) cancel();
}

function createWebOmpUiHandler(sessionId: string, projectSupervisor: TaskSupervisor, approvals: UiApprovalBroker): OmpUiHandler {
  return async (request) => {
    const active = projectSupervisor.activeForSession(sessionId);
    if (!active) return { cancelled: true };
    const descriptionParts = [request.title, request.message, request.instructions].filter(Boolean);
    if (request.method === "select") descriptionParts.push(`Complete options=${JSON.stringify(request.options ?? [])}`);
    const description = descriptionParts.join("\n") || `OMP request: ${request.method}`;
    if (description.length > 8_000) return { cancelled: true };
    if (request.method === "confirm") {
      return { confirmed: await approvals.request(active.id, description) };
    }
    if (request.method === "select") {
      const approve = request.options?.find((option) => /^(?:approve|allow|yes)(?:\b|$)/i.test(option.trim()));
      const deny = request.options?.find((option) => /^(?:deny|reject|no)(?:\b|$)/i.test(option.trim()));
      if (!approve || !deny) return { cancelled: true };
      const approved = await approvals.request(active.id, description);
      return { value: approved ? approve : deny };
    }
    // Runtime login and free-form OMP prompts remain CLI-only; the web UI never
    // guesses secrets/text or launches URLs on the user's behalf.
    return { cancelled: true };
  };
}

function subscribeUiEvents(
  request: UiEventsRequest,
  emit: (event: unknown) => void,
  approvals: UiApprovalBroker,
  availableContexts: ProjectContext[],
): () => void {
  const outputLengths = new Map<string, number>();
  const traceLengths = new Map<string, number>();
  const matches = (task: SupervisedTaskSnapshot): boolean =>
    (!request.projectId || task.projectId === request.projectId) &&
    (!request.sessionId || task.sessionId === request.sessionId) &&
    (!request.taskId || task.id === request.taskId);
  const publish = (task: SupervisedTaskSnapshot): void => {
    if (!matches(task)) return;
    const previousOutput = outputLengths.get(task.id) ?? 0;
    const previousTrace = traceLengths.get(task.id) ?? 0;
    if (!outputLengths.has(task.id)) emit({ type: task.status === "queued" ? "task.started" : "task.running", taskId: task.id, status: task.status });
    if (task.output.length > previousOutput) emit({ type: "assistant.delta", taskId: task.id, delta: task.output.slice(previousOutput) });
    for (const trace of task.trace.slice(previousTrace)) emit({ type: "trace.public", taskId: task.id, ...trace });
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      emit({
        type: task.status === "completed" ? "task.completed" : task.status === "cancelled" ? "task.cancelled" : "task.failed",
        taskId: task.id,
        status: task.status,
        ...(task.error ? { message: task.error } : {}),
        ...(!task.output ? { content: task.output } : {}),
      });
    }
    outputLengths.set(task.id, task.output.length);
    traceLengths.set(task.id, task.trace.length);
  };
  const selectedContexts = request.taskId
    ? [contextForTask(request.taskId)]
    : request.sessionId
      ? [contextForSession(request.sessionId)]
      : request.projectId
        ? [contextForProjectId(request.projectId)]
        : availableContexts;
  for (const context of selectedContexts) for (const task of context.supervisor.list()) publish(task);
  const unsubscribe = selectedContexts.map((context) => context.supervisor.subscribe(publish));
  const matchesApproval = (event: UiApprovalEvent): boolean => {
    let task: SupervisedTaskSnapshot | undefined;
    try {
      task = contextForTask(event.taskId).supervisor.get(event.taskId);
    } catch {
      task = undefined;
    }
    return (
      (!request.projectId || task?.projectId === request.projectId) &&
      (!request.taskId || request.taskId === event.taskId) &&
      (!request.sessionId || task?.sessionId === request.sessionId)
    );
  };
  for (const approval of approvals.list()) {
    const event: UiApprovalEvent = { type: "approval.requested", ...approval };
    if (matchesApproval(event)) emit(event);
  }
  const unsubscribeApprovals = approvals.subscribe((event) => {
    if (matchesApproval(event)) emit(event);
  });
  if (request.sessionId) {
    for (const event of runtime.listEvents(request.sessionId, 0, 200)) emit({ type: "trace.public", ...event });
  }
  return () => {
    for (const stop of unsubscribe) stop();
    unsubscribeApprovals();
  };
}

async function memoryCommand(args: string[]): Promise<void> {
  const [action = "list", ...rest] = args;
  if (action === "evaluations") {
    const evaluations = memory.listMemories(undefined, 500).filter((item) => item.sourceUri.startsWith("self-evaluation://"));
    for (const item of evaluations.slice(0, 100))
      console.log(terminalSafe(`#${item.id} ${item.reviewStatus} expires=${item.expiresAt ?? "never"}\n${item.content}`, 20_000));
    console.log(`${evaluations.length} self-evaluation(s) found.`);
    return;
  }
  if (action === "list") {
    for (const item of memory.listMemories(undefined, 50))
      console.log(
        terminalSafe(
          `#${item.id} ${item.kind}/${item.reviewStatus} scope=${item.scope} importance=${item.importance} ${item.sourceLabel}\n  ${item.content.slice(0, 180)}`,
          20_000,
        ),
      );
    return;
  }
  if (action === "add") {
    const parsed = parseMemoryAdd(rest);
    const content = parsed.content;
    if (!content) throw new Error("Usage: memory add <text>");
    const id = memory.addMemory({
      content,
      kind: parsed.kind,
      scope: parsed.scope,
      importance: parsed.importance,
      reviewStatus: "pending",
      confidence: 0.8,
      sourceUri: "manual://cli",
      sourceLabel: "manual",
    });
    console.log(`Memory ${id} created as pending ${parsed.kind}.`);
    return;
  }
  if (action === "get") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) throw new Error("Usage: memory get <id>");
    const item = memory.getMemory(id);
    if (!item) throw new Error(`Memory ${id} does not exist`);
    console.log(terminalSafe(JSON.stringify(item, null, 2), 1_000_000));
    return;
  }
  if (action === "recall") {
    const query = rest.join(" ").trim();
    if (!query) throw new Error("Usage: memory recall <query>");
    for (const item of memory.recall(query, "cli-recall", 10, project.id, false))
      console.log(terminalSafe(`#${item.id} ${item.kind}/${item.reviewStatus} ${item.sourceUri}\n  ${item.content}`, 1_000_000));
    return;
  }
  if (action === "approve" || action === "reject") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) throw new Error(`Usage: memory ${action} <id>`);
    if (!memory.reviewMemory(id, action === "approve" ? "approved" : "rejected")) throw new Error(`Memory ${id} does not exist`);
    console.log(`Memory ${id}: ${action === "approve" ? "approved" : "rejected"}.`);
    return;
  }
  if (action === "stats") {
    console.log(JSON.stringify(memory.stats(), null, 2));
    return;
  }
  if (action === "supersede") {
    const previousId = Number(rest[0]);
    const replacementId = Number(rest[1]);
    if (!Number.isInteger(previousId) || !Number.isInteger(replacementId)) throw new Error("Usage: memory supersede <old-id> <new-id>");
    if (!memory.supersedeMemory(previousId, replacementId)) throw new Error("Could not supersede the memory");
    console.log(`Memory ${previousId} superseded by ${replacementId}.`);
    return;
  }
  if (action === "forget") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) throw new Error("Usage: memory forget <id>");
    if (!memory.forgetMemory(id)) throw new Error(`Memory ${id} does not exist`);
    console.log(`Memory ${id} deleted.`);
    return;
  }
  if (action === "feedback") {
    const id = Number(rest[0]);
    const verdict = rest[1]?.toLocaleLowerCase();
    if (!Number.isInteger(id) || !verdict || !["up", "down", "neutral"].includes(verdict))
      throw new Error("Usage: memory feedback <id> <up|down|neutral> [note]");
    const signal = verdict === "up" ? 1 : verdict === "down" ? -1 : 0;
    const feedbackId = memory.recordRecallFeedback("manual-cli", id, signal, rest.slice(2).join(" ") || undefined);
    console.log(`Feedback ${feedbackId} recorded for memory ${id}.`);
    return;
  }
  if (action === "contradictions") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) throw new Error("Usage: memory contradictions <id>");
    const suggestions = memory.findPotentialContradictions(id);
    for (const suggestion of suggestions)
      console.log(
        terminalSafe(
          `#${suggestion.memory.id}\tsimilarity=${suggestion.similarity.toFixed(3)}\t${suggestion.reason}\n  ${suggestion.memory.content.slice(0, 240)}`,
          20_000,
        ),
      );
    if (!suggestions.length) console.log("No potential contradiction found. This is a heuristic result, not a logical proof.");
    return;
  }
  if (action === "relations") {
    const id = rest[0] ? Number(rest[0]) : undefined;
    if (id !== undefined && !Number.isInteger(id)) throw new Error("Usage: memory relations [id]");
    for (const relation of memory.listMemoryRelations(id))
      console.log(
        terminalSafe(
          `#${relation.id}\t${relation.leftMemoryId} ${relation.relation} ${relation.rightMemoryId}${relation.note ? `\t${relation.note}` : ""}`,
          20_000,
        ),
      );
    return;
  }
  if (action === "relate") {
    const leftId = Number(rest[0]);
    const relation = rest[1];
    const rightId = Number(rest[2]);
    if (!Number.isInteger(leftId) || !Number.isInteger(rightId) || !relation || !["contradicts", "duplicates", "supports"].includes(relation)) {
      throw new Error("Usage: memory relate <left-id> <contradicts|duplicates|supports> <right-id> [note]");
    }
    const relationId = memory.linkMemories(leftId, rightId, relation as "contradicts" | "duplicates" | "supports", rest.slice(3).join(" ") || undefined);
    console.log(`Relation ${relationId} recorded: ${leftId} ${relation} ${rightId}.`);
    return;
  }
  if (action === "sources") {
    for (const source of memory.listSourceDocuments()) console.log(terminalSafe(`#${source.id}\t${source.chunkCount} chunks\t${source.sourceUri}`, 20_000));
    return;
  }
  if (action === "export") {
    const target = rest[0] || join(paths.stateDir, "memory-export.json");
    const exported = createPrivateExport(target, `${JSON.stringify(memory.exportPortable(), null, 2)}\n`);
    console.log(terminalSafe(`Memory exported to ${exported.path} (${exported.detail}).`, 20_000));
    return;
  }
  throw new Error("Usage: memory list|add|get|recall|approve|reject|stats|supersede|forget|feedback|contradictions|relate|relations|sources|export");
}

function sessionsCommand(args: string[]): void {
  const [action = "list", id] = args;
  if (action === "list") {
    for (const session of runtime.listSessions(project.id, 500)) {
      console.log(terminalSafe(`${session.id}\t${session.messages} messages\t${session.updatedAt}\t${session.title ?? ""}`, 20_000));
    }
    return;
  }
  if (action === "forget" && id) {
    const session = runtime.getSession(id);
    if (!session || session.projectId !== project.id) throw new Error(`Session ${id} does not exist in the active project`);
    const active = runtime.listTasks(project.id, id, 10).find((task) => ["queued", "running", "waiting"].includes(task.status));
    if (active) throw new Error(`Session ${id} has active task ${active.id}; complete it before deleting the history`);
    if (!memory.forgetSession(id)) throw new Error(`Session ${id} does not exist`);
    console.log(`Session ${id} and its local logs deleted.`);
    return;
  }
  throw new Error("Usage: sessions list|forget <id>");
}

function projectsCommand(args: string[]): void {
  const [action = "list", ...rest] = args;
  if (action === "list") {
    const currentId = runtime.currentProject()?.id;
    for (const item of runtime.listProjects()) {
      console.log(
        terminalSafe(
          `${item.id === currentId ? "→" : " "} ${isProjectWorkspaceAvailable(item) ? "ready" : "missing"}\t${item.id}\t${item.name}\t${item.rootPath}`,
          20_000,
        ),
      );
    }
    return;
  }
  if (action === "current") {
    console.log(terminalSafe(`${project.id}\t${project.name}\t${project.rootPath}`, 20_000));
    return;
  }
  if (action === "add") {
    const nameIndex = rest.indexOf("--name");
    const pathParts = nameIndex < 0 ? rest : rest.slice(0, nameIndex);
    const name =
      nameIndex < 0
        ? undefined
        : rest
            .slice(nameIndex + 1)
            .join(" ")
            .trim();
    const path = pathParts.join(" ").trim();
    if (!path || (nameIndex >= 0 && !name)) throw new Error("Usage: projects add <folder> [--name name]");
    const added = runtime.ensureProject(canonicalWorkspaceRoot(root, path), name);
    console.log(terminalSafe(`Project linked: ${added.id}\n${added.name}\n${added.rootPath}`, 20_000));
    return;
  }
  if (action === "use") {
    const selected = resolveProjectReference(rest.join(" "));
    const active = supervisor.list().find((task) => ["queued", "running"].includes(task.status));
    if (active && selected.id !== project.id) throw new Error(`The current project has active task ${active.id}; complete it before switching workspaces`);
    activateProject(selected);
    console.log(terminalSafe(`Active project: ${project.name}\nWorkspace: ${project.rootPath}`, 20_000));
    return;
  }
  if (action === "remove") {
    if (runtime.listProjects().length <= 1) throw new Error("You cannot unlink the only project; link another folder first");
    const selected = resolveProjectReference(rest.join(" "));
    const wasCurrent = selected.id === project.id;
    const nextProject = wasCurrent ? runtime.listProjects().find((item) => item.id !== selected.id && isProjectWorkspaceAvailable(item)) : undefined;
    if (wasCurrent && !nextProject) throw new Error("Link or recover another workspace before unlinking the active project");
    const removed = runtime.removeProject(selected.id);
    projectContexts.delete(removed.id);
    if (nextProject) activateProject(nextProject);
    console.log(terminalSafe(`Project unlinked without deleting the folder or local history: ${removed.name}\n${removed.rootPath}`, 20_000));
    return;
  }
  throw new Error("Usage: projects list|current|add <folder> [--name name]|use <id|name|folder>|remove <id|name|folder>");
}

function resolveProjectReference(reference: string): ProjectRecord {
  const value = reference.trim();
  if (!value) throw new Error("Provide the project ID, name, or folder");
  const projects = runtime.listProjects();
  const byId = projects.find((item) => item.id === value);
  if (byId) return byId;
  const byName = projects.filter((item) => item.name.toLocaleLowerCase() === value.toLocaleLowerCase());
  if (byName.length > 1) throw new Error(`Ambiguous project name: ${value}; use the ID`);
  if (byName[0]) return byName[0];
  if (existsSync(resolve(value))) {
    const byRoot = runtime.getProjectByRoot(value);
    if (byRoot?.linked) return byRoot;
  }
  throw new Error(`Linked project not found: ${value}`);
}

function searchAcrossProjects(query: string): void {
  const text = query.trim();
  if (!text) throw new Error("Usage: search <query>");
  const messageHits = runtime.searchMessages(text, 50);
  const memoryHits = recallAcrossProjects(text, 24);
  for (const item of messageHits) {
    console.log(terminalSafe(`[session/${item.projectName}] ${item.sessionId} ${item.role} ${item.createdAt}\n${item.content}`, 20_000));
  }
  for (const item of memoryHits) {
    console.log(terminalSafe(`[memory/${item.scope}] #${item.id} ${item.kind}/${item.reviewStatus} ${item.sourceUri}\n${item.content}`, 20_000));
  }
  console.log(`${messageHits.length} message(s) and ${memoryHits.length} memory item(s) found across ${runtime.listProjects().length} project(s).`);
}

function recallAcrossProjects(query: string, limit: number): ReturnType<MemoryStore["recall"]> {
  const result = new Map<number, ReturnType<MemoryStore["recall"]>[number]>();
  for (const item of memory.recall(query, "cross-project-search", limit, "global", false)) result.set(item.id, item);
  for (const linkedProject of runtime.listProjects()) {
    for (const item of memory.recall(query, "cross-project-search", limit, linkedProject.id, false)) result.set(item.id, item);
  }
  return [...result.values()].slice(0, limit);
}

async function skillsCommand(args: string[]): Promise<void> {
  const [action = "list", id, ...rest] = args;
  if (action === "list") {
    for (const skill of skills.list()) console.log(terminalSafe(`${skill.id}\t${skill.status}\t${skill.description}`, 20_000));
    return;
  }
  if (action === "approve" && id) {
    const skill = skills.approve(id);
    console.log(`Skill ${skill.id} activated.`);
    return;
  }
  if (action === "reject" && id) {
    skills.reject(id);
    console.log(`Skill ${id} rejected.`);
    return;
  }
  if (action === "candidates") {
    const status = id && ["pending", "converted", "rejected"].includes(id) ? (id as "pending" | "converted" | "rejected") : undefined;
    for (const candidate of memory.listLearningCandidates(status)) {
      console.log(
        terminalSafe(
          `#${candidate.id}\t${candidate.status}/${candidate.reviewStatus}\t${candidate.title}${candidate.convertedSkillId ? ` -> ${candidate.convertedSkillId}` : ""}`,
          20_000,
        ),
      );
    }
    return;
  }
  if ((action === "candidate-approve" || action === "candidate-reject") && id) {
    const candidateId = Number(id);
    if (!Number.isInteger(candidateId)) throw new Error(`Usage: skills ${action} <candidate-id> [notes]`);
    const candidate = memory.reviewLearningCandidate(candidateId, action === "candidate-approve" ? "approved" : "rejected", rest.join(" ") || undefined);
    console.log(`Candidate ${candidate.id}: ${candidate.reviewStatus}.`);
    return;
  }
  if (action === "convert" && id && rest[0]) {
    const candidateId = Number(id);
    if (!Number.isInteger(candidateId)) throw new Error("Usage: skills convert <candidate-id> <skill-id> [description]");
    const proposal = learner.convertCandidate(candidateId, rest[0], rest.slice(1).join(" ") || undefined);
    console.log(`Candidate converted to ${proposal.skill.id}, still quarantined. Review it, then use skills approve ${proposal.skill.id}.`);
    return;
  }
  if (action === "versions" && id) {
    for (const version of skills.listVersions(id)) console.log(`${version.contentHash}\t${version.createdAt}`);
    return;
  }
  if (action === "evaluate" && id && rest[0]) {
    const verdict = rest[0].toLocaleLowerCase();
    if (!["pass", "fail"].includes(verdict) || !rest.slice(1).join(" ").trim()) throw new Error("Usage: skills evaluate <id> <pass|fail> <summary>");
    const evaluation = skills.recordEvaluation(id, verdict === "pass", rest.slice(1).join(" "));
    console.log(`Evaluation recorded for ${evaluation.skillId}@${evaluation.contentHash.slice(0, 12)}: ${evaluation.passed ? "PASS" : "FAIL"}.`);
    return;
  }
  if (action === "rollback" && id && rest[0]) {
    const skill = skills.rollback(id, rest[0]);
    console.log(`Skill ${skill.id} restored to ${skill.contentHash.slice(0, 12)}.`);
    return;
  }
  if (action === "governance") {
    console.log(terminalSafe(JSON.stringify(skills.exportGovernance(), null, 2), 1_000_000));
    return;
  }
  throw new Error("Usage: skills list|approve|reject|candidates|candidate-approve|candidate-reject|convert|versions|evaluate|rollback|governance");
}

async function learn(spec: string, sessionId: string): Promise<void> {
  const [id, description, ...source] = spec.split("|").map((part) => part.trim());
  if (!id || !description || !source.length) throw new Error("Usage: /learn id | description | procedure/evidence");
  const proposal = learner.proposeFromText(id, description, source.join(" | "), sessionId);
  console.log(`Skill ${proposal.skill.id} quarantined. Findings: ${proposal.findings.length}. Review it, then use /skills approve ${proposal.skill.id}.`);
}

async function sourceCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "import") {
    const manifestPath = rest[0];
    if (!manifestPath) throw new Error("Usage: source import <manifest.json>");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    const entries = Array.isArray(manifest) ? manifest : (manifest as { sources?: unknown })?.sources;
    if (!Array.isArray(entries) || !entries.every((item) => typeof item === "string"))
      throw new Error("Manifest must be an array of sources or { sources: string[] }");
    const results = await sources.ingestMany(entries);
    for (const result of results)
      console.log(
        terminalSafe(
          `${result.memoryId ? "PASS" : "FAIL"}  source ${result.index + 1}: ${result.memoryId ? `memory ${result.memoryId}` : result.error}`,
          20_000,
        ),
      );
    if (results.every((result) => !result.memoryId)) throw new Error("No source was ingested");
    return;
  }
  if (action !== "add" || !rest.length) throw new Error("Usage: source add <file|url> | source import <manifest.json>");
  const source = rest.join(" ");
  const id = /^https?:\/\//i.test(source) ? await sources.ingestUrl(source) : await sources.ingestFile(source);
  console.log(`Source ingested as pending memory ${id}.`);
}

async function workflowCommand(args: string[]): Promise<void> {
  const [action, path, stepId, recoveryAction, ...recoveryPayload] = args;
  if (!action || !path || !["run", "status", "adopt", "recover"].includes(action)) {
    throw new Error("Usage: workflow run|status|adopt <workflow.json> | workflow recover <workflow.json> <step-id> retry|complete|fail [result]");
  }
  const definition = JSON.parse(readFileSync(path, "utf8")) as WorkflowDefinition;
  const sessionId = `workflow-${project.id}-${definition.id}`;
  const engine = new WorkflowEngine(join(paths.workflows, project.id), {
    runAgent: async (prompt, idempotencyKey) => {
      try {
        return (
          await agent.runTurn(prompt, {
            sessionId,
            workflowIdempotencyKey: idempotencyKey,
            approve: (description) => terminal.confirm(description),
            uiHandler: terminal.ompHandler,
          })
        ).text;
      } catch (error) {
        if (error instanceof AgentTurnFailedError && error.effectsMayHaveOccurred) {
          throw new UnknownWorkflowEffectError(error.message, { cause: error });
        }
        throw error;
      }
    },
    requestApproval: (prompt) => terminal.confirm(prompt),
    remember: async (content, label, idempotencyKey) =>
      memory.addMemory({
        content,
        kind: "evidence",
        reviewStatus: "pending",
        scope: project.id,
        sourceUri: `workflow://${definition.id}`,
        sourceLabel: label,
        idempotencyKey: projectWorkflowIdempotencyKey(project.id, idempotencyKey),
      }),
  });
  if (action === "status") {
    console.log(terminalSafe(JSON.stringify(engine.load(definition.id) ?? { workflowId: definition.id, status: "not_started" }, null, 2), 1_000_000));
    return;
  }
  if (action === "adopt") {
    console.log(terminalSafe(JSON.stringify(engine.adoptLegacyState(definition), null, 2), 1_000_000));
    return;
  }
  if (action === "recover") {
    if (!stepId || !recoveryAction || !["retry", "complete", "fail"].includes(recoveryAction)) {
      throw new Error("Usage: workflow recover <workflow.json> <step-id> retry|complete|fail [result]");
    }
    const payload = recoveryPayload.join(" ").trim();
    const resolution =
      recoveryAction === "retry"
        ? { action: "retry" as const }
        : recoveryAction === "complete"
          ? { action: "complete" as const, output: parseJsonOrText(payload) }
          : { action: "fail" as const, error: payload };
    const state = engine.resolveUnknownStep(definition, stepId, resolution);
    console.log(terminalSafe(JSON.stringify(state, null, 2), 1_000_000));
    console.log("Recovery recorded. Review the state and use `workflow run` to continue when applicable.");
    return;
  }
  const state = await engine.run(definition);
  console.log(terminalSafe(JSON.stringify(state, null, 2), 1_000_000));
}

function parseJsonOrText(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function projectWorkflowIdempotencyKey(projectId: string, workflowKey: string): string {
  return `wf_${createHash("sha256").update(`superai-project-workflow-v1\0${projectId}\0${workflowKey}`, "utf8").digest("hex")}`;
}

function toolsCommand(profile?: string): void {
  if (!profile) {
    console.log(`Tool profile: ${identifyToolProfile(config.ompTools)}\n${config.ompTools.join(", ")}`);
    console.log(
      "Profiles: read, write, code, automation. OMP receives only todo/web_search; filesystem, process, browser, and desktop access uses host tools governed by Axiomux.",
    );
    return;
  }
  config.ompTools = toolsForProfile(profile);
  saveConfig(config, root);
  console.log(`Profile ${profile} saved with ${config.ompTools.length} tools: ${config.ompTools.join(", ")}`);
}

function personaCommand(value?: string): void {
  if (value === undefined) {
    console.log(`Persona intensity: ${config.persona.intensity}/3 (0 neutral, 1 sharp, 2 irreverent, 3 maximum)`);
    return;
  }
  const intensity = Number(value);
  if (!Number.isInteger(intensity) || intensity < 0 || intensity > 3) throw new Error("Usage: persona <0|1|2|3>");
  config.persona.intensity = intensity as 0 | 1 | 2 | 3;
  saveConfig(config, root);
  console.log(`Persona intensity saved: ${intensity}/3. It applies to future processes and turns.`);
}

async function doctor(online = false): Promise<void> {
  const checks: Array<[string, boolean, string]> = [];
  checks.push(["Node.js >=24", Number(process.versions.node.split(".")[0]) >= 24, process.version]);
  try {
    const verified = verifyOmpRuntime(ompExecutable, OMP_CONTRACT_VERSION, root, process.env);
    const version = verified.version;
    checks.push(["Provider runtime", true, `${ompExecutable} (${version})`]);
    checks.push(["OMP compatibility", version === OMP_CONTRACT_VERSION, `${version}; tested/pinned contract ${OMP_CONTRACT_VERSION}`]);
    checks.push([
      "OMP release digest",
      Boolean(verified.digest),
      verified.digest ? `official ${OMP_CONTRACT_VERSION} SHA-256 ${verified.digest}` : "no audited release digest",
    ]);
  } catch (error) {
    checks.push(["Provider runtime", false, String(error)]);
    checks.push(["OMP compatibility", false, `unable to verify ${OMP_CONTRACT_VERSION}`]);
    checks.push(["OMP release digest", false, `unable to verify official ${OMP_CONTRACT_VERSION} bytes`]);
  }
  checks.push(["SQLite memory", true, paths.database]);
  checks.push(["Private state directory", stateSecurity.hardened, stateSecurity.detail]);
  checks.push([
    "Core skills",
    skills.list().filter((skill) => skill.status === "core").length >= 5,
    `${skills.list().filter((skill) => skill.status === "core").length} loaded`,
  ]);
  checks.push([
    "Explicit runtime tool allowlist",
    config.ompTools.length > 0,
    `${config.ompTools.length} tools; profile=${identifyToolProfile(config.ompTools)}`,
  ]);
  checks.push(["Approval mode", true, config.approvalMode]);
  const neuralwattStatus = neuralwatt.status();
  const neuralwattHealthy = !["missing", "unreadable"].includes(neuralwattStatus.credentialState);
  checks.push([
    "Provider neuralwatt",
    neuralwattHealthy,
    `${neuralwattStatus.credentialState}; ${neuralwattStatus.configuredModels} configured model(s)${neuralwattStatus.error ? `; ${neuralwattStatus.error}` : ""}`,
  ]);
  let client: OmpRpcClient | undefined;
  let configuredClient: OmpRpcClient | undefined;
  if (!stateSecurity.hardened) {
    checks.push(["Configured model", false, "not checked because the private state ACL is not secure; no OMP process was started"]);
  } else
    try {
      client = diagnosticClient();
      await client.start();
      const [ompModels, nativeLoginProviders] = await Promise.all([client.getModels(), client.getLoginProviders()]);
      const models = mergeAvailableModels(ompModels);
      const loginProviders = mergeLoginProviders(nativeLoginProviders);
      const provider = config.model.split("/", 1)[0];
      let found = models.some((model) => model.selector === config.model);
      if (provider === "neuralwatt" && neuralwattStatus.credentialState === "available") {
        configuredClient = modelRuntimeClient(config.model);
        await configuredClient.start();
        found = (await configuredClient.getModels()).some((model) => model.selector === config.model);
      }
      checks.push(["Configured model", found, config.model]);
      const requestedProviders = ["openai-codex", "anthropic", "cursor", "google-antigravity", "perplexity", "neuralwatt"];
      const loginIds = new Set(loginProviders.filter((item) => item.available).map((item) => item.id));
      const missingProviders = requestedProviders.filter((providerId) => !loginIds.has(providerId));
      checks.push([
        "Provider login catalog",
        loginProviders.length > 0 && missingProviders.length === 0,
        `${loginProviders.length} flows; ${countAuthenticatedCredentials(loginProviders)} distinct stored credentials${missingProviders.length ? `; missing ${missingProviders.join(", ")}` : "; requested providers present"}`,
      ]);
      const loginProvider = loginProviders.find((item) => item.id === provider);
      checks.push([
        "Provider credential",
        !loginProvider || loginProvider.authenticated,
        loginProvider
          ? `${provider}: ${loginProvider.authenticated ? "stored in isolated OMP database" : "not present"}`
          : `${provider}: no credential status exposed`,
      ]);
      if (online && found) {
        configuredClient ??= modelRuntimeClient(config.model);
        await configuredClient.start();
        const response = await configuredClient.prompt("Reply with exactly AXIOMUX_DOCTOR_OK and nothing else.");
        checks.push(["Live model response", response.text.trim() === "AXIOMUX_DOCTOR_OK", response.text.trim().slice(0, 120)]);
      }
    } catch (error) {
      checks.push([online ? "Live provider/model" : "Configured model", false, String(error)]);
    } finally {
      await configuredClient?.stop().catch(() => undefined);
      await client?.stop().catch(() => undefined);
    }
  checks.push(["Local governed memory", true, `${memory.stats().active} active; no cloud dependency`]);
  const browserCredential = Boolean(process.env.BROWSER_USE_API_KEY || process.env.OPENAI_API_KEY);
  let uvAvailable = true;
  if (config.adapters.browserUse.enabled) {
    try {
      const uv = resolveTrustedExecutable("uv", { rejectRoots: [root] });
      execFileSync(uv, ["--version"], { stdio: "ignore", timeout: 10_000 });
    } catch {
      uvAvailable = false;
    }
  }
  const browserLock = existsSync(join(root, "adapters", "browser-use", "uv.lock"));
  checks.push([
    "Browser automation",
    config.adapters.browserUse.enabled ? browserCredential && uvAvailable && browserLock : true,
    config.adapters.browserUse.enabled
      ? `Browser Use sidecar enabled; credential ${browserCredential ? "present" : "missing"}; uv ${uvAvailable ? "present" : "missing"}; lock ${browserLock ? "present" : "missing"}`
      : config.ompTools.includes("browser_task")
        ? "Browser Use capability selected but adapter disabled"
        : "disabled by safe default; enable Browser Use with domains or select the automation profile",
  ]);
  const ufoDir = process.env.SUPERAI_UFO_DIR;
  const ufoReady = Boolean(ufoDir && existsSync(join(ufoDir, "ufo", "ufo.py")));
  checks.push([
    "Computer Use bridge",
    !config.adapters.computerUse.enabled || ufoReady,
    config.adapters.computerUse.enabled
      ? ufoReady
        ? "Microsoft UFO checkout found"
        : "SUPERAI_UFO_DIR is missing or invalid"
      : "optional Microsoft UFO adapter disabled",
  ]);
  for (const [name, ok, detail] of checks) console.log(terminalSafe(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`, 20_000));
  const failures = checks.filter(([, ok]) => !ok);
  if (failures.length) throw new Error(`${failures.length} doctor check(s) failed`);
}

function printHelp(): void {
  console.log(`Axiomux commands

  axiomux                         interactive chat
  axiomux chat <message>          one turn
  axiomux login [provider] [--no-open]
                                    OAuth/API login; --no-open only prints the URL
  axiomux logout [provider]       remove all credentials for that provider
  axiomux providers [filter]      provider catalog, authentication, and models
  axiomux provider [id]           provider details (accepts claude/antigravity/nw)
  axiomux models [filter]         available model catalog
  axiomux model [provider/model]  view or change the model
  axiomux fallback status|set <provider/model...>|clear
                                    global fallback; exact routes never inherit it
  axiomux tools [profile]         view or change read|write|code|automation profile
  axiomux projects list|current|add <folder> [--name name]|use|remove <id|name|folder>
  axiomux search <query>          cross-project search over projects, sessions, and memory
  axiomux persona [0|1|2|3]      view or change original persona intensity
  axiomux memory list|evaluations|add|get|recall|approve|reject|stats|supersede|forget|feedback
                   contradictions|relate|relations|sources|export
  axiomux sessions list|forget <id>
  axiomux skills list|approve|reject|candidates|candidate-approve|candidate-reject
                   convert|versions|evaluate|rollback|governance
  axiomux source add <file|url> | import <manifest.json>
  axiomux workflow run|status|adopt <file.json>
  axiomux workflow recover <file.json> <step-id> retry|complete|fail [result]
  axiomux fusion status|enable|set|participants|synthesis|parallel|mode|disable|run
  axiomux upstream list|check <id|--all>|show <id>|mark <id> pending|reviewed|dismissed [note]
                                    mechanism radar; metadata only, no auto-update
  axiomux ui [--port N] [--no-open]  local Codex-style interface
  axiomux doctor [--online]       local checks; --online also calls the configured model

In chat: /login, /logout, /providers, /provider, /models, /model, /fallback, /projects, /project, /search, /global, /persona,
/memory, /remember, /sessions, /skills, /learn id | description | procedure, /source, /fusion, /upstream, /doctor, /new, /exit`);
}

function diagnosticClient(): OmpRpcClient {
  const isolation = getOmpIsolation(config, root);
  return new OmpRpcClient({
    executable: ompExecutable,
    versionContract: OMP_CONTRACT_VERSION,
    extraArgs: getProviderRuntimeArgs(root),
    cwd: root,
    profile: config.ompProfile,
    approvalMode: "always-ask",
    tools: [],
    envAllowlist: config.ompEnvAllowlist,
    bootstrapWithoutModel: true,
    ...(isolation ? { isolation } : {}),
    uiHandler: terminal.ompHandler,
  });
}

function modelRuntimeClient(model: string): OmpRpcClient {
  const isolation = getOmpIsolation(config, root);
  return new OmpRpcClient({
    executable: ompExecutable,
    versionContract: OMP_CONTRACT_VERSION,
    extraArgs: getProviderRuntimeArgs(root),
    cwd: root,
    model,
    profile: config.ompProfile,
    approvalMode: "always-ask",
    tools: [],
    envAllowlist: config.ompEnvAllowlist,
    environmentOverrides: neuralwatt.runtimeEnvironmentForModel(model),
    ...(isolation ? { isolation } : {}),
    uiHandler: terminal.ompHandler,
  });
}

async function setSessionModel(selector: string | undefined, sessionId: string): Promise<void> {
  if (!selector) {
    console.log(terminalSafe(runtime.sessionPreferredModel(sessionId) ?? `${config.model} (default global)`, 20_000));
    return;
  }
  if (selector === "default") {
    runtime.setSessionPreferredModel(sessionId);
    console.log("Session model reset to the global default.");
    return;
  }
  const client = diagnosticClient();
  try {
    await client.start();
    if (!mergeAvailableModels(await client.getModels()).some((model) => model.selector === selector)) {
      throw new Error(`Model is not available in the isolated catalog: ${selector}`);
    }
    runtime.setSessionPreferredModel(sessionId, selector);
    console.log(terminalSafe(`Model for this session: ${selector}`, 20_000));
  } finally {
    await client.stop().catch(() => undefined);
  }
}

function mergeLoginProviders(
  nativeProviders: Array<{ id: string; name: string; available: boolean; authenticated: boolean }>,
): Array<{ id: string; name: string; available: boolean; authenticated: boolean }> {
  const status = neuralwatt.status();
  const withoutLegacyExtension = nativeProviders.filter((item) => item.id !== status.id);
  return applyCredentialProviderAliases([
    ...withoutLegacyExtension,
    {
      id: status.id,
      name: status.name,
      available: status.available,
      authenticated: status.authenticated,
    },
  ]);
}

function mergeAvailableModels(nativeModels: Awaited<ReturnType<OmpRpcClient["getModels"]>>): Awaited<ReturnType<OmpRpcClient["getModels"]>> {
  const bySelector = new Map(nativeModels.map((model) => [model.selector, model]));
  for (const model of neuralwatt.configuredModels()) {
    if (!bySelector.has(model.selector)) bySelector.set(model.selector, model);
  }
  return [...bySelector.values()];
}

async function unifiedModelCatalog(): Promise<Awaited<ReturnType<OmpRpcClient["getModels"]>>> {
  const client = diagnosticClient();
  try {
    await client.start();
    return mergeAvailableModels(await client.getModels());
  } finally {
    await client.stop().catch(() => undefined);
  }
}

function parseMemoryAdd(args: string[]): {
  content: string;
  kind: "evidence" | "instruction" | "preference" | "procedure";
  scope: string;
  importance: number;
} {
  let kind: "evidence" | "instruction" | "preference" | "procedure" = "evidence";
  let scope = project.id;
  let importance = 0.5;
  let index = 0;
  while (index < args.length && args[index]?.startsWith("--")) {
    const option = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${option}`);
    if (option === "--kind") {
      if (!["evidence", "instruction", "preference", "procedure"].includes(value)) throw new Error("Invalid --kind value");
      kind = value as typeof kind;
    } else if (option === "--scope") {
      scope = value;
    } else if (option === "--importance") {
      importance = Number(value);
      if (!Number.isFinite(importance) || importance < 0 || importance > 1) throw new Error("--importance must be between 0 and 1");
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
    index += 2;
  }
  return { content: args.slice(index).join(" ").trim(), kind, scope, importance };
}

class TerminalUi {
  private rl: Interface;
  private readonly questionOutput = new MutableQuestionOutput();
  readonly ompHandler: OmpUiHandler;
  private questionTail: Promise<void> = Promise.resolve();

  constructor() {
    this.rl = createInterface({ input, output: this.questionOutput, terminal: Boolean(input.isTTY && output.isTTY) });
    this.ompHandler = (request) => this.handleOmp(request);
  }

  ompHandlerFor(options: { openExternalUrls: boolean }): OmpUiHandler {
    return (request) => this.handleOmp(request, options.openExternalUrls);
  }

  ask(prompt: string): Promise<string> {
    return this.enqueueQuestion(() => this.rl.question(terminalSafe(prompt, 20_000)));
  }

  async askSecret(prompt: string): Promise<string> {
    if (!input.isTTY || !output.isTTY) return this.ask(prompt);
    return this.enqueueQuestion(async () => {
      output.write(prompt);
      this.questionOutput.muted = true;
      const discardSecretHistory = (history: string[]): void => {
        history.splice(0, history.length);
      };
      this.rl.on("history", discardSecretHistory);
      try {
        return await this.rl.question("");
      } finally {
        this.rl.off("history", discardSecretHistory);
        this.questionOutput.muted = false;
        output.write("\n");
      }
    });
  }

  async confirm(prompt: string): Promise<boolean> {
    const answer = (await this.ask(`${terminalSafe(prompt, 20_000)}\n[y/N] `)).trim().toLocaleLowerCase();
    return answer === "y" || answer === "yes";
  }

  close(): void {
    this.rl.close();
  }

  /** Temporarily release stdin so a pinned foreground child can own prompts. */
  async withInheritedTerminal<T>(run: () => Promise<T>): Promise<T> {
    await this.questionTail;
    this.rl.close();
    try {
      return await run();
    } finally {
      this.rl = createInterface({ input, output: this.questionOutput, terminal: Boolean(input.isTTY && output.isTTY) });
    }
  }

  private enqueueQuestion<T>(run: () => Promise<T>): Promise<T> {
    const result = this.questionTail.then(run, run);
    this.questionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async handleOmp(request: OmpUiRequest, openExternalUrls = true): Promise<Record<string, unknown> | undefined> {
    switch (request.method) {
      case "notify":
        if (request.message) console.error(`[provider] ${terminalSafe(request.message)}`);
        return;
      case "open_url": {
        const target = request.launchUrl ?? request.url;
        if (target) {
          console.log(`Open to authenticate: ${terminalSafe(target, 8_192)}`);
          if (openExternalUrls) openExternal(target);
        }
        if (request.instructions) console.log(terminalSafe(request.instructions));
        return;
      }
      case "select": {
        console.log(terminalSafe(request.title ?? "Select:"));
        (request.options ?? []).forEach((option, index) => {
          console.log(`${index + 1}. ${terminalSafe(option)}`);
        });
        const answer = await this.ask("> ");
        const index = Number(answer) - 1;
        const value = Number.isInteger(index) ? request.options?.[index] : answer.trim();
        return value ? { value } : { cancelled: true };
      }
      case "confirm":
        return { confirmed: await this.confirm(`${terminalSafe(request.title ?? "Confirmation")}\n${terminalSafe(request.message ?? "")}`) };
      case "input":
      case "editor": {
        const prompt = `${terminalSafe(request.title ?? request.placeholder ?? "Value")}: `;
        const value = isSensitivePrompt(request.title, request.placeholder, request.message) ? await this.askSecret(prompt) : await this.ask(prompt);
        return value ? { value } : { cancelled: true };
      }
      default:
        return;
    }
  }
}

class MutableQuestionOutput extends Writable {
  muted = false;
  readonly isTTY = Boolean(output.isTTY);

  get columns(): number | undefined {
    return output.columns;
  }

  override _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) output.write(chunk);
    callback();
  }
}

function openExternal(target: string): void {
  try {
    if (!target || target.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(target)) return;
    const url = new URL(target);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    const executable =
      process.platform === "win32"
        ? resolveWindowsSystemExecutable("rundll32.exe")
        : resolveTrustedExecutable(process.platform === "darwin" ? "open" : "xdg-open", { rejectRoots: [root] });
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.toString()] : [url.toString()];
    spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // The full/short URL is already printed, so a failed best-effort launch is recoverable.
  }
}

function terminalSafe(value: string, maximum = 4_096): string {
  return sanitizeTerminalText(value, maximum);
}

function writeUntrustedTerminal(value: string): void {
  process.stdout.write(terminalSafe(value, 1_000_000));
}

function createPrivateExport(target: string, content: string): { path: string; detail: string } {
  const path = resolve(target);
  // Exclusive creation is deliberate: an export must never truncate or follow
  // an existing file/link. Choose a new path or remove the old export explicitly.
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    const security = securePrivateFile(path);
    if (!security.hardened) throw new Error(`Could not restrict export permissions: ${security.detail}`);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return { path, detail: security.detail };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* best-effort cleanup */
      }
      try {
        unlinkSync(path);
      } catch {
        /* preserve an existing path we did not create */
      }
    }
    throw error;
  }
}

function splitArgs(value: string): string[] {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

terminal = new TerminalUi();
try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(terminalSafe(`\nError: ${error instanceof Error ? error.message : String(error)}`, 20_000));
  process.exitCode = 1;
} finally {
  terminal.close();
  memory.close();
}
