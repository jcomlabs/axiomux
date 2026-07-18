import assert from "node:assert/strict";
import test from "node:test";
import { identifyToolProfile, toolsForProfile } from "../src/tool-profiles.js";

test("tool profiles keep browser out of the default coding surface", () => {
  const code = toolsForProfile("code");
  assert.ok(code.includes("bash"));
  assert.ok(code.includes("python"));
  assert.equal(code.includes("browser"), false);
  assert.equal(code.includes("lsp"), false);
  assert.equal(code.includes("inspect_image"), false);
  assert.equal(identifyToolProfile(code), "code");
  assert.ok(toolsForProfile("automation").includes("browser_task"));
  assert.ok(toolsForProfile("automation").includes("computer_use"));
  assert.equal(toolsForProfile("automation").includes("browser"), false);
  assert.throws(() => toolsForProfile("unknown"), /Unknown tool profile/);
});
