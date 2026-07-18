export const RESPONSE_LANGUAGES = ["en", "pt"] as const;

export type ResponseLanguage = (typeof RESPONSE_LANGUAGES)[number];

export function isResponseLanguage(value: unknown): value is ResponseLanguage {
  return typeof value === "string" && RESPONSE_LANGUAGES.includes(value as ResponseLanguage);
}

/**
 * Add a model-side presentation preference without rewriting the provider's
 * output. Exact data stays exact, and an explicit user language request wins
 * for the current turn.
 */
export function responseLanguageInstruction(language: ResponseLanguage): string {
  const proseRule =
    language === "pt"
      ? "Write all user-facing natural-language prose in European Portuguese (pt-PT), using European vocabulary, spelling, and forms of address."
      : "Write all user-facing natural-language prose in English.";
  return `# Response language
${proseRule}
Apply this preference to headings, explanations, summaries, approval questions, and natural-language text surrounding tool or code results.
Preserve code blocks, inline code, identifiers, commands, file paths, URLs, logs, error output, quotations, source excerpts, data values, and requested exact tokens verbatim unless the user explicitly asks to translate them.
If the user explicitly requests a different response language for this turn, follow that request.`;
}
