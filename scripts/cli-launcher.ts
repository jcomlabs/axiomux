#!/usr/bin/env node
import { isExpectedNodeSqliteWarning } from "../src/security/node-warnings.js";

const originalEmitWarning = process.emitWarning.bind(process);

/**
 * npm's Windows command shim ignores Node flags embedded in a shebang. Filter
 * only the known Node SQLite warning before dynamically loading the real CLI;
 * every other warning retains Node's normal behavior.
 */
process.emitWarning = ((warning: string | Error, ...args: unknown[]): void => {
  if (isExpectedNodeSqliteWarning(warning, args[0])) return;
  Reflect.apply(originalEmitWarning, process, [warning, ...args]);
}) as typeof process.emitWarning;

try {
  await import("../src/cli.js");
} finally {
  process.emitWarning = originalEmitWarning;
}
