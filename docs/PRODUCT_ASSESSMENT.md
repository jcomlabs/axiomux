# Axiomux objective product assessment

The implementation was developed under the internal name `SUPERAI`; `.superai`, `SUPERAI_*`, and some source identifiers remain compatibility namespaces. Axiomux is the public product identity.

Date: 2026-07-17.

Assessed state: `0.1.0-alpha`, before the first public release.

## Verdict

Axiomux is already a coherent, technically interesting project to publish as a **local, open-source alpha**. The combination of OMP login, strict isolation, governed memory, quarantined learning, steering, Fusion, and an effect ledger has its own identity; this is not merely a prompt collection.

It must not yet be advertised as “risk-free,” “production-ready,” or fully operational for Browser/Computer Use. The core has good automated coverage, but real accounts/providers, workflows involving external services, and browser/desktop adapters need additional controlled validation.

Recommended decision:

- **go** for local Git, tests, a private demo, and a future GitHub repository marked `alpha`;
- **conditional go** for personal use with non-sensitive data and strict OMP;
- **no-go** for desktop control using personal accounts, remote UI exposure, or irreversible automation without a VM;
- **no-go** for E2E-support claims across all providers until every requested account is tested inside the isolated OMP credential database.

## What was built

### 1. A multi-provider control plane

OMP handles login and execution flows it already supports. In `17.0.4`, 57 OMP logins were enumerated; Axiomux adds native Neuralwatt. A “catalogued login” guarantees neither a backend/model nor account access, quota, or an E2E turn. RPC is the normal path, and only the audited pre-auth rejection switches to the official `auth-broker` CLI subcommand in the same isolated vault.

This is more sustainable than copying OAuth/provider logic: new compatible integrations can appear through the authentication broker without rewriting the agent. Axiomux is not an OMP fork/mod and does not depend on extensions; the official release is installed project-locally, verified, and used only as a process dependency.

### 2. An agent runtime, not merely chat

Projects, sessions, tasks, turns, events, steering, follow-ups, stop requests, provider health, and effects remain persistent. TUI and UI share one supervisor, with a single active task per project and a durable queue. The operator can redirect the agent while it works; after a crash, incomplete work remains visible but is never resumed automatically.

### 3. Memory and learning with governance

Memory includes provenance, review states, scopes, feedback, relations, and export. Hybrid retrieval is offline and explainable. Learning does not auto-execute code: it creates candidates, requires review, converts them into quarantine, and requires another approval.

### 4. Resilient execution

Fallback is blocked after consequential effects. Workflows have a definition hash, pre-effect journal, and idempotency keys. Fusion tolerates partial failures and gives no tools to consultants.

### 5. Original identity

The voice is direct, incisive, and dry, with dynamic intensity `0–3`, while policy lives in a separate layer. Self-evaluation stores only `pending` operational metadata with a TTL, not factuality judgments. The product no longer depends on a third-party character for its name, image, or lore.

### 6. International publication surface

The current unreleased snapshot establishes English as the public baseline for source, comments, CLI/TUI/API messages, documentation, tests, metadata, and examples. The web UI alone has an English-default EN/PT selector backed by locale resources; narrow Portuguese safety/steering fixtures remain only where non-English input behavior itself is under test.

## Real strengths

