---
name: Systematic Debugging
description: Diagnose failures from reproduced evidence, isolate the cause, repair narrowly and verify the original symptom.
license: MIT
origin: adapted-from-obra-superpowers
---

# Systematic Debugging

## Procedure

1. Reproduce the exact symptom and capture error text, inputs, environment and exit state.
2. Separate observations from hypotheses. Rank hypotheses by explanatory power and test cost.
3. Find the earliest point where observed state diverges from expected state.
4. Change one causal variable at a time. Avoid speculative bundles of fixes.
5. Re-run the original reproduction, adjacent regression checks and a negative case.
6. Report the proven cause, repair, verification and remaining uncertainty.

## Stop conditions

Stop and request authority before destructive recovery, credential rotation, data migration or machine restart.

