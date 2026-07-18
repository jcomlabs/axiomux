export const WORKSPACE_HOST_TOOL_NAMES = Object.freeze({
  read: "workspace_read",
  grep: "workspace_grep",
  glob: "workspace_glob",
  edit: "workspace_edit",
  write: "workspace_write",
  bash: "run_program",
  python: "run_python",
} as const);

export type WorkspaceHostToolCapability = keyof typeof WORKSPACE_HOST_TOOL_NAMES;
export type WorkspaceHostToolName = (typeof WORKSPACE_HOST_TOOL_NAMES)[WorkspaceHostToolCapability];

export function workspaceHostToolName(capability: WorkspaceHostToolCapability): WorkspaceHostToolName {
  return WORKSPACE_HOST_TOOL_NAMES[capability];
}
