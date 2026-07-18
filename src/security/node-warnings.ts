/** The one runtime warning intentionally hidden by the packaged CLI launcher. */
export function isExpectedNodeSqliteWarning(warning: string | Error, type: unknown): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  return type === "ExperimentalWarning" && message.startsWith("SQLite is an experimental feature");
}
