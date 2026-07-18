# Consolidated report — Axiomux 0.1.0-alpha

The implementation was developed under the internal name `SUPERAI`. The `.superai` state directory, `SUPERAI_*` environment variables, and some source identifiers remain compatibility namespaces; Axiomux is the public product identity.

## Verdict

This is an interesting product to test and, after closing the publication blockers, to publish on GitHub. The proposition is already coherent: **a local-first agent that uses OMP for authentication/models and adds continuity, memory, governed skills, durable tasks, steering, and effect control**.

It is not yet a production product. Its greatest strengths are architecture and local control; its main weaknesses are risk inherited from OMP callbacks, the absence of an operating-system sandbox, plaintext state, and a lack of real E2E validation for advertised accounts.

## What was created

| Area | Current result |
|---|---|
| Providers | 57 observed OMP authentication flows plus native Neuralwatt |
| Login | normal RPC; official `auth-broker` CLI fallback only for the exact audited pre-auth rejection |
| Managed OMP | project-local release `17.0.4`, version/digest verified; process/RPC integration, not a fork/mod |
| OMP isolation | dedicated HOME/APPDATA/agent/vault; RPC processes without extensions, skills, or rules; global credentials not copied |
| Routing | exact session/request routing; fallback empty by default with up to 8 routes; Fusion/MoA with 2–8 models and UI Routing |
| Neuralwatt | quota/model validation, secret-free catalogue, Windows DPAPI, and unified native-provider UX |
| Agent | local TUI/UI, streaming, steering, stop, queue, persistent tasks, and persistent effects |
| Personality | original Axiomux persona with dynamic intensity `0–3`, separate from policy and approvals |
| Memory | SQLite/FTS5, offline feature hashing, RRF/MMR, provenance, scopes, feedback, relations, and review |
| Learning | candidates, quarantine, approvals, versions, evaluations, and rollback |
| Self-evaluation | metadata-only operational summary, `pending`, with TTL; no prompt/response/chain-of-thought |
| Workflows | definition hash, lock, pre-effect journal, idempotency, and explicit recovery |
| Fusion/MoA | tool-less consultants, opt-in, failure tolerance, and optional synthesis |
| Tools | host-governed filesystem/processes; native OMP limited to `todo` and `web_search` |
| Browser/desktop | optional Browser Use and UFO, disabled by default and still experimental |
| Sources | files and public HTTP with provenance and limits; smaller surface than OB1 |
| Multi-project | validated central registry: scoped roots, sessions, tasks, memory, and UI; explicit global search |
| Upstream radar | 12 baselines/filters, GitHub metadata, review states; no patches/downloads/auto-apply |
| Language surface | public code/docs/CLI/TUI/API remain English; the English-default web UI offers EN/PT and propagates the selected language to principal and Fusion/MoA model prose without rewriting exact code/log/source content or prior history |

## The old OMP extension concern

The old explanation said that `--no-extensions` also blocked the Neuralwatt bridge and that loading it would require trusting every discovered OMP extension. That was true for the former design, but **no longer describes the current product**.

The JavaScript bridge was removed. Neuralwatt is now implemented natively in Axiomux. OMP RPC processes continue to use `--no-extensions --no-skills --no-rules`; the `omp auth-broker` fallback is a separate vault subcommand, not an extension-enabled coding-agent session.

On Windows, the operator needs only:

```powershell
npm run dev -- login neuralwatt
```

The browser opens the portal; paste the key **into the no-echo local prompt**, never into chat. Axiomux validates it, stores it using DPAPI `CurrentUser`, and writes a credential-free `models.yml`.

Neuralwatt is not a visual exception: it uses the same catalogue, provider/model selectors, fallback, Fusion/MoA, and Routing dialog as every other provider. Only the adapter/secret implementation is native.

## Relationship with OMP

Axiomux is neither an OMP mod/fork nor extension-dependent. OMP is an external executable managed under `.superai/bin/`, invoked through RPC/official subcommands; identity, UI, tools, memory, skills, workflows, tasks, projects, and governance remain in Axiomux.

The selective update to `17.0.4` retained only surfaces useful to the substrate—authentication broker/OAuth/device flow, registry/model metadata, RPC, and relevant streaming. The only monitored source change from `17.0.2` was Kimi device-id persistence becoming best-effort; OMP TUI/hub, advisor, prewalk, autolearn, browser/image/speech, and other product layers were ignored/disabled because they would duplicate responsibilities and authority.

