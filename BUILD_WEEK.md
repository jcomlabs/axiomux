# OpenAI Build Week 2026

Axiomux is the secondary submission candidate for the **Developer Tools** track. It is a local control plane for coding agents: operators can move between model providers without surrendering project continuity, while memory, reusable skills, tool effects, and multi-model consultation remain governed by one local runtime.

Official rules: <https://openai.devpost.com/rules>

Submission deadline: **2026-07-21 17:00 PDT**, which is **2026-07-22 01:00 WEST** in mainland Portugal. Leave a safety buffer; Devpost accepts no edits after the submission period closes.

## Branch boundary

Build Week work is deliberately reversible and does not redefine the general product branch.

| Branch | Purpose | Allowed content |
|---|---|---|
| `main` | clean public product | general reliability, packaging, security, runtime, and documentation |
| `submission/openai-build-week` | reversible submission layer | judge demo, event evidence, video script, and submission copy |

To abandon the submission layer and continue normal development, switch back to `main`. The submission branch is exactly one reversible commit above the current general product branch.

## What judges can verify

The deterministic offline demo runs real production components without network access, credentials, or changes to user state:

```powershell
npx axiomux-demo
```

It proves six bounded claims, led by the product's differentiator:

1. one local session hands off between two exact provider routes while retaining the prior answer and approved project memory;
2. a provider failure before any effect falls back, while a failure after a recorded effect stops without replay;
3. approved memory is recalled with provenance while rejected material remains excluded;
4. read-only, external, and destructive effects reach different policy outcomes;
5. skills progress through quarantine, approval, and evaluation, while a remote-execution candidate is rejected;
6. arbitrary Fusion participants run without tools, one provider failure is isolated, and only public model output reaches synthesis.

The provider runners in this deterministic path are offline fixtures. The session, memory, routing, effect ledger, fallback, policy, skill, and Fusion engines are the shipped production implementations. Live GPT-5.6 evidence is recorded separately below.

See [judge testing](docs/JUDGE_TESTING.md) for the prebuilt-package path and [demo script](docs/DEMO_SCRIPT.md) for the sub-three-minute recording plan.

## Why this is a developer tool

Provider switching is usually coupled to a provider's own history, permissions, and agent harness. Axiomux separates those concerns:

- OMP is a pinned external authentication and model-execution substrate, not the product shell;
- Axiomux owns projects, sessions, steering, fallback, effects, memory, skill governance, workflows, Fusion/MoA, and UI;
- a native Neuralwatt adapter joins the same provider catalogue without enabling OMP extensions;
- provider fallback stops after consequential effects, and Fusion consultants never receive tools;
- an upstream radar tracks only relevant paths and metadata, requiring human review before any adoption.

The central idea is **portable continuity with explicit authority**: change the model, not the operator's safety boundary or accumulated project context.

## Collaboration with Codex

Codex was used as the primary engineering collaborator from architecture through validation. It inspected the local predecessor and upstream repositories, designed the process boundary around OMP, implemented the runtime, wrote tests, hardened authentication and local-tool isolation, built the bilingual UI, repaired release packaging, and produced the deterministic judge path.

The human owner made the consequential product decisions:

- build a new harness rather than an OMP fork or branded mod;
- preserve strict isolation and explicit approval instead of adding `shared` or `yolo` authority;
- keep fallback, but stop replay after an effect;
- permit arbitrary Fusion/MoA combinations while keeping consultants tool-less;
- make Neuralwatt native and visually equal to other provider flows;
- keep memory local and governed instead of requiring a hosted memory service;
- separate general improvements from submission-only presentation work.

Codex accelerated implementation, integration review, threat modelling, regression coverage, English publication cleanup, and package validation. The owner repeatedly challenged architecture and scope decisions; the resulting boundaries are deliberate rather than generated defaults.

## GPT-5.6 role and evidence status

The product's configured OpenAI path targets `openai-codex/gpt-5.6-sol`. GPT-5.6 is intended to be a real selectable primary model through the same provider boundary as every other model, not a decorative API string. The final submission must include a successful isolated-vault turn and record the exact command, date, model identifier, and redacted result in this file.

