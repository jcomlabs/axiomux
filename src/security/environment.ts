const baseEnvironment = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "LANG",
  "LC_ALL",
] as const;

export function buildChildEnvironment(allowlist: string[] = [], overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const names = new Set<string>([...baseEnvironment, ...allowlist]);
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}