`shared` was removed because it would mix global OMP HOME/configuration/credentials/discovered code with the audited runtime. `yolo` was removed because automatic approval would erase the human decision and invalidate the effect ledger and safe fallback. Configuration rejects both; neither is a hidden option.

## Why login is strong—and where the guarantee ends

OMP concentrates catalogue discovery, OAuth/device/API-key UI, refresh, and storage. Axiomux does not replicate that logic. In the observed installation, `omp auth-broker list --json` returned 57 entries; Neuralwatt raises the unified catalogue to 58.

This is a count of **authentication/configuration flows**, not guaranteed chat backends. A login may:

- be unavailable for an account or region;
- authenticate a tool without exposing models;
- fail because of quota, terms, or an upstream change;
- require a provider/model different from the login ID.

Perplexity is the clearest example: OMP uses an unofficial, reverse-engineered email-OTP flow. The managed `17.0.2` binary was black-box validated to reject the pre-auth prompt over RPC, activating the official CLI route; the reviewed `17.0.4` monitored diff did not touch that path, but it was not repeated with a real Perplexity account. Even after authentication, Perplexity may still expose zero models and serve only search.

### Important OAuth limitation

OMP `17.0.2` was observed binding callback servers for OpenAI, Anthropic, and GitLab to `0.0.0.0` despite advertising `localhost`; the reviewed `17.0.4` monitored diff did not touch those paths. Axiomux keeps warning and requiring confirmation; that reduces human error but does not repair the upstream bind. Use a trusted network with no port forwarding and prefer:

```powershell
npm run dev -- login openai-codex-device
```

when device flow satisfies the use case.

## Real strengths

1. **Clear separation of responsibilities.** OMP handles authentication/models; Axiomux handles continuity, memory, effects, and UX.
2. **Fail-closed critical boundaries.** OMP version, paths, executable configuration, secrets, and ambiguous effects are rejected rather than guessed.
3. **Governed, explainable, offline storage/ranking.** Memory requires neither Honcho/OpenBrain nor a mandatory cloud service.
4. **Cautious learning.** The agent cannot turn a conclusion into an active skill without quarantine/review.
5. **Useful steering and persistence.** The operator can redirect, stop, and resume without losing the task's public history.
6. **Effect-aware fallback.** It does not silently repeat actions after a consequential mutation.
7. **Clean core licensing.** Original code/art is MIT; effective dependencies are permissive and provenance is explicit.
8. **Personality without third-party IP dependence.** Style is configurable but cannot alter authority or security.
9. **A real multi-project boundary.** Two workspaces demonstrated distinct current directories, one vault, scoped memory, escape blocking, UI routing, and per-project concurrency.
10. **Explicit OMP supply chain.** A project-local installer, official manifest, and verification at every spawn prevent silent dependence on a different PATH binary.
11. **Understandable routing.** Fallback exposes `status|set|clear`; Fusion/MoA exposes participants/synthesis/concurrency/mode; both are limited to 8 and share one UI, while session choices remain exact.
12. **Radar without auto-update.** External changes become filtered metadata and human review, not executable patches.

## Current defects

1. **No OS sandbox.** Approved code remains powerful.
2. **Plaintext state.** An ACL is not encryption at rest.
3. **Incomplete provider E2E.** OpenAI Codex is confirmed in the isolated vault with 19 models, a real GPT-5.6 turn, online doctor probe, and governed host-tool call. The remaining catalogued flows are not proven accounts/models.
4. **Upstream callback exposed to the LAN.** Mitigated by warning/network/device flow, not fixed.
5. **Double cloud exposure in the browser.** Task/page state and potentially screenshots go to Browser Use's LLM.
6. **Incomplete multi-account UX.** OMP can store multiple accounts, but Axiomux does not expose per-account selection/management; logout removes all accounts for a provider.
7. **Narrow SourceHub.** Safe and auditable, but far from OB1/Dify connector breadth.
8. **Experimental SQLite in Node 24.** Appropriate for alpha, not for a 1.0 stability claim.
9. **Private development history.** Older local branches retain retired third-party character branding and must not be published; the release branch must start from a clean root commit.
10. **Public-identity due diligence.** The conflicting `SUPERAI`/`SUPER.AI` public name was replaced by the Axiomux candidate after preliminary exact-name web, GitHub, and npm checks. That is not legal trademark clearance or a reservation of the name.
11. **Fan-out increases exposure.** Up to 8 fallback/Fusion participants may multiply cost, data transfer, and variability; they remain opt-in/empty by default.
12. **Heuristic radar.** Paths/topics and the public GitHub API may miss context or hit rate limits; `reviewed` does not mean code was adopted or audited.