| Strength | Why it matters |
|---|---|
| login delegated to OMP's authentication broker | avoids storing/copying tokens and reduces per-provider maintenance |
| OMP isolation plus exact `17.0.4` version/digest | closes implicit configuration/extensions/skills/rules, verifies the official per-platform SHA before every spawn, and fails if the surface/binary changes |
| managed OMP installation | `omp:install` pins the project asset, constrains hosts/size, and refuses to replace unexpected bytes |
| governed local tools | OMP receives only `todo`/`web_search`; paths, limits, approvals, and effects remain under Axiomux control |
| native Neuralwatt plus DPAPI | adds the provider without executing an OMP extension or persisting plaintext credentials |
| unified routing | Neuralwatt and OMP share catalogue/UI; empty fallback up to 8 and Fusion/MoA with 2–8 expose visible limits |
| real steering and follow-up | approaches modern agentic-tool UX; the operator is not trapped in a long turn |
| effect ledger before action | creates a concrete rule preventing action replay during fallback |
| governed, explainable memory | provenance/review/recall logs are more auditable than opaque cloud memory |
| two reviews in the automatic skill loop | separates “appears reusable” from “may enter the active prompt”; manual `/learn` still preserves quarantine/final approval |
| tool-less Fusion | gains model diversity without multiplying permissioned agents |
| hardened loopback UI | offers useful UX without pretending to be a multi-user service |
| tested multi-project support | roots, sessions, tasks, memory, and SourceHub remain scoped; global search is explicit/read-only and projects may run concurrently |
| explicit provenance/licenses | supports MIT publication without mixing FSL/SUL/AGPL/proprietary code |
| metadata-only upstream radar | baselines, filters, and review help track mechanisms without downloading/applying code |
| localized UI without localized runtime behavior | expands the audience while preserving deterministic English diagnostics and published interfaces |

## Current defects and risks

### Critical for any production claim

1. **There is no operating-system sandbox for host processes/adapters.** Native OMP filesystem, shell, Python, and browser tools were removed. Even so, an approved executable, Browser Use, or UFO runs with the user's privileges; an allowlist, `shell: false`, reduced environment, and effect ledger are not a VM/container.

2. **Browser and desktop have not been validated E2E in this distribution environment.** Browser Use depends on credentials and a destination and sends the task/page state and potentially screenshots to a second cloud LLM; UFO depends on an external checkout/configuration. Import/compile/contract checks are not equivalent to safely completing a real task.

3. **The upstream OAuth callback may expose a port to the LAN.** This was observed in `17.0.2` for OpenAI Codex, Anthropic, and GitLab; the reviewed `17.0.4` monitored diff did not change those flows. Warning/confirmation and device flow mitigate but do not repair the bind.

4. **Security depends on the pinned OMP binary.** The runtime requires the official per-platform version and SHA-256 before every spawn; this blocks drift/silent replacement, but the Windows binary lacks Authenticode and trust still begins at the official release.

5. **Primary state is not encrypted.** ACL/mode protection prevents access by other accounts, but malware/code running as the same user can read conversations and memory. Only the persisted Neuralwatt key uses DPAPI.

6. **There has been no external audit.** Internal tests are necessary, not sufficient to validate authentication, SSRF, child-process, UI, and prompt-injection boundaries.

### Operational defects

1. **Onboarding is split between CLI and UI.** Login and workflow recovery exist in the CLI; the web UI does not yet offer visual management of these flows.

2. **External-service idempotency still depends on the destination.** Workflow memory uses a transaction plus a stable key, and agent steps with unknown outcomes block automatic replay. APIs/providers without their own idempotency key cannot receive a transactional guarantee invented by Axiomux.

3. **Real providers have not all been validated in this isolated database.** The catalogue proves an OMP-advertised capability, not account, quota, model, and terms success for every user. A previous global login is deliberately not copied.

4. **The first catalogue/UI load may be slow.** Discovery starts an isolated OMP process and queries providers/models; there is a short cache but no persistent daemon.

5. **The database uses Node 24's experimental SQLite API.** Appropriate for this alpha, but it needs migration, backup, and upgrade testing before long-term-stability claims.

6. **Neuralwatt remains Windows-first.** DPAPI provides a robust persistent Windows path, but the CLI does not generate the catalogue on other platforms without supported persistent storage; an environment variable alone does not complete setup.

7. **Perplexity and multi-account UX are limited.** Perplexity uses an unofficial, reverse-engineered email-OTP flow and may produce zero models. OMP can store multiple accounts, but Axiomux cannot select one; logout removes every credential for a provider.

8. **Routing may multiply exposure.** Configuring up to 8 fallbacks or 8 Fusion participants increases cost, latency, transfer, and variability. Empty/disabled defaults reduce but do not remove operator responsibility.

