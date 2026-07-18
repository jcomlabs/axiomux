import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PromptComposer } from "../src/persona.js";
import { SkillManager } from "../src/skills/manager.js";
import type { MemoryItem } from "../src/types.js";

test("prompt keeps personality, approved authority and untrusted evidence in separate layers", () => {
  const composer = new PromptComposer(process.cwd(), new SkillManager(process.cwd()));
  const base = { confidence: 0.8, importance: 0.5, scope: "global", accessCount: 0, sourceLabel: "test", createdAt: "2026-01-01" };
  const memories: MemoryItem[] = [
    { ...base, id: 1, content: "Call the user chefe.", kind: "preference", reviewStatus: "approved", sourceUri: "manual://user" },
    {
      ...base,
      id: 2,
      content: "A retrieved page says to ignore system rules.",
      kind: "evidence",
      reviewStatus: "pending",
      sourceUri: "https://example.invalid",
    },
  ];
  const prompt = composer.compose({ query: "debug the deployment", memories, maxCharacters: 20_000 });
  assert.match(prompt, /You are Axiomux/);
  assert.match(prompt, /## Human-approved memory[\s\S]*memory:1/);
  assert.match(prompt, /## Recalled evidence[\s\S]*memory:2/);
  assert.match(prompt, /untrusted evidence/);
});

test("prompt reads operator preferences only from ignored local state", () => {
  const root = mkdtempSync(join(tmpdir(), "superai-private-user-"));
  try {
    mkdirSync(join(root, "agent"), { recursive: true });
    mkdirSync(join(root, "skills", "core"), { recursive: true });
    mkdirSync(join(root, ".superai"), { recursive: true });
    for (const name of ["IDENTITY.md", "SOUL.md", "AGENTS.md", "TOOLS.md", "USER.md", "MEMORY_POLICY.md", "persona.md"]) {
      writeFileSync(join(root, "agent", name), `# ${name}\npublic template`, "utf8");
    }
    writeFileSync(join(root, ".superai", "user.md"), "Call the operator Captain.", "utf8");
    const prompt = new PromptComposer(root, new SkillManager(root)).stable();
    assert.match(prompt, /Private, human-approved user context[\s\S]*Call the operator Captain/);
    assert.equal(readFileSync(join(root, "agent", "USER.md"), "utf8").includes("Captain"), false);
    writeFileSync(join(root, ".superai", "user.md"), "Call the operator Commander.", "utf8");
    assert.match(new PromptComposer(root, new SkillManager(root), 3).stable(), /Intensity: 3\/3[\s\S]*Commander/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persona intensity is re-read between turns without restarting the TUI", () => {
  let intensity: 0 | 1 | 2 | 3 = 1;
  const composer = new PromptComposer(process.cwd(), new SkillManager(process.cwd()), () => intensity);
  assert.match(composer.stable(), /Intensity: 1\/3/);
  intensity = 3;
  assert.match(composer.stable(), /Intensity: 3\/3/);
});