## Evidence confirmed on this machine

| Check | Observed result |
|---|---|
| `npm run omp:install` | managed runtime installed and verified at `.superai/bin/v17.0.4-omp-windows-x64.exe` |
| managed `omp --version` | `omp/17.0.4` |
| OMP tag/commit | `3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0` |
| local `omp.exe` SHA-256 | `326FB7DF19A8A4516F129A52D60373B547F732C17F19D4C38700F3591D85AA73`; matches the official `win32-x64` digest |
| local `omp.exe` signature | `NotSigned` |
| OMP authentication catalogue | 57 entries |
| Axiomux catalogue | 58 authentication/configuration flows; 1 isolated credential; OpenAI Codex exposes 19 models |
| GPT-5.6 live turn | exact-model route succeeded before the public rename; the Axiomux-branded exact-token refresh is pending |
| governed host-tool E2E | GPT-5.6 called `memory_remember` once, returned `HOST_TOOL_OK`, and the temporary memory/session were removed |
| `doctor --online` | underlying live gate passed before the public rename; the Axiomux-branded refresh is pending |
| Perplexity RPC 17.0.2 regression evidence | exact pre-auth rejection confirmed black-box; the `17.0.4` monitored diff did not touch this path, but a real-account E2E was not repeated |
| `fallback status` | disabled; empty by default; exact routes without fallback/Fusion |
| `fusion status` | OFF; 0/8 participants; `maxParallel=3` |
| `upstream list` | 12 sources; OMP `v17.0.4` selectively reviewed and pinned; remaining baselines listed without application |
| TypeScript | `npm run check` passed on the final audited snapshot |
| complete suite | 187 tests: 185 passed, 2 expected skips, 0 failures |
| Node security | 0 vulnerabilities; secret scan passed across 150 text files and Git patch history |
| Python Browser Use | `npm run security:browser`: no known vulnerabilities |

The runtime contains the official `v17.0.4` release digests for macOS arm64/x64, Linux arm64/x64, and Windows x64 and verifies the executable before every spawn. A mismatched version, a platform without an audited digest, or binary replacement fails closed. The Windows executable remains `NotSigned`: the official hash reduces silent replacement risk but does not replace trust in the release/distribution channel. These results do not replace real-account testing across the remaining provider catalogue.

## License and dependencies

Original code and the emblem are MIT licensed. The Node runtime includes `yaml 2.9.0` (ISC) and `ipaddr.js 2.4.0` (MIT). Development tooling includes `@biomejs/biome 2.5.4` (`MIT OR Apache-2.0`). Browser Use is optional and retains its MIT license; the Python lockfile uses explicit overrides for `aiohttp`, `click`, `mcp`, `pillow`, and `pypdf`, whose audit passed.

OpenAI, Anthropic, Google, Cursor, Perplexity, Neuralwatt, and local/remote models retain their own terms and licenses. “Open-source code” does not make subscriptions or proprietary weights open source.

## What should remain

- OMP as an external authentication/runtime substrate, without a fork.
- Managed/verified OMP runtime and metadata-only upstream radar.
- Original, governed local memory.
- Quarantined skills and fail-closed workflows.
- Fusion disabled by default.
- Adjustable original persona.
- Browser/desktop as optional adapters.
- Empty fallback and disabled Fusion by default; shared UI Routing when the operator opts in.

## What should be reconsidered

- the `code` profile and a remote model as defaults;
- `autoLearn: true`, even though it only creates candidates;
- OMP `web_search` in the privacy-first profile;
- UFO in the core rather than an experimental package;
- final owner/legal approval of the Axiomux identity for publication.

## What should be removed

- claims of superiority by association with many repositories;
- promises of E2E support for every catalogued login;
- any retired third-party character branding in the public repository/history;
- the former Neuralwatt extension;
- claims of equivalence to Codex Computer Use;
- `shared`/`yolo` modes and OMP layers that duplicate Axiomux TUI/hub/advisor/autolearn.

## Publication recommendation

**Local Git: yes. Public GitHub now: not yet.** First:

1. rerun the complete suite after consolidating every patch;
2. test real accounts in the isolated vault or narrow the claims;
3. confirm the Axiomux candidate identity and package/repository availability;
4. create clean Git history;
5. run remote CI from a clean checkout;
6. retain the `alpha` label and publish [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

The ordered roadmap is in [PLAN.md](PLAN.md). The technical conclusion is simple: the project already has a differentiated core; it now needs to prove operationally what the architecture promises.