Current evidence status on 2026-07-18 (WEST):

- **implemented:** GPT-5.6 Sol is the configured default route;
- **implemented:** provider/model selection, exact per-session routing, fallback, and Fusion accept catalogue models;
- **verified:** OpenAI device login completed inside Axiomux's isolated OMP vault without importing a global credential;
- **verified:** the isolated catalogue exposed `openai-codex/gpt-5.6-sol` and the runtime selected that exact model;
- **verified:** an Axiomux-branded bounded turn returned the requested exact token `AXIOMUX_GPT56_OK`;
- **verified:** `doctor --online` selected `openai-codex/gpt-5.6-sol`, verified OMP `17.0.4` and its official Windows digest, and returned `AXIOMUX_DOCTOR_OK` from the live model;
- **verified:** `npm run e2e:host` made GPT-5.6 call the governed `memory_remember` host tool exactly once, returned `HOST_TOOL_OK`, and removed the disposable memory/session.

Credential-free reproduction evidence:

```text
Date: 2026-07-18 (WEST)
Command: npm run start -- chat "Reply with AXIOMUX_GPT56_OK only"
Model: openai-codex/gpt-5.6-sol
Observed result: AXIOMUX_GPT56_OK
Online doctor result: AXIOMUX_DOCTOR_OK
Governed host-tool E2E result: HOST_TOOL_OK (1 tool call; disposable state removed)
```

No token, authorization code, callback URL, account identifier, or credential database is committed. Catalogue discovery alone is not treated as proof; the claims above are based on the completed bounded turn, online doctor, and governed host-tool E2E.

## Dated build evidence

Axiomux was implemented during the submission window. The public release branch intentionally starts with one clean root commit dated 2026-07-18 so retired private identity work cannot leak through Git history. The local development branches retain the finer-grained milestone history for owner audit but must not be pushed.

| Date | Evidence produced in the window |
|---|---|
| 2026-07-17 | secure runtime, original agent architecture, unified provider login, native Neuralwatt, routing, arbitrary Fusion/MoA, and selective upstream radar |
| 2026-07-17 | English publication baseline, bilingual EN/PT UI, response-locale enforcement, self-contained package, and deterministic offline judge path |
| 2026-07-18 | OMP 17.0.2 host-tool compatibility repair, live GPT-5.6 turn, online doctor, governed host-tool E2E, and portable-continuity/effect-aware-fallback proof |
| 2026-07-18 | full 187-test/security gate, clean Axiomux identity scan, and fresh installation of the compiled 2.1 MB judge tarball with both binaries passing and zero stderr |
| 2026-07-18 | selective OMP 17.0.4 review: only the Kimi device-id compatibility path changed inside the monitored surface; official digests, managed installation, catalogue, and live GPT-5.6 doctor revalidated |

Candidate Codex `/feedback` session ID: `019f6d77-c676-7483-a899-e43eb97dac22`. The owner must submit `/feedback` from the primary task and confirm the returned identifier before placing it in Devpost.

## Submission gate

| Requirement | State |
|---|---|
| Developer Tools category | ready |
| English description | drafted in [submission copy](docs/SUBMISSION_COPY.md) |
| installable test build without rebuilding | validated from the exact tarball in a new directory; the release includes the tarball and matching `.sha256` asset |
| supported-platform statement | documented; Windows 11 x64 is the validated target |
| public or judge-shared repository | public submission branch at `https://github.com/jcomlabs/axiomux/tree/submission/openai-build-week` |
| MIT license and provenance | present |
| clean public history | ready: `main` begins at a sanitized root and contains only general fixes; the submission layer is exactly one reversible commit above it |
| successful GPT-5.6 product turn | verified on 2026-07-18: exact Axiomux turn, online doctor, and governed host-tool E2E |
| public YouTube demo under three minutes with audio | script ready; recording/upload pending owner action |
| final `/feedback` session ID | candidate known; owner confirmation pending |

Repository publication is owner-authorized. Devpost submission and public video upload remain owner actions.
