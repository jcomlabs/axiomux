import assert from "node:assert/strict";
import test from "node:test";
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
} from "../src/providers.js";

test("provider aliases cover the user-facing names", () => {
  assert.equal(resolveProviderId("Claude"), "anthropic");
  assert.equal(resolveProviderId("antigravity"), "google-antigravity");
  assert.equal(resolveProviderId("Codex"), "openai-codex");
  assert.equal(resolveProviderId("codex-device"), "openai-codex-device");
  assert.equal(credentialProviderId("codex-device"), "openai-codex");
  assert.equal(resolveProviderId("Neuralwatt-Cloud"), "neuralwatt");
  assert.equal(resolveProviderId("cursor"), "cursor");
  assert.match(providerCapabilityNote("perplexity") ?? "", /Runtime web search/);
  assert.match(providerCapabilityNote("openai-codex-device") ?? "", /openai-codex models/);
  assert.match(providerLoginSecurityWarning("openai-codex") ?? "", /openai-codex-device/);
  assert.equal(providerLoginSecurityWarning("google-antigravity"), undefined);
});

test("device-code login reflects the canonical OpenAI Codex credential", () => {
  const providers = applyCredentialProviderAliases([
    { id: "openai-codex", name: "OpenAI Codex", available: true, authenticated: true },
    { id: "openai-codex-device", name: "OpenAI Codex device", available: true, authenticated: false },
  ]);
  assert.equal(providers.find((item) => item.id === "openai-codex-device")?.authenticated, true);
  assert.equal(countAuthenticatedCredentials(providers), 1);
  assert.deepEqual(
    uniqueAuthenticatedCredentialProviders(providers).map((item) => item.id),
    ["openai-codex"],
  );
});

test("provider summaries merge login state and available model counts", () => {
  const summaries = buildProviderSummaries(
    [
      { id: "anthropic", name: "Claude", available: true, authenticated: true },
      { id: "neuralwatt", name: "Neuralwatt", available: true, authenticated: false },
    ],
    [
      { provider: "anthropic", id: "opus", selector: "anthropic/opus" },
      { provider: "ollama", id: "local", selector: "ollama/local" },
    ],
    "anthropic/opus",
  );
  assert.equal(summaries[0]?.id, "anthropic");
  const anthropic = summaries.find((item) => item.id === "anthropic");
  const neuralwatt = summaries.find((item) => item.id === "neuralwatt");
  const ollama = summaries.find((item) => item.id === "ollama");
  assert.ok(anthropic);
  assert.ok(neuralwatt);
  assert.ok(ollama);
  assert.equal(anthropic.modelCount, 1);
  assert.equal(providerAuthLabel(anthropic), "credential stored");
  assert.equal(providerAuthLabel(neuralwatt), "login available");
  assert.equal(providerAuthLabel(ollama), "active through local configuration");
});
