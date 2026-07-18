---
name: Verification Before Completion
description: Prevent false completion claims by requiring fresh observable evidence tied to every important outcome.
license: MIT
origin: adapted-from-obra-superpowers
---

# Verification Before Completion

## Contract

Before saying a task is done:

1. Translate the request into observable acceptance checks.
2. Run the smallest direct check for each critical behavior.
3. Inspect exit state and meaningful output; do not rely on the absence of an exception.
4. Check the final diff or artifact for accidental scope expansion and secrets.
5. State which checks passed, which were skipped and why.

Configuration edits alone are not proof. A green test unrelated to the changed behavior is not proof.

