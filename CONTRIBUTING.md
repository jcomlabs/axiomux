# Contributing

Axiomux is MIT licensed. Contributions must remain redistributable under that model and preserve the project's explicit security boundaries.

## Language policy

Public source code, code comments, CLI/TUI output, API messages, documentation, metadata, tests, fixtures, and examples must be written in English. English is the product and publication baseline.

Only web UI locale resources may contain Portuguese, and they must provide equivalent `en` and `pt-PT` entries with English as the default. A non-English safety/input-compatibility fixture is permitted only when its purpose is explicit, documented, and impossible to preserve with neutral synthetic text; it must not leak into default output or product metadata.

## Before changing code

- Do not copy proprietary prompts, leaked material, source under incompatible terms or third-party branding.
- Record a new upstream influence in `SOURCES.md`; add a notice when code or a runtime dependency is actually incorporated.
- Never add credentials, OAuth callbacks, local vaults, `.superai/`, personal paths or exported conversations.
- Treat changes to authentication, tools, memory authority, workflow replay, child processes and adapters as security-sensitive.

## Local checks

```powershell
npm ci
npm run omp:install
npm run validate
```

`validate` runs type checking, Biome lint/format checks, a clean build, the Node test suite, `npm audit --audit-level=low` and the worktree/Git-history secret scan. Use `npm run validate:full` to add the frozen Browser Use `pip-audit` gate.

If Python adapters changed:

```powershell
python -m py_compile adapters\browser_use_worker.py adapters\ufo_worker.py
uv run --link-mode copy --project adapters/browser-use --frozen python -c "from browser_use import Agent, ChatBrowserUse, ChatOpenAI; print('browser-sidecar-ok')"
```

The import check validates the frozen environment, not a live browser task.

## Test expectations

Add or update tests for every changed invariant. In particular:

- OMP RPC/model processes must retain `--no-extensions --no-skills --no-rules`, `PI_AUTH_NO_BORROW=1` and isolated HOME/agent directories;
- the OMP executable must match both the exact audited version and the official per-platform digest before every spawn; updating OMP requires a new source/manifest review and contract tests;
- Axiomux must remain process/RPC interoperability rather than an OMP fork, mod, internal-package import or extension; adopt only provider/auth/model/RPC mechanisms needed by the boundary, not upstream TUI/hub/advisor/product layers;
- direct `auth-broker` login/logout must remain terminal-only, fixed-argv, in the same isolated vault and limited to the audited fallback/explicit logout paths;
- `shared` isolation and `yolo` approval must remain rejected: they respectively import implicit global authority and remove the human/effect boundary;
- OMP-native tools must remain limited to `todo` and `web_search`; filesystem, processes, browser and desktop capabilities belong behind governed host-tool boundaries;
- provider discovery/login must not copy or print credentials; document upstream prompts that can echo temporary values and callback binds that expose a port;
- Neuralwatt configuration must remain credential-free and persistent storage must never fall back to plaintext;
- fallback must stop after a consequential effect;
- fallback/Fusion selections must be validated against the unified catalogue, stay within 8 routes/participants and keep explicit session/request routes exact; CLI and UI Routing must share these invariants;
- workflow effects need a durable start journal and stable idempotency key before execution;
- memory authority requires explicit review and feature-hash vectors must not be called learned semantic embeddings;
- learning candidates and skills require separate human reviews;
- UI mutations require authenticated same-origin requests and public events must remove secrets/private reasoning;
- browser/computer adapters remain opt-in, bounded and approved.

Use fault injection for crash/retry behavior. A happy-path unit test is insufficient when a duplicate external effect is possible.

## Live verification

The following commands depend on a local OMP installation and real authentication, so they are not substitutes for deterministic tests:

```powershell
npm run dev -- doctor
npm run doctor:online
npm run e2e:host
```

Run live checks with non-sensitive prompts and disposable data. Browser Use and UFO require separate controlled E2E tests in an isolated profile/VM; state precisely what was and was not exercised in the pull request.

## Documentation and claims

Do not describe optional or untested integrations as operational. Distinguish:

- deterministic unit/integration coverage;
- import or protocol-contract smoke tests;
- live provider calls;
- full E2E actions against an external system.

Keep [README.md](README.md), [SECURITY.md](SECURITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/OPERATIONS.md](docs/OPERATIONS.md) and [docs/PRODUCT_ASSESSMENT.md](docs/PRODUCT_ASSESSMENT.md) aligned with behavioral changes.

Run the repository language audit before publication and treat unexpected non-English product text or mojibake as a release-blocking defect.

## Upstream radar

Use `npm run dev -- upstream check <id>` to triage a configured source. `--all` is deliberate and may hit public GitHub rate limits. The radar must remain metadata-only: no blobs, patches, repository downloads, code execution, baseline mutation or auto-apply.

`upstream mark <id> pending|reviewed|dismissed [note]` records human review only. To adopt a mechanism, inspect the public source/license separately, implement it explicitly in a reviewable change, test it, update provenance, and then update the baseline manually. Do not expand include/topic filters merely to make every upstream change look relevant.

## Pull request scope

Prefer small, reviewable commits. Explain the threat model, rollback path, tests run and any residual risk. Do not combine provider/login changes with unrelated UI, memory or branding work unless the change genuinely crosses those boundaries.
