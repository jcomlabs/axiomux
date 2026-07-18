export interface LoginArguments {
  provider?: string;
  openBrowser: boolean;
}

/** Parse login options without treating a flag as a provider identifier. */
export function parseLoginArguments(args: readonly string[]): LoginArguments {
  let provider: string | undefined;
  let openBrowser = true;
  for (const argument of args) {
    if (argument === "--no-open") {
      openBrowser = false;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown login option: ${argument}`);
    if (provider) throw new Error("Login accepts at most one provider");
    provider = argument;
  }
  return provider ? { provider, openBrowser } : { openBrowser };
}
