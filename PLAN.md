# Axiomux delivery roadmap

`SUPERAI` remains the internal compatibility namespace in code, environment variables, and private state paths. Axiomux is the public product identity.

Immediate target version: `0.1.0-alpha`. The goal is to deliver an interesting, testable local-first agent without presenting it as a security product or claiming universal provider support.

## Legend

- **Done**: implemented and covered by relevant validation.
- **Under validation**: code exists, but final integration or evidence remains incomplete.
- **Pending**: must not be advertised as complete.
- **Decision**: requires an owner choice, not engineering work alone.

## Current status

| Area | Status | Objective criterion |
|---|---|---|
| Isolated OMP runtime | Done | `17.0.4` managed project-locally by `omp:install`; official version/digest checked before every spawn; dedicated HOME/agent; limited RPC; extensions/skills/rules disabled |
| Multi-provider login | Done at transport level | 57 flows enumerated by OMP; normal RPC plus official CLI fallback only for the exact audited pre-auth rejection |
| Neuralwatt | Done on Windows | key validated locally, DPAPI storage, secret-free catalogue, secret exposed only to the Neuralwatt child process |
| Memory/skills/workflows | Done for alpha | persistence, review, quarantine, provenance, journal, and explicit recovery |
| Dynamic persona | Done | intensity `0–3`, reloaded between turns, with no authority over policy |
| Self-evaluation | Done with narrow scope | operational metadata, `pending`, TTL; does not measure factual accuracy |
| Per-session model | Done | the session choice is exact and never enters global fallback |
| Routing | Done for alpha | fallback `status|set|clear`, empty by default and up to 8 routes; Fusion/MoA with 2–8 arbitrary models; unified catalogue/Neuralwatt in CLI/UI Routing |
| Multi-project | Done for alpha | registry/select/unlink, separate roots, immutable sessions, scoped/explicit-global search, single-flight per project, cross-project concurrency, CLI/UI, and two-workspace E2E |
| Upstream radar | Done for alpha | 12 baselines/filters, `list|check|show|mark`, Git metadata only, human review, no patches/downloads/auto-apply |
| Browser/desktop | Experimental | disabled by default; comprehensive controlled E2E testing remains outstanding |
| Public GitHub repository | Pending/decision | working name selected; clean history, owner authorization, remote CI, and provider matrix remain unresolved |

## Must — before asking the user for serious testing

1. **Close the current integration.** Run type checking, the complete test suite, Node/Python audits, `git diff --check`, package dry-run, and local smoke tests after the last merge.
2. **Preserve multi-project evidence.** Keep the two-workspace E2E test in the final gate: distinct working directories, one vault, blocked host escape, isolated project/global memory, and correct UI/session routing.
3. **Preserve the OMP callback warning.** OpenAI/Anthropic/GitLab require explicit confirmation; recommend `openai-codex-device` where applicable.
4. **Deliver simple Neuralwatt onboarding.** The user should only run `npm run dev -- login neuralwatt` and paste the key into the local prompt; never request the key in chat.
5. **Produce a validation matrix.** Separate `catalogued`, `real login`, `models listed`, `real turn`, and `date`. The honest initial status is “catalogued” for most providers.
6. **Do not publish yet.** Keep Git local until the Axiomux identity and clean publication branch are approved.
7. **Do not restore `shared`/`yolo`.** Configuration/tests must reject regressions; implicit global isolation and automatic approval do not belong in this architecture.

## Must — before the first public GitHub release

1. Confirm the Axiomux working identity after owner/legal review; the preliminary GitHub/npm exact-name check is not trademark clearance.
2. Create the public branch from one clean root commit with no retired character branding or local data; preserve private development branches only as local recovery references.
3. Validate at least one disposable turn with OpenAI Codex, Anthropic, Cursor, Google Antigravity, and Neuralwatt inside the isolated vault, or explicitly narrow the advertised list.
4. Run Windows and Linux CI from a clean checkout and confirm the package excludes `.superai/`, tests, research checkouts, exports, and secrets.
5. Obtain an external or independent review of OAuth callback, SSRF, child-process, local-UI, and prompt-injection boundaries.
6. Mark Browser Use and UFO experimental and document the second cloud LLM used by the browser.

## Should — next version

1. Onboarding that requires a model and tool-profile choice instead of assuming a remote model plus `code`.
2. Automated per-provider smoke-test matrix that stores no credentials in artifacts.
3. Formal SQLite migrations, tested backup/restore, and per-project retention limits.
4. Optional encryption at rest for conversations/memory, with documented key recovery.
5. Visual login/logout, memory, skills, workflows, and cost management in the local UI.
6. Optional, versioned local embeddings; retain FTS5/feature hashing as a fully offline fallback.
7. Reproducible benchmarks: recall, crash/replay, single-model versus Fusion, latency, and cost.
8. Isolate browser/desktop automation in a disposable worker or VM managed by the product.
9. OMP update policy: use the radar to signal metadata, but require a new commit/tag, official per-platform hash manifest, source audit, and contract tests before accepting each release.
10. Improve SourceHub through explicit connectors, never through generic SaaS credential import.

## Could — differentiation without blocking the core

1. A documented SDK for native providers beyond Neuralwatt.
2. Provenance/contradiction graph and read-only session replay.
3. Signed skill export/import with trust policy.
4. A reproducible Windows launcher that does not conceal Node, OMP, `uv`, or their licenses.
5. Additional persona profiles that preserve an original identity and remain separate from policy.
6. Local/open-weight models with weight licenses visible in the catalogue.

## Decisions required from the owner

- **Public name:** Axiomux is the candidate; keep `SUPERAI` only as an internal compatibility namespace and do not publish before owner approval and clean-history validation.
- **Security default:** `code` versus `write`/`read` on first run.
- **Initial model:** convenient remote default versus mandatory/local-first selection.
- **AutoLearn:** currently creates candidates only; decide whether it should remain enabled by default or become opt-in.
- **OMP web search:** useful, but sends queries externally; decide whether it belongs in the privacy-first default.
- **UFO:** keep it as a separate experimental adapter or remove it from the core.

These are not open decisions: Axiomux remains a process/RPC integration, not an OMP fork/mod; OMP extensions, `shared`, and `yolo` remain outside the product.

## Items that should probably be removed

- Any claim such as “the best of every repository” or “supports every provider” without a benchmark/matrix.
- The former OMP Neuralwatt bridge and any attempt to restore extension discovery for it.
- OMP TUI/hub/advisor/autolearn and other product layers that duplicate Axiomux UI, governance, or learning; only relevant authentication/provider/model/RPC mechanisms should cross the update boundary.
- Public artifacts or history containing third-party character branding.
- Any promise of Computer Use equivalent to Codex/ChatGPT; the current implementation is an optional UFO wrapper.
- Providers/adapters that do not strengthen local continuity, governance, and operator control.

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for risks and [REPORT.md](REPORT.md) for the consolidated assessment.
