# Provenance and research

Source review completed on 2026-07-17. Research checkouts are not part of the distribution. Executed code and effective dependencies are identified explicitly; “inspiration” means an independent implementation in this repository.

## Code and dependencies actually used

| Source | Observed license | Use in Axiomux | Incorporation method |
|---|---|---|---|
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | MIT | authentication broker, catalogue/model switching, RPC, streaming, and tools | Project-managed local executable; process/JSONL RPC interoperability. Audited contract: tag `v17.0.4`, commit `3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0` |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | MIT | optional browser automation | Optional Python dependency `browser-use==0.13.6`, frozen in `adapters/browser-use/uv.lock` |
| [microsoft/UFO](https://github.com/microsoft/UFO) | MIT | optional Windows automation | External checkout installed/reviewed by the operator; this repository contains only the original JSON wrapper |
| [obra/superpowers](https://github.com/obra/superpowers) | MIT | planning, TDD, debugging, research, and verification methods | Original/adapted Markdown skills in `skills/core/`, with attribution; not loaded as an external plugin |
| [eemeli/yaml](https://github.com/eemeli/yaml) | ISC | reading/writing YAML model configuration | Runtime dependency `yaml@2.9.0`, pinned in the lockfile |
| [whitequark/ipaddr.js](https://github.com/whitequark/ipaddr.js) | MIT | address classification for SSRF defenses | Runtime dependency `ipaddr.js@2.4.0`, pinned in the lockfile |
| [biomejs/biome](https://github.com/biomejs/biome) | MIT OR Apache-2.0 | linting and formatting | Development-only dependency `@biomejs/biome@2.5.4`, pinned in the lockfile |

## References used for independent implementation

| Source | License/terms observed during review | Idea studied | What was not incorporated |
|---|---|---|---|
| [nousresearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | MIT | progressive learning, skills, verification, and reliability | No module or prompt copied |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | `NOASSERTION` in current metadata; reuse disabled | IDENTITY/SOUL/USER separation and personality with operational limits | Ideas only; no code, persona, or branding copied without a new review and confirmed license |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | Apache-2.0 | memory lifecycle, ranking, and local-first operation | No Mem0 SDK, service, or code; the SQLite/FTS store is original |
| [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) | MIT | specialists with explicit mission, process, and evidence | No roster or prompts vendored |
| [openai/codex](https://github.com/openai/codex) | Apache-2.0 | separation between sandboxing, approval, tools, and task experience | No Computer Use code incorporated. Studied local snapshot: `315195492c80fdade38e917c18f9584efd599304` |

## Sources deliberately excluded from the runtime

| Source | Reason for study | Decision |
|---|---|---|
| [plastic-labs/honcho](https://github.com/plastic-labs/honcho) | peer/session memory and dialectic | No dependency or code. The AGPL server is unnecessary for the local product; the canonical memory system is original |
| [NateBJones-Projects/OB1](https://github.com/NateBJones-Projects/OB1) | provenance, review, multi-source ingestion, and governed write-back | Ideas only. FSL-1.1-MIT imposed a time-based restriction at the time of review |
| [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | intent gates, roles, and evidence ledger | Ideas only; SUL license and no code/prompt copied |
| [langgenius/dify](https://github.com/langgenius/dify) | typed workflows, pause, retry, and human gate | No Dify UI, server, or code; small independent engine |
| [x1xhlol/system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools) | comparison of tool contracts and verification flows | No system prompt, corpus, or code copied; the repository contains third-party text and GPL-3.0 material |
| [anthropics/claude-code](https://github.com/anthropics/claude-code) | checkpoint, hook, and verification UX | Public experience patterns only; no core, prompt, or proprietary code copied |

## Lessons from OMP login

In the audited binary, `omp auth-broker list --json` enumerated 57 flows. This demonstrates advertised authentication mechanisms, not 57 chat backends, 57 usable models, or 57 E2E tests. The Axiomux catalogue adds native Neuralwatt, producing 58 authentication/configuration entries in that snapshot.

Login is seamless because OMP maintains a single authentication boundary:

1. the authentication broker enumerates available and authenticated providers;
2. RPC exposes dedicated discovery and login operations;
3. each flow sends typed UI requests—selection, confirmation, input, and URL opening;
4. OAuth, device code, and API key converge on the provider's own storage/refresh mechanism;
5. the runtime retains the catalogue, multiple accounts, and model selection without Axiomux copying tokens.

Axiomux forwards this interaction. In strict mode, it creates a temporary credential-free model only to start discovery/login against an empty OMP database, then removes it on shutdown. RPC/model processes continue to use `--no-extensions --no-skills --no-rules` and `PI_AUTH_NO_BORROW=1`.

RPC is the normal path. If, and only if, OMP returns the exact audited pre-auth rejection for a flow that requests input before issuing a URL, the terminal starts the official `omp auth-broker login <provider>` subcommand with fixed arguments and the same isolated vault. Logout uses the same route and removes every account for the provider; multi-account selection is not exposed. OMP `17.0.2` was observed binding OpenAI/Anthropic/GitLab callbacks to `0.0.0.0`; the reviewed `17.0.4` monitored diff did not change those flows, so Axiomux retains the confirmation and device-flow recommendation. Perplexity uses an unofficial, reverse-engineered email-OTP flow and may still expose no chat models after login.

Before every spawn, the runtime requires `omp/17.0.4` and verifies the SHA-256 values published in the [official v17.0.4 release](https://github.com/can1357/oh-my-pi/releases/tag/v17.0.4) for macOS arm64/x64, Linux arm64/x64, and Windows x64. The local Windows x64 digest `326FB7DF19A8A4516F129A52D60373B547F732C17F19D4C38700F3591D85AA73` matches; Authenticode status is `NotSigned`.

| Platform | Official `v17.0.4` SHA-256 |
|---|---|
| `darwin-arm64` | `6a1cd4957ae3bb5179c315596b34d8d8b8d8638b03c18fd88c867cc38e199a18` |
| `darwin-x64` | `9b42964f99e505b53288a7b5583d9aafedd003e88b8212ceed773d5064cb374d` |
| `linux-arm64` | `d051556529090721e8a8fb66034697cd745fb4a92e1d3cbd485569ea683aab10` |
| `linux-x64` | `556ca88320ee1b65b7e2ba719e155ff3323d4f58b945565b654925eb61e71040` |
| `win32-x64` | `326fb7df19a8a4516f129a52d60373b547f732c17f19d4c38700f3591d85aa73` |

`npm run omp:install` is the recommended path: it installs the official asset in a versioned project-local directory and verifies both bytes and version. Axiomux is not an OMP mod or fork, does not alter the binary, imports no internal packages, and does not depend on extensions; incorporation is process/RPC interoperability.

### Deliberate selection during the OMP update

For the move from `17.0.2` to `17.0.4`, the selective radar compared the audited commit with release commit `3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0`. Inside the monitored authentication/provider/model/RPC surface, the only changed file was `packages/ai/src/registry/oauth/kimi.ts`: Kimi device-id persistence became best-effort, creating a missing agent directory or falling back to a per-process identifier instead of breaking request-header construction. No OMP code was copied. The new official per-platform digests were recorded, the managed Windows binary was installed, the 57-flow OMP catalogue was enumerated, Kimi remained discoverable, and `doctor --online` completed a live OpenAI Codex turn. Kimi account E2E remains unclaimed because no Kimi credential was supplied.

The review retains only mechanisms that serve Axiomux's external boundary: authentication broker/OAuth/device flow, provider/model registry, model metadata, and the required RPC/streaming protocol. Incompatible changes in these areas require an updated contract, digest, and tests.

OMP TUI/hub, advisor, prewalk, autolearn, browser, image, speech, and other product features were not adopted. Axiomux already has its own UI, persona, memory, learning, tools, and governance; duplicating those layers would increase authority and drift. The strict overlay explicitly disables applicable known surfaces, and `--no-extensions --no-skills --no-rules` preserves the separation.

## Source radar

`config/upstreams.json` records 12 sources with role, license, audited baseline, release/branch strategy, relevant paths/topics, and exclusions. The `upstream list|check|show|mark` commands query only validated GitHub release, commit, and tree metadata and persist private checks/reviews in `.superai/upstream-radar.json`.

The radar retrieves no blobs or patches, does not clone or execute anything, and changes no code, dependencies, or baselines. `pending`, `reviewed`, and `dismissed` are human-review states, not merge actions. Paths/commits outside the filters are excluded from triage. Even when `codeReuseAllowed=true`, adoption requires a fresh license/source review, explicit implementation, and tests; ideas-only sources never become eligible merely because they appear in the radar.

Neuralwatt is the project's only natively implemented authentication exception: it validates the key, protects it with DPAPI on Windows, and generates credential-free model configuration. It uses neither OMP's authentication database nor an OMP JavaScript extension.

## Memory: what is original and what is not

The canonical engine uses SQLite, FTS5, chunks with provenance, deterministic feature hashing, RRF, MMR, recency, and feedback. Feature hashing is not equivalent to learned semantic embeddings. There is no Honcho/OpenBrain service, external vector database, or hidden embedding model.

This choice keeps the core offline and redistributable under MIT, but limits conceptual retrieval between semantically related texts that use very different vocabulary. A future embedding integration should be optional, local where possible, clearly licensed, and accompanied by index migration/versioning.

## Computer Use

Codex research confirmed public sandboxing and approval concepts, but found no documented standalone interface for embedding the Codex Desktop Computer Use plugin. Axiomux does not read Codex authentication or call private endpoints.

The UFO wrapper is an open, optional alternative—not a reimplementation or a claim of equivalence to ChatGPT/Codex Computer Use. It requires separate installation, configuration, and validation.

Browser Use is also optional. When enabled, the task, page state, and potentially screenshots/vision pass through Browser Use's own cloud LLM in addition to the primary provider; this privacy distinction is part of the operational contract, not an implementation detail.

## Provenance guarantees

- No proprietary or leaked prompt is distributed.
- The public persona uses no dialogue, image, name, or identity from third-party characters.
- No FSL or SUL code, AGPL server, Dify UI/server, or Claude Code core was copied.
- There is no direct access to `.codex/auth.json` and no automatic migration of global credential databases.
- Optional dependencies retain their respective licenses and service terms.
- This repository's MIT license does not relicense OMP, Browser Use, UFO, models, or external services.

See also [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSE](LICENSE).
