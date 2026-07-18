export const OMP_TOOL_PROFILES = Object.freeze({
  read: Object.freeze(["read", "grep", "glob", "web_search", "todo"]),
  write: Object.freeze(["read", "grep", "glob", "edit", "write", "web_search", "todo"]),
  code: Object.freeze(["read", "grep", "glob", "edit", "write", "bash", "python", "web_search", "todo"]),
  automation: Object.freeze(["read", "grep", "glob", "edit", "write", "bash", "python", "browser_task", "computer_use", "web_search", "todo"]),
});

export type OmpToolProfile = keyof typeof OMP_TOOL_PROFILES;

export function toolsForProfile(profile: string): string[] {
  if (!Object.hasOwn(OMP_TOOL_PROFILES, profile)) throw new Error(`Unknown tool profile: ${profile}`);
  return [...OMP_TOOL_PROFILES[profile as OmpToolProfile]];
}

export function identifyToolProfile(tools: string[]): OmpToolProfile | "custom" {
  for (const [name, expected] of Object.entries(OMP_TOOL_PROFILES) as Array<[OmpToolProfile, readonly string[]]>) {
    if (tools.length === expected.length && tools.every((tool, index) => tool === expected[index])) return name;
  }
  return "custom";
}
