#!/usr/bin/env node
import { isExpectedNodeSqliteWarning } from "../src/security/node-warnings.js";

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]): void => {
  if (isExpectedNodeSqliteWarning(warning, args[0])) return;
  Reflect.apply(originalEmitWarning, process, [warning, ...args]);
}) as typeof process.emitWarning;

try {
  const { runJudgeDemo } = await import("../src/judge-demo.js");
  const report = await runJudgeDemo();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report));
  } else {
    console.log("Axiomux portable-continuity demo: PASS");
    for (const check of report.checks) console.log(`  [PASS] ${check.id}: ${check.evidence}`);
    console.log(
      `  Metrics: ${report.metrics.providerHandoffs} provider handoff, ${report.metrics.safeFallbacks} safe fallback, ` +
        `${report.metrics.blockedReplays} blocked replay, ${report.metrics.recalledMemories} recalled memories, ${report.metrics.activeSkills} active governed skill, ` +
        `${report.metrics.usableFusionCandidates}/${report.metrics.fusionParticipants} usable Fusion candidates, ${report.metrics.isolatedFailures} isolated failure.`,
    );
    console.log(`  Completed in ${report.durationMs} ms without network access, provider credentials, or user-state mutation.`);
  }
} finally {
  process.emitWarning = originalEmitWarning;
}
