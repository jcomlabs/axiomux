import assert from "node:assert/strict";
import test from "node:test";
import { isSensitivePrompt } from "../src/security/prompt.js";

test("sensitive provider prompts are detected before terminal input", () => {
  assert.equal(isSensitivePrompt("Paste your API key", "sk-..."), true);
  assert.equal(isSensitivePrompt("Introduz a chave de API"), true); // language-audit: allow-portuguese-input
  assert.equal(isSensitivePrompt("Paste the authorization code (or full redirect URL)"), true);
  assert.equal(isSensitivePrompt("Enter the OAuth device code"), true);
  assert.equal(isSensitivePrompt("Cola o código de autorização ou URL de redirecionamento"), true); // language-audit: allow-portuguese-input
  assert.equal(isSensitivePrompt("Choose a provider"), false);
});