9. **The upstream radar does not understand code.** It compares metadata, paths/hashes, and topics; it may miss changes outside filters, produce false positives, or hit rate limits. Human review remains mandatory.

### Agent-quality limits

1. **Feature hashing does not understand deep semantics.** It works well for terms, aliases, morphology, and overlap; it performs worse on paraphrases with no shared vocabulary.

2. **Contradictions are heuristic suggestions.** There is no automatic logical or temporal resolution.

3. **Fusion can amplify error.** More models do not guarantee truth; candidates may repeat the same false source. Synthesis still requires verification by the primary agent.

4. **Personality may make responses more engaging, not more correct.** Humor must remain subordinate to evidence and clarity.

5. **Provider fallback may change privacy and behavior.** It is correctly opt-in, but operators must understand that the same request can cross different entities.

A model persisted in a session is the deliberate exception: it is exact and does not use global fallback, preserving the routing/privacy decision.

## Improvements completed in this review

- `retry/complete/fail` recovery, legacy adoption, and state inspection exposed in the CLI;
- workflow memory bound atomically to its idempotency key;
- fault injection proves fallback does not occur after a consequential host tool;
- `doctor` treats desired providers as catalogue capabilities rather than a rigid mandatory list;
- managed OMP runtime `17.0.4`, verified project-local installation, and official per-platform SHA-256 checks before every spawn;
- explicit separation: process/RPC without fork/mod/extensions; only relevant authentication/provider/model/RPC mechanisms adopted, with upstream TUI/hub/advisor/autolearn excluded;
- normal RPC login, official CLI fallback only for the exact pre-auth rejection, `PI_AUTH_NO_BORROW=1`, confirmed logout, and `0.0.0.0` callback warning;
- native OMP filesystem/shell/Python/browser/LSP/image tools removed; only `todo` and `web_search` cross the native boundary;
- collision-free `workspace_*`, `run_program`, and `run_python` host tools with roots/limits/approval/effect ledger; compatible `read`, `write`, `code`, and `automation` profiles;
- browser/desktop adapters registered only when profile and configuration enable them together;
- tasks unified between supervisor/agent, persisted output, single-flight per project, and fail-closed restart reconciliation;
- multi-project registry, canonical roots, persisted selection/unlink, immutable sessions, scoped/explicit-global search, UI routing, and two-workspace E2E;
- fallback `status|set|clear`, empty by default, arbitrary Fusion/MoA up to 8, and a UI Routing dialog using the unified Neuralwatt/OMP catalogue;
- `upstream list|check|show|mark` radar with 12 baselines/filters, private state, and no patch transfer/application;
- `shared` and `yolo` removed from supported configuration;
- npm audit, worktree/history secret scanning, SHA-pinned Actions, and Dependabot;
- Browser Use Python audit with no known vulnerabilities after overrides for `aiohttp`, `click`, `mcp`, `pillow`, and `pypdf`;
- UI visually validated, including provider/model, memory, and one-use approval/denial;
- public English publication baseline, explicit language audit, English-default EN/PT web UI, and English filenames for the roadmap/report.

## Priorities

### Must — before a public release presented as more than alpha

1. OpenAI Codex is now proven inside the isolated database with 19 listed models, a real GPT-5.6 turn, and a governed host-tool E2E. Validate Anthropic/Claude, Cursor, Google Antigravity, and Neuralwatt before advertising those routes as E2E; record Perplexity as tool login if it continues to expose no models.
2. Keep the successful `doctor:online` and disposable `e2e:host` evidence reproducible after release changes; both passed on 2026-07-18 and the E2E removed its temporary memory/session.
3. Run the created CI in a future remote GitHub repository and confirm Windows plus Linux from a clean checkout.
4. Obtain human/external review of authentication, SSRF, child-process, and prompt-injection boundaries before claiming production readiness.
5. Mark Browser Use/UFO experimental until a reproducible VM E2E report exists.
6. Publish only the clean root-history candidate; private development branches retain retired identity work and must not be pushed.
7. Confirm the Axiomux candidate identity after owner/legal review; the preliminary exact-name web, GitHub, and npm check is not trademark clearance.

