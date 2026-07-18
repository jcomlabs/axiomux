import type { ModelInfo } from "./types.js";

export interface LoginProviderInfo {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
}

export interface ProviderSummary {
  id: string;
  name: string;
  available: boolean;
  authenticated?: boolean;
  loginAvailable: boolean;
  modelCount: number;
  current: boolean;
}

const PROVIDER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  antigravity: "google-antigravity",
  chatgpt: "openai-codex",
  claude: "anthropic",
  codex: "openai-codex",
  "codex-device": "openai-codex-device",
  "neuralwatt-cloud": "neuralwatt",
  nw: "neuralwatt",
  "perplexity-pro": "perplexity",
});

export function resolveProviderId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

/** Login surfaces may persist credentials under a different canonical vault id. */
export function credentialProviderId(value: string): string {
  const provider = resolveProviderId(value);
  return provider === "openai-codex-device" ? "openai-codex" : provider;
}

export function applyCredentialProviderAliases(logins: LoginProviderInfo[]): LoginProviderInfo[] {
  const authenticated = new Map(logins.map((item) => [item.id, item.authenticated]));
  return logins.map((item) => {
    const canonical = credentialProviderId(item.id);
    return canonical === item.id ? item : { ...item, authenticated: authenticated.get(canonical) ?? item.authenticated };
  });
}

/** Counts stored vault identities, not the number of alternative login flows. */
export function countAuthenticatedCredentials(logins: LoginProviderInfo[]): number {
  return new Set(logins.filter((item) => item.authenticated).map((item) => credentialProviderId(item.id))).size;
}

/** One logout choice per underlying credential, preferring the canonical flow label. */
export function uniqueAuthenticatedCredentialProviders(logins: LoginProviderInfo[]): LoginProviderInfo[] {
  const byCredential = new Map<string, LoginProviderInfo>();
  for (const item of logins) {
    if (!item.authenticated) continue;
    const canonical = credentialProviderId(item.id);
    const existing = byCredential.get(canonical);
    if (!existing || item.id === canonical) byCredential.set(canonical, { ...item, id: canonical });
  }
  return [...byCredential.values()];
}

export function buildProviderSummaries(logins: LoginProviderInfo[], models: ModelInfo[], currentModel: string): ProviderSummary[] {
  const currentProvider = currentModel.split("/", 1)[0] ?? "";
  const summaries = new Map<string, ProviderSummary>();

  for (const login of logins) {
    summaries.set(login.id, {
      id: login.id,
      name: login.name,
      available: login.available,
      authenticated: login.authenticated,
      loginAvailable: login.available,
      modelCount: 0,
      current: login.id === currentProvider,
    });
  }

  for (const model of models) {
    const existing = summaries.get(model.provider);
    if (existing) {
      existing.modelCount += 1;
      existing.available = true;
      continue;
    }
    summaries.set(model.provider, {
      id: model.provider,
      name: model.provider,
      available: true,
      loginAvailable: false,
      modelCount: 1,
      current: model.provider === currentProvider,
    });
  }

  return [...summaries.values()].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export function providerAuthLabel(provider: ProviderSummary): string {
  if (provider.authenticated) return "credential stored";
  if (provider.loginAvailable) return "login available";
  return provider.modelCount > 0 ? "active through local configuration" : "unavailable";
}

export function providerCapabilityNote(providerId: string): string | undefined {
  if (providerId === "perplexity") return "Runtime web search (not a provider/model inference backend).";
  if (providerId === "openai-codex-device")
    return "Device-code login for openai-codex models; it shares the canonical credential and is not a separate model provider.";
  return undefined;
}

export function providerLoginSecurityWarning(providerId: string): string | undefined {
  if (!["openai-codex", "anthropic", "gitlab-duo", "gitlab-duo-agent"].includes(providerId)) return undefined;
  const saferOpenAi =
    providerId === "openai-codex"
      ? " On untrusted networks, prefer `npm run dev -- login openai-codex-device`, which does not open a local callback listener."
      : "";
  return `OMP may temporarily bind the OAuth callback to every network interface even though it advertises localhost. Continue only on a trusted network, without port forwarding, and stop if an unexpected origin appears.${saferOpenAi}`;
}
