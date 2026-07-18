// The detector includes Portuguese credential vocabulary as input-safety data;
// public diagnostics and interfaces remain English outside the web UI locales.
const SENSITIVE_PROMPT =
  /(?:api[\s_-]*key|token|password|secret|credential|chave[\s_-]*(?:de[\s_-]*)?api|palavra-passe|senha|(?:authorization|auth|oauth|device|verification)[\s_-]*(?:code|url|uri)|(?:redirect|callback)[\s_-]*(?:url|uri)|c[oó]digo[\s_-]*(?:de[\s_-]*)?(?:autoriza[cç][aã]o|dispositivo|verifica[cç][aã]o)|url[\s_-]*(?:de[\s_-]*)?(?:redirecionamento|retorno))/iu; // language-audit: allow-portuguese-input

export function isSensitivePrompt(...parts: Array<string | undefined>): boolean {
  return SENSITIVE_PROMPT.test(parts.filter(Boolean).join(" "));
}
