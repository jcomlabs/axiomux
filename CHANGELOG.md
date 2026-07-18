# Changelog

## Unreleased

- Adopted Axiomux as the public product, package, CLI, UI, documentation, and asset identity.
- Kept `.superai`, `SUPERAI_*`, persisted schemas, and selected source identifiers stable through 1.x; Neuralwatt continues to recognize credential-free catalogues written under either earlier identity.
- Recorded `JC-OM` as the package author and license holder without asserting an organization or repository URL.

## 0.1.0-alpha - 2026-07-17

Initial pre-release implementation.

### Language and publication baseline

- Standardized public source code, comments, CLI/TUI/API messages, documentation, metadata, tests, and examples on publication-quality English.
- Added an English-default EN/PT selector to the web UI; Portuguese is confined to `pt-PT` locale resources rather than duplicated product logic.
- Propagated the selected UI language as a bounded per-turn model presentation preference to the principal agent, Fusion/MoA consultants, and synthesizer while preserving exact code, commands, logs, errors, quotations, source excerpts, data values, and existing history.
- Added a repository language audit for residual Portuguese and mojibake, plus an explicit contribution policy for the narrow, documented fixture exceptions.
- Renamed the public roadmap and consolidated report to `PLAN.md` and `REPORT.md`.

### Providers and authentication

- Added OMP JSONL RPC integration for auth-broker discovery/login, provider status, model catalogue, model switching and streamed turns.
- Observed 57 OMP authentication flows in `17.0.4` and added Neuralwatt natively; catalogued authentication is not claimed as a chat backend, model or account E2E result.
- Added terminal-only fallback to the official `omp auth-broker` CLI for the exact audited pre-auth RPC rejection, plus confirmed provider-wide logout, fixed argv and `PI_AUTH_NO_BORROW=1`.
- Added confirmation for OMP callbacks known to bind `0.0.0.0` and recommended OpenAI device flow; documented the unofficial/reverse-engineered Perplexity email-OTP flow.
- Added aliases for common provider names without hard-coding the complete OMP catalogue.
- Isolated OMP runtime state under `.superai/omp-runtime/` and enforced `--no-extensions --no-skills --no-rules` for every RPC process.
- Pinned OMP to `17.0.4` / commit `3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0` after a selective source review and verify the official platform SHA-256 before every process spawn.
- Added `npm run omp:install` for bounded, atomic, project-local installation of the official audited OMP asset; Axiomux remains process/RPC interoperability, not an OMP fork or extension.
- Added a temporary credential-free bootstrap model for discovery/login in a fresh isolated OMP database; it is removed on shutdown or by a later exact-marker cleanup after a crash.
- Replaced the former Neuralwatt OMP extension with a native Axiomux provider: authenticated quota validation, bounded model discovery, DPAPI `CurrentUser` storage on Windows, credential-free `models.yml` generation and fail-closed stale-credential detection.
- Unified Neuralwatt visually with the provider/model catalogue, fallback and Fusion/MoA instead of exposing plugin/bridge terminology.
- Kept cross-provider fallback empty by default and blocked fallback after a consequential effect.
- Added `fallback status|set|clear` with live catalogue validation and a limit of 8 routes; explicit session/request routing remains exact and disables fallback/Fusion.

### Agent runtime and interfaces

- Added persistent projects, sessions, turns, events, effect ledger, tasks, steering messages and provider circuit health in SQLite.
- Added a central multi-project registry with canonical roots, persisted selection/unlink, immutable project/session routing, scoped memory/search/tools, per-project single-flight, cross-project concurrency and explicit global read-only search.
- Added concurrent TUI streaming with live steering, explicit stop and durable follow-up tasks.
- Added a loopback-only web UI with one-time bootstrap, HttpOnly session cookie, same-origin mutations, projects/sessions, history, provider/model selection, SSE streaming and sanitized public trace.
- Replaced the previous character identity with the original Axiomux persona: direct, incisive and dry, without third-party character names, dialogue or imagery.
- Added dynamic persona intensity `0–3`, exact per-session model routing without global fallback and TTL-bound pending operational self-evaluation metadata.

