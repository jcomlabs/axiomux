import assert from "node:assert/strict";
import test from "node:test";
import { parseLoginArguments } from "../src/cli-options.js";

test("login accepts a provider with browser launch enabled by default", () => {
  assert.deepEqual(parseLoginArguments(["openai-codex-device"]), {
    provider: "openai-codex-device",
    openBrowser: true,
  });
});

test("login no-open is positional and never becomes a provider", () => {
  assert.deepEqual(parseLoginArguments(["--no-open", "openai-codex-device"]), {
    provider: "openai-codex-device",
    openBrowser: false,
  });
  assert.deepEqual(parseLoginArguments(["openai-codex-device", "--no-open"]), {
    provider: "openai-codex-device",
    openBrowser: false,
  });
  assert.deepEqual(parseLoginArguments(["--no-open"]), { openBrowser: false });
});

test("login rejects unknown options and multiple providers", () => {
  assert.throws(() => parseLoginArguments(["--open"]), /Unknown login option/);
  assert.throws(() => parseLoginArguments(["openai-codex", "anthropic"]), /at most one provider/);
});
