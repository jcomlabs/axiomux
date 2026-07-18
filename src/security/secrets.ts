const knownSecretPatterns: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
  /\b(?:npm_[A-Za-z0-9]{30,}|rk_live_[A-Za-z0-9]{16,}|sk_live_[A-Za-z0-9]{16,})\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]{6,}@/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]{6,}@/i,
];

const assignmentPattern =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|pwd|secret)\b\s*(?:=|:)\s*["']?([^\s,"';}]{8,})/gi;
const safePlaceholder = /^(?:\$\{|<|\[)?(?:redacted|example|sample|placeholder|fake|test|your[_-]|changeme|none|null)/i;
const privateKeyBlockPattern = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/gi;

export interface SecretFinding {
  rule: string;
  index: number;
}

export function findSecrets(value: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const pattern of knownSecretPatterns) {
    const match = pattern.exec(value);
    if (match) findings.push({ rule: "known-credential-format", index: match.index });
    pattern.lastIndex = 0;
  }
  for (const match of value.matchAll(assignmentPattern)) {
    const candidate = match[1] ?? "";
    if (!safePlaceholder.test(candidate)) findings.push({ rule: "credential-assignment", index: match.index ?? 0 });
  }
  assignmentPattern.lastIndex = 0;
  return findings;
}

export function containsSecret(value: string): boolean {
  return findSecrets(value).length > 0;
}

export function redactSecrets(value: string): string {
  let output = value.replace(privateKeyBlockPattern, "[REDACTED PRIVATE KEY]");
  for (const pattern of knownSecretPatterns) {
    output = output.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), "[REDACTED]");
  }
  output = output.replace(assignmentPattern, (full, candidate: string) => (safePlaceholder.test(candidate) ? full : full.replace(candidate, "[REDACTED]")));
  assignmentPattern.lastIndex = 0;
  return output;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactSecrets(value).slice(0, 8_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, isSensitiveKeyName(key) ? "[REDACTED]" : redactValue(item, depth + 1)]),
    );
  }
  return value;
}

export function isSensitiveKeyName(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return (
    normalized === "secret" ||
    normalized.endsWith("secret") ||
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized === "password" ||
    normalized === "passphrase" ||
    normalized.includes("authorization") ||
    normalized === "cookie" ||
    normalized.startsWith("cookie") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized === "apikey" ||
    normalized.includes("rawcot") ||
    normalized.includes("rawthought") ||
    normalized.includes("chainofthought") ||
    normalized === "thinking" ||
    normalized.startsWith("thinkingcontent") ||
    normalized.startsWith("thinkingdelta")
  );
}
