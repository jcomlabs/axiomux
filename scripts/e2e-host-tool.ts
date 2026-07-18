import { AuditLog } from "../src/audit.js";
import { SuperAgent } from "../src/agent.js";
import { findProjectRoot, getPaths, loadConfig, resolveOmpExecutable } from "../src/config.js";
import { MemoryStore } from "../src/memory/store.js";
import { secureStateDirectory } from "../src/security/state.js";
import { SkillManager } from "../src/skills/manager.js";
import { SourceHub } from "../src/sources.js";

const marker = `AXIOMUX_HOST_TOOL_E2E_${Date.now()}`;
const sessionId = `e2e-host-${Date.now()}`;
const root = findProjectRoot();
const paths = getPaths(root);
const config = loadConfig(root);
const stateSecurity = secureStateDirectory(paths.stateDir);
if (!stateSecurity.hardened) {
  throw new Error(`Host-tool E2E refused an insecure state directory: ${stateSecurity.detail}`);
}
const memory = new MemoryStore(paths.database, config.memory.halfLifeDays);
const skills = new SkillManager(root);
const sources = new SourceHub(memory, root);
const agent = new SuperAgent(root, config, resolveOmpExecutable(config.ompExecutable), memory, skills, sources, new AuditLog(paths.auditLog));

let report: Record<string, unknown> | undefined;
try {
  const result = await agent.runTurn(
    `Call memory_remember exactly once with content ${JSON.stringify(marker)}, label "e2e-host-tool" and source_uri "test://host-tool". Then reply exactly HOST_TOOL_OK.`,
    {
      sessionId,
      approve: async () => false,
      uiHandler: async (request) => {
        if (request.method !== "select" || !request.title?.includes("memory_remember")) return { cancelled: true };
        const value = request.options?.find((option) => /approve|allow/i.test(option));
        return value ? { value } : { cancelled: true };
      },
    },
  );
  const item = memory.listMemories(undefined, 100).find((candidate) => candidate.content === marker);
  if (!item || result.toolCalls < 1) throw new Error(`Host-tool E2E failed: toolCalls=${result.toolCalls}, memory=${item?.id ?? "missing"}`);
  report = {
    success: true,
    model: result.model,
    toolCalls: result.toolCalls,
    response: result.text,
    cleanedMemoryId: item.id,
    cleanedSessionId: result.sessionId,
  };
} finally {
  const leftover = memory.listMemories(undefined, 100).find((candidate) => candidate.content === marker);
  if (leftover) memory.forgetMemory(leftover.id);
  memory.forgetSession(sessionId);
  memory.close();
}
if (report) console.log(JSON.stringify(report));
