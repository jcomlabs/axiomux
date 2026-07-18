# Submission copy

This is an English working draft for Devpost. Replace every bracketed field with verified public information before submission.

## Title

Axiomux

## Tagline

Switch AI providers without surrendering project memory, tool governance, or operator control.

## Track

Developer Tools

## Short description

Axiomux is an MIT-licensed, local-first control plane for coding agents. It unifies provider login and model selection while keeping projects, steering, governed memory, quarantined skills, effect approvals, fallback, and tool-less multi-model Fusion under one operator-controlled runtime.

## Full description

Coding agents increasingly offer many models, but switching providers often means switching the entire operational context: credentials, history, memory, tools, permissions, and recovery semantics. Axiomux separates the model-execution substrate from the agent's continuity and authority.

OMP runs as a pinned, digest-verified external process for supported authentication and model execution. Axiomux is not an OMP fork or extension: it owns the project registry, sessions, steering, follow-up queue, local tools, effect journal, memory, reusable skills, workflows, fallback, Fusion/MoA, and bilingual local UI. Neuralwatt is implemented as a native provider and appears in the same catalogue as other flows.

Memory is stored locally with provenance, review state, feedback, relations, and bounded retrieval. Automatic learning cannot silently activate code: it creates a candidate, requires human review, converts into quarantine, requires a second approval, and records evaluation. Consequential tool effects are journaled before execution. Cross-provider fallback stops once an effect makes replay unsafe. Fusion can combine arbitrary catalogue models, but consultants are tool-less and failures are isolated; only the primary agent can request actions.

The judge package includes a deterministic offline demo that executes these real production components without provider credentials, network access, or user-state mutation. Its central proof hands one local session from an exact Provider A route to Provider B while retaining the prior answer and approved project memory. It then shows the safety distinction that ordinary orchestration misses: a pre-effect provider outage falls back, but a post-effect outage stops without replaying the completed action. The same run also proves governed recall, effect classification, skill quarantine, and Fusion partial-failure behavior. A separately recorded Axiomux-branded live check returned the requested exact token through `openai-codex/gpt-5.6-sol`; the online doctor and governed host-tool E2E also passed on 2026-07-18.

Axiomux was built with Codex during the Build Week submission period. Codex accelerated repository analysis, architecture, implementation, security hardening, regression tests, bilingual UI work, release repair, and evidence packaging. I made the key product and safety decisions: create a new harness rather than a mod; keep strict isolation and explicit approval; preserve fallback without replaying effects; make Fusion arbitrary but tool-less; and separate general engineering improvements from submission-only work.

Axiomux is an honest alpha, not a claim of universal provider support or a production sandbox. Catalogue entries, account entitlement, and successful model turns are reported separately, and browser/desktop adapters remain experimental.

## Built with

- TypeScript and Node.js 24
- Node SQLite/FTS5
- OMP `17.0.4` as a pinned external authentication/model process
- GPT-5.6 Sol through the OpenAI Codex provider path
- Codex as the primary engineering collaborator
- HTML/CSS/JavaScript bilingual local UI
- optional Browser Use and Microsoft UFO adapters, explicitly outside the core judge path

## Key accomplishments

- One continuity and governance layer across heterogeneous model providers.
- Deterministic, credential-free continuity handoff and effect-aware fallback using shipped production components.
- Two-stage human review for learned skills.
- Effect-aware fallback and tool-less Fusion with partial-failure isolation.
- Native Neuralwatt integration without enabling third-party OMP extensions.
- Self-contained npm tarball that judges can install without rebuilding.
- Explicit licensing, provenance, threat model, and known-issues documentation.

## Challenges

- Reusing OMP's excellent login surface without becoming an OMP fork or inheriting extension authority.
- Keeping fallback useful while preventing a model retry from repeating an external effect.
- Making memory and self-learning valuable without treating imported text or generated code as trusted.
- Packaging the compiled CLI and installer so a fresh consumer installation has no TypeScript dependency.
- Distinguishing catalogue capability, successful authentication, model availability, and a real turn in every public claim.

## What is next

- finish a provider smoke-test matrix with dated, credential-free evidence;
- add formal SQLite migrations, backup/restore tests, and optional encryption at rest;
- validate Windows and Linux packages in remote CI;
- move browser/desktop automation into a stronger disposable isolation boundary;
- benchmark recall, Fusion quality/latency/cost, and crash/replay behavior.

## Submission fields still required

- Repository URL: `https://github.com/jcomlabs/axiomux/tree/submission/openai-build-week`
- Public YouTube URL: `[PENDING RECORDING AND OWNER AUTHORIZATION]`
- `/feedback` Codex Session ID: candidate `019f6d77-c676-7483-a899-e43eb97dac22`; `[CONFIRM BEFORE SUBMISSION]`
- Release tarball: `https://github.com/jcomlabs/axiomux/releases/download/v0.1.0-alpha/axiomux-agent-0.1.0.tgz`; matching SHA-256: `https://github.com/jcomlabs/axiomux/releases/download/v0.1.0-alpha/axiomux-agent-0.1.0.tgz.sha256`
- Live GPT-5.6 evidence date/model/result: verified on 2026-07-18 (WEST) with `openai-codex/gpt-5.6-sol`; requested result `AXIOMUX_GPT56_OK`, online doctor result `AXIOMUX_DOCTOR_OK`, and governed host-tool result `HOST_TOOL_OK`. See `BUILD_WEEK.md` for the redacted evidence record.

Do not submit text containing a bracketed placeholder.