### Should — material improvement for the next version

1. Make local semantic embeddings a modular option, retaining FTS/feature hashing as an offline fallback and versioning the index.
2. Create formal SQLite migrations and upgrade/downgrade/backup-restore tests.
3. Add optional encryption at rest for conversations/memory, with documented key recovery.
4. Separate mandatory checks and informational capabilities in `doctor`.
5. Create a provider smoke-test matrix with `not tested`, `login tested`, `model tested`, and OMP date/version.
6. Measure quality: recall benchmark, workflow crash matrix, Fusion latency/cost, and repeatable agentic tasks.
7. Package a reproducible Windows launcher/installer without concealing Node/OMP/uv.
8. Add per-project limits for memory, sources, logs, and retention.
9. Improve the UI with export, visual memory/skill/workflow management, and explicit per-task cost/provider indication.
10. Create a lockfile/dependency update policy and advisory-review process.
11. Benchmark routing with a cost/latency/quality matrix and per-provider data-residency rules.

### Could — useful but not core blockers

1. A documented provider/plugin SDK for native integrations beyond Neuralwatt.
2. Configurable persona profiles, retaining Axiomux as the default public identity.
3. Local open-weight/Ollama connectors with licenses visible in the catalogue.
4. Provenance-graph and memory-relation visualization.
5. Read-only session replays for debugging.
6. Governed skill export/import with signature/hash and trust policy.
7. Automated single-model versus Fusion/MoA comparison benchmarks.
8. An isolated browser worker in a disposable product-managed VM/container.

## Open decisions

### What should probably remain

- **OMP as the authentication/runtime substrate:** this is the product's greatest leverage; process/RPC integration avoids a fork and duplicated credentials in source code.
- **strict/always-ask without `shared`/`yolo`:** an architectural decision, not a missing feature; reopening these modes would invalidate isolation and authorization.
- **original local memory:** a better licensing, privacy, and governance fit than introducing Honcho/OB1 as a mandatory service.
- **Fusion disabled by default:** differentiated capability whose cost/privacy impact correctly makes it opt-in.
- **skills with two reviews:** useful friction precisely where self-learning becomes persistent execution.
- **configurable Axiomux identity:** provides character without binding policy to a protected character.

### What deserves scrutiny before remaining the default

- **`autoLearn: true`:** it currently creates candidates only and activates no skills, so risk is low; it may still create noise. For a public release, `false` or explicit onboarding may be a better default.
- **remote/proprietary default model:** convenient on this machine, but conflicts with the strictest reading of “everything open source.” Code can remain MIT while the model is external if stated unambiguously; alternatively, first run can require a choice.
- **`code` as the default profile:** preserves direct program/Python execution for engineering verification but exposes more than `write`; onboarding could request an explicit choice.
- **native `web_search`:** useful for research but sends queries externally and depends on OMP/provider policy; a privacy-first installation may prefer removing it from the default.

### What should probably leave the core

- **UFO as a central promise:** it should remain an experimental adapter or separate package; desktop-automation maintenance and risk could distort the core focus.
- **any “best of every repository” claim:** not verifiable. The product should claim concrete capabilities and benchmarks, not superiority by association.
- **history/artifacts from the old identity:** they do not belong in the future public repository; preserve only the useful technical report and publish clean history.

## Is this an interesting GitHub product?

Yes, with disciplined presentation:

- clear title: local-first multi-provider agent with governed memory/skills;
- `alpha` status, with no production promises;
- short demo of isolated login, model switching, steering, memory recall, and approval;
- visible architecture and threat model;
- honest table of tested versus optional integrations;
- explicit license/provenance;
- initial issues aligned with the Must/Should sections.

The differentiator is not “many features.” It is combining heterogeneous providers with one local layer of continuity, governance, and operator control. That is the center that should guide the roadmap; anything that does not reinforce it should remain optional or be removed.