### Memory, learning and workflows

- Added SQLite/FTS memory with source documents/chunks, provenance, review state, scopes, expiry, supersession, recall logs, feedback, relations and portable export.
- Added offline hybrid retrieval using FTS5 plus deterministic feature-hash vectors, RRF, MMR and recency. These vectors are not learned semantic embeddings.
- Added governed learning candidates, separate approval before conversion, quarantined skills, version history, evaluations, rollback and governance export.
- Added durable workflows with canonical definition hash, pre-effect journal, stable idempotency keys, retry budget and explicit recovery for unknown in-flight effects.
- Exposed workflow status/adoption/recovery in the CLI and made workflow memory effects transactionally idempotent.

### Fusion, sources and adapters

- Added opt-in MoA/Fusion with bounded concurrency, candidate timeouts, partial-failure tolerance, tool-less consultants and optional tool-less synthesis.
- Extended Fusion/MoA routing to 2–8 arbitrary catalogue participants, a selectable synthesis model and matching CLI/UI Routing controls.
- Added multi-source ingestion with workspace controls, provenance, chunking, body/type limits, SSRF-resistant DNS/IP pinning and redirect validation.
- Added optional Browser Use `0.13.6` sidecar with fixed domain allowlist, ephemeral profile/downloads, disabled extensions, IP blocking and bounded execution.
- Added governed workspace host tools and read/write/code/automation profiles. OMP-native filesystem, shell, Python, browser, LSP and image tools are structurally refused; only `todo` and prompted `web_search` cross that boundary.
- Exposed governed filesystem/process capabilities through collision-free `workspace_*`, `run_program`, and `run_python` host-tool names because OMP reserves its built-in names even when the native tools are disabled.
- Removed shared OMP isolation and every auto-approval mode for mutating tools; strict isolation plus `always-ask` are the only supported runtime contract.
- Added a metadata-only upstream radar with audited baselines, includes/excludes/topics, `list|check|show|mark`, private review state and no patch download or automatic application.
- Added pinned GitHub Actions, Dependabot and worktree/history secret scanning.
- Added optional Microsoft UFO JSON bridge for a separately installed/reviewed checkout.

### Security and quality

- Added child-process environment allowlists, private state ACL/modes, audit redaction, secret detection and bounded process termination.
- Added workspace-root and realpath enforcement, sensitive-path/ADS/device-name denial, bounded reads/searches, explicit write/exec approvals and direct-argv command execution with no shell.
- Added tests for OMP isolation/RPC, Neuralwatt vault/config, runtime persistence, Fusion, hybrid memory, skill governance, UI request boundaries, supervisor steering, source controls and workflow crash safety.
- Added Windows/Linux CI plus optional Python adapter compile/import checks.
- Added Biome `2.5.4` lint/format tooling and recorded permissive notices for runtime dependencies `yaml 2.9.0` and `ipaddr.js 2.4.0`.
- Updated the frozen Browser Use environment with security overrides for `aiohttp`, `click`, `mcp`, `pillow` and `pypdf`; `pip-audit` reported no known vulnerabilities in the checked snapshot.

### Known limitations

- OMP compatibility is verified against the installed/runtime-tested surface, not guaranteed for every future OMP release.
- The isolated OMP credential database requires separate login; global OMP credentials are deliberately not migrated.
- Neuralwatt's complete persistent setup is Windows-only in 0.1.0; non-Windows use requires an externally provisioned credential-free model catalogue plus an environment key.
- Browser Use and UFO are not full E2E validated here without external credentials/installations.
- Browser Use may send the task, page state and screenshots/vision to a second cloud LLM and remains disabled by default.
- Memory feature hashing improves local fuzzy retrieval but is not equivalent to a learned semantic embedding model.
- `.superai/state.db` is access-controlled but not encrypted at rest.
- The project has not received an external security audit and remains pre-1.0.
