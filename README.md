<p align="center">
  <img src="assets/axiomux-emblem.png" alt="Original Axiomux emblem" width="280">
</p>

# Axiomux

Axiomux is an MIT-licensed, local-first, multi-provider agent. It uses Oh My Pi (OMP) as an external process for authentication and model execution, while retaining its own identity, memory, skills, workflows, task supervision, Fusion/MoA, and interfaces. **It is not an OMP mod or fork**, imports no internal modules, and does not depend on OMP extensions.

The inherited `.superai` directory and `SUPERAI_*` environment variables remain compatibility namespaces; they are not the public product name.

“Open source” applies to the code and emblem distributed in this repository. Services and models selected by the operator—OpenAI, Anthropic, Cursor, Google, Perplexity, Neuralwatt, or others—retain their own licenses, pricing, and terms and may be proprietary. A fully open-weight deployment requires deliberately selecting a compatible local/open provider and model and confirming the weights' license.

The project is at `0.1.0-alpha`: it is a functional, tested prototype, not yet a hardened security product or a promise of unsupervised autonomy.

## OpenAI Build Week judge path

This branch adds the reversible material for Axiomux's secondary **Developer Tools** submission. General product work remains on `main`.

Judges can install the compiled tarball in a fresh directory and run `npx axiomux-demo` without rebuilding, network access, accounts, or credentials. The demo executes the shipped session, memory, routing, effect-ledger, fallback, policy, skill, and Fusion components and prints six explicit PASS checks. Its central proof hands the same local session between two exact provider routes, then shows why fallback is allowed before an effect and blocked after one. Start with [BUILD_WEEK.md](BUILD_WEEK.md), then follow [judge testing](docs/JUDGE_TESTING.md). The [demo script](docs/DEMO_SCRIPT.md) and [submission copy](docs/SUBMISSION_COPY.md) are kept beside the product evidence.

## What exists today

- login, authentication status, catalogue discovery, and model switching through OMP RPC, with fallback to the official `auth-broker` CLI subcommand only for the exact audited pre-auth rejection;
- 57 authentication flows enumerated by OMP `17.0.4`, including Anthropic/Claude, OpenAI Codex, Cursor, Google Antigravity, and Perplexity, plus native Neuralwatt; catalogue presence does not mean proven E2E operation or an available chat model;
- strict OMP isolation under `.superai/omp-runtime/`; RPC/model processes use `--no-extensions`, `--no-skills`, and `--no-rules`;
- Neuralwatt Cloud as a native Axiomux provider, with no executable OMP extension;
- concurrent streaming TUI with steering during execution, a follow-up queue, and explicit interruption;
- a central multi-project registry with canonical roots, persisted selection, isolated sessions/tasks, explicit read-only global search, single-flight per project, and cross-project concurrency; TUI and UI route every session to the correct workspace;
- governed local hybrid SQLite/FTS memory with provenance, feedback, relations, suggested contradictions, and export;
- learning that creates candidates and quarantined skills, with human review before conversion and activation;
- persistent workflows with a definition hash, pre-effect journal, idempotency keys, and explicit recovery for effects with unknown outcomes;
- opt-in Fusion/MoA: tool-less consultants run in parallel, optionally followed by synthesis, before the primary agent;
- configurable global fallback with up to 8 routes, empty by default, and Fusion/MoA with 2–8 models from any catalogue providers, including Neuralwatt;
- a selective upstream radar based only on GitHub metadata, audited baselines, and human review; it never downloads patches or applies changes;
- explicit tool profiles; OMP receives only the native `todo` and `web_search` tools, while filesystem, process, browser, and desktop access pass through host tools governed by Axiomux.

No Honcho, OB1/OpenBrain, Dify, OpenClaw, Claude Code, or prompt-repository code is incorporated into the runtime. Those projects were used only as references where licensing and public interfaces allowed. See [SOURCES.md](SOURCES.md).

## Quick start

Base requirements:

- Node.js 24 or newer;
- npm;
- Git and a checkout with complete history for `npm run validate`/secret scanning;
- the managed `omp/17.0.4` runtime, installed project-locally through `npm run omp:install`; every other version fails closed until a new contract audit;
- PowerShell 7 (`pwsh`) to persist the Neuralwatt key with DPAPI on Windows.

The OMP contract corresponds to tag/commit `v17.0.4` / `3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0`. Before **every** OMP process, Axiomux calculates the executable's SHA-256 and requires the official platform digest from the release; unaudited versions, platforms, or bytes fail closed. On this Windows x64 machine, the digest is `326FB7DF19A8A4516F129A52D60373B547F732C17F19D4C38700F3591D85AA73`, matching the official manifest, but the binary remains unsigned by Authenticode. See [SECURITY.md](SECURITY.md) and [SOURCES.md](SOURCES.md).

```powershell
cd <Axiomux checkout>
npm install
npm run omp:install
npm run validate
npm run dev -- providers
npm run dev -- login openai-codex
npm run dev -- models openai-codex
npm run dev -- model openai-codex/<available-model>
npm run dev -- doctor
```

`npm run omp:install` downloads the official platform asset to `.superai/bin/`, constrains size/hosts/redirects, and verifies SHA-256 and version before an atomic rename. If the correct artifact already exists, it is simply reverified; unexpected bytes are not replaced automatically and require manual inspection/removal.

Strict mode uses its own isolated OMP credential database. A login performed directly in the global OMP installation is neither copied nor reused automatically; authenticate once inside Axiomux:

```powershell
npm run dev -- providers
npm run dev -- login openai-codex
npm run dev -- login anthropic
npm run dev -- login cursor
npm run dev -- login google-antigravity
npm run dev -- login perplexity
```

The effective IDs belong to the installed OMP version. Use `providers` to confirm available flows instead of assuming a fixed list. Most logins use RPC; Perplexity and other flows that request input before issuing a URL automatically switch to `omp auth-broker login <provider>` in the same isolated vault. That route is terminal-only, and upstream readline may display the entered value.

OMP `17.0.2` was observed binding some OAuth callbacks for OpenAI, Anthropic, and GitLab temporarily to `0.0.0.0`; the reviewed `17.0.4` monitored diff did not change those flows. Axiomux therefore continues to display a warning and require confirmation. Proceed only on a trusted network with no port forwarding; prefer device flow for OpenAI:

```powershell
npm run dev -- login openai-codex-device
```

Add `--no-open` to any login command to print the authorization URL without launching the operating system's default browser. This is useful when the URL must be opened in a separate, controlled browser session:

```powershell
npm run dev -- login openai-codex-device --no-open
```

Start the TUI:

```powershell
npm run dev
```

The default `code` profile includes reading, editing, and limited direct execution of approved programs, but not browser or desktop access. The profile capability labels `bash` and `python` remain for configuration compatibility, while the model-facing host tools are `run_program` and `run_python`. `run_program` accepts an executable plus arguments, never opens a shell, and rejects shell interpreters; `run_python` uses isolated mode. Filesystem tools are likewise exposed as `workspace_read`, `workspace_write`, and related collision-free names so OMP's built-ins cannot shadow the governed implementations. These processes still run as the current Windows account and are not a sandbox. Inspect or deliberately reduce/increase the surface:

```powershell
npm run dev -- tools
npm run dev -- tools read
npm run dev -- tools write
npm run dev -- tools code
npm run dev -- tools automation  # exposes browser/desktop adapters only when they are also configured and enabled
```

For a single turn:

```powershell
npm run dev -- chat "Reply with AXIOMUX_OK only"
```

Open the local UI:

```powershell
npm run dev -- ui
# or without opening a browser automatically
npm run dev -- ui --no-open
```

The startup URL contains a one-time token exchanged for an `HttpOnly; SameSite=Strict` cookie. Do not publish the port through a proxy, tunnel, or port forwarding.

The web UI defaults to English and offers an **EN/PT** language selector. The selected locale controls both the interface and the natural-language prose requested from the principal model, Fusion/MoA consultants, and the optional synthesizer on subsequent turns. Model-side instructions preserve code, commands, paths, logs, errors, quotations, source excerpts, data values, and requested exact tokens verbatim; an explicit user request for another language wins for that turn. Existing conversation history is never rewritten. The **Routing** button configures fallback and Fusion/MoA visually. Provider/model, participants, synthesizer, and Neuralwatt use the same unified catalogue; Neuralwatt appears as a native provider, not a plugin, bridge, or extension. CLI, TUI, API messages, documentation, source comments, test names, and examples remain English; narrowly scoped non-English safety/steering fixtures are permitted only when explicitly documented as input-compatibility tests.

## Providers and models

```powershell
npm run dev -- providers
npm run dev -- provider claude
npm run dev -- models anthropic
npm run dev -- model anthropic/<available-model>
```

Convenience aliases include `claude`, `antigravity`, `codex`, `chatgpt`, `nw`, and `neuralwatt-cloud`. Persisted selection always uses `provider/model`.

A successful login does not necessarily imply a chat model. For example, the `perplexity` flow may authenticate OMP's search tool while exposing zero selectable models.

A choice made inside a session is an exact routing/privacy decision: it uses neither the global fallback list nor Fusion. Manage global fallback with:

```powershell
npm run dev -- fallback status
npm run dev -- fallback set anthropic/<model> neuralwatt/<model>
npm run dev -- fallback clear
```

The list begins empty, accepts up to 8 distinct catalogue-validated models, and is tried only while repetition remains safe—never after a consequential effect. To remove authentication, `logout <provider>` deletes **all** OMP credentials stored for that provider after confirmation; the current version does not expose multi-account selection.

### Neuralwatt

```powershell
npm run dev -- login neuralwatt
npm run dev -- models neuralwatt
npm run dev -- model neuralwatt/<available-model>
```

Axiomux validates the key through `GET /v1/quota`, reads the bounded catalogue from `GET /v1/models`, and generates `.superai/omp-runtime/agent/models.yml`. That file contains metadata and the name `NEURALWATT_API_KEY`, not the key. If the catalogue exists but the credential is absent or unreadable, the runtime refuses to start rather than treating the placeholder as a key.

On Windows, the persisted key is protected by DPAPI in `CurrentUser` scope and stored under a private ACL. There is no plaintext fallback. In version `0.1.0`, the complete Neuralwatt login/configuration flow is Windows-only. On other systems, the runtime can read `NEURALWATT_API_KEY` from the environment, but requires separately provisioned `models.yml`; the CLI cannot yet create that configuration without a supported persistent secret mechanism.

The old note about `--no-extensions` blocking the Neuralwatt bridge no longer applies: the executable bridge was removed. Neuralwatt is a native Axiomux adapter and appears in the same catalogue/selectors as other providers; there is no need to enable discovery or trust installed OMP extensions.

## Persona and self-evaluation

The original persona has intensity `0–3` and is reread between turns:

```powershell
npm run dev -- persona
npm run dev -- persona 0  # neutral
npm run dev -- persona 3  # maximum expression
```

This changes voice and humor, not policy, evidence, or permissions. Self-evaluation is enabled by default and stores only limited operational metadata—outcome, counts, and observed failures—as `pending` memory with a TTL. It stores neither prompt, response, nor chain-of-thought and does not assess factual accuracy.

## Working while the agent runs

In the TUI, ordinary text sent during a task is treated as steering. Explicit controls are:

```text
/status                 show current status
/stop                   interrupt the active task
/next <request>         create a follow-up task in the same session
/new                    create a session once the queue is free
/exit                   exit and interrupt active work
```

The public trace shows states, tools, and reasoning volume, never raw chain-of-thought.

## Multiple projects

The central registry separates the Axiomux installation from workspaces the agent may operate on:

```powershell
npm run dev -- projects list
npm run dev -- projects add C:\path\to\project --name MyProject
npm run dev -- projects use MyProject
npm run dev -- projects remove MyProject
```

In the TUI, use `/project`, `/projects`, and `/search`; cross-project search occurs only through an explicit global action and is read-only. Sessions and tasks remain bound to one project. Each project accepts one active task, while different projects may run concurrently. Configuration, persona, skills, audit data, and the OMP vault are central; OMP/Fusion, tools, SourceHub, and project memory receive the selected root. `remove` only unlinks the workspace from the registry and does not delete history.

## Fusion and MoA

Fusion is disabled by default because it increases cost, latency, and request exposure across providers.

```powershell
npm run dev -- fusion status
npm run dev -- fusion enable moa <model-a> <model-b> [model-c...]
npm run dev -- fusion enable fusion <model-a> <model-b> [model-c...] --synthesis <model|auto> --max-parallel 4
npm run dev -- fusion participants <model-a> <model-b> [model-c...]
npm run dev -- fusion synthesis <model|auto>
npm run dev -- fusion parallel <1-8>
npm run dev -- fusion run "Compare these approaches"
npm run dev -- fusion disable
```

The unified catalogue accepts 2–8 arbitrary participants, mixing providers and Neuralwatt. In `moa`, the panel is delivered to the primary agent as untrusted context. In `fusion`, a tool-less model first synthesizes the panel. Only the primary agent receives tools and may produce effects. Partial failures and consultant timeouts do not discard valid results. The same options appear in the UI's **Routing** dialog.

## Upstream radar

The radar helps discover relevant mechanisms without turning external updates into trusted code:

```powershell
npm run dev -- upstream list
npm run dev -- upstream check oh-my-pi
npm run dev -- upstream check --all
npm run dev -- upstream show oh-my-pi
npm run dev -- upstream mark oh-my-pi reviewed "mechanisms reviewed; no automatic adoption"
```

`config/upstreams.json` pins the repository, license, audited baseline, included paths/topics, and exclusions. `check` queries only GitHub release/commit/tree metadata, compares hashes/monitored paths, and stores the private result in `.superai/upstream-radar.json`. It downloads no files, patches, or repositories, changes no baselines, and never merges or auto-applies anything. `mark pending|reviewed|dismissed` records the human decision; everything outside the relevant filters is ignored.

## Memory and learning

Retrieval combines FTS5, a deterministic feature-hashing vector, Reciprocal Rank Fusion, MMR, recency, confidence, importance, and feedback. The vector helps find offline lexical/morphological similarity; it is not a learned semantic embedding and must not be described as one.

```powershell
npm run dev -- memory add --kind preference --importance 0.9 "decision to review"
npm run dev -- memory approve 1
npm run dev -- memory recall "decision"
npm run dev -- memory feedback 1 up "it was useful"
npm run dev -- memory contradictions 1
npm run dev -- memory relate 1 contradicts 2 "reviewed by the operator"
npm run dev -- memory relations
npm run dev -- memory sources
npm run dev -- memory export memory-export.json
```

Imported content, automatic recollections, and instructions not yet approved remain untrusted evidence. The automatic learning loop has two reviews: a candidate must be approved before conversion, and the converted skill remains quarantined until separate approval. The explicit manual `/learn` command creates a quarantined proposal directly and retains final skill approval.

The memory database remains local, but the prompt composer sends the chosen provider relevant retrieved memories and up to 14 recent messages with the request. “Local” describes storage and ranking; it does not mean context never leaves the machine when using a remote model. Fusion sends the current request to every configured consultant but does not send retrieved memory to them.

```powershell
npm run dev -- skills candidates
npm run dev -- skills candidate-approve <id> "evidence reviewed"
npm run dev -- skills convert <id> <skill-id> "description"
npm run dev -- skills approve <skill-id>
npm run dev -- skills evaluate <skill-id> pass "reproducible test"
npm run dev -- skills versions <skill-id>
npm run dev -- skills rollback <skill-id> <hash>
```

## Browser and Computer Use

Strict mode structurally rejects OMP's native browser, as well as its native filesystem, shell, Python, LSP, and image tools. The `automation` profile merely makes the `browser_task` and `computer_use` host tools eligible; each is registered only when its corresponding adapter is also configured and enabled.

The Browser Use adapter is optional and disabled by default. It requires `uv`, Chrome/Chromium, the environment frozen in `adapters/browser-use/uv.lock`, a supported key, and at least one explicit domain in `adapters.browserUse.allowedDomains`. It runs headless and extension-free with a temporary profile/download directory, IP-address blocking, and a step limit. The task, page state, and—depending on mode—screenshots/vision are sent to Browser Use's own cloud LLM in addition to the primary provider. This integration was tested at the import/contract level; use only a VM and test accounts until controlled E2E validation exists.

The Microsoft UFO adapter is also optional. It requires an external checkout reviewed and configured by the operator. It is not the Codex or ChatGPT Computer Use implementation and was not validated E2E in this repository without that installation. Use it only in a VM or disposable Windows account.

## Workflows and recovery

```powershell
npm run dev -- workflow run examples\research-workflow.json
npm run dev -- workflow status examples\research-workflow.json
npm run dev -- workflow recover examples\research-workflow.json <step-id> retry
npm run dev -- workflow recover examples\research-workflow.json <step-id> complete '"verified result"'
npm run dev -- workflow recover examples\research-workflow.json <step-id> fail "effect reviewed and considered failed"
```

`recover` accepts only the current step with a `started` journal entry and requires an explicit decision. It records the decision without proceeding silently; review state and run `workflow run` again when appropriate.

## Security summary

- OMP starts with isolated HOME/USERPROFILE and agent directories; it does not read the global credential database in strict mode.
- Every OMP RPC/model process uses `--no-extensions --no-skills --no-rules`; arguments that try to load extensions/plugins are rejected. The `auth-broker` CLI fallback is a separate vault subcommand, not a coding-agent session.
- `shared` mode was removed because it would make global OMP configuration, credentials, and discovered code implicit agent dependencies. `yolo` mode was removed because automatic approval would nullify human gates and effect-ledger semantics. Neither is reintroduced as a hidden option.
- OMP receives only `todo` and `web_search` as native tools. Files, commands, and external adapters pass through validation, limits, approval for effects, and durable Axiomux journaling.
- Child processes receive a minimal environment and explicitly permitted names.
- Cross-provider fallback is empty by default and becomes unavailable after a consequential effect.
- `.superai/` contains conversations, memory, and audit data as local plaintext under a private ACL/mode; it is not an encrypted database. OMP-managed tokens remain in OMP's isolated SQLite database, also under a private ACL but without additional Axiomux encryption. Only the Neuralwatt key uses DPAPI.
- HTTP ingestion validates destinations and redirects, pins the validated public IP, and limits content type/size; file ingestion blocks escapes and sensitive paths.
- Browser and desktop automation remain high-risk execution. Approval and allowlists reduce risk but do not replace operating-system-level sandboxing.

Read [SECURITY.md](SECURITY.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md) before enabling external adapters.

## Quality and status

```powershell
npm run check
npm test
npm run security
npm run validate
npm run doctor:online
npm run e2e:host
```

`doctor:online` and `e2e:host` make real calls and depend on authentication. Normal tests use fixtures and do not, by themselves, demonstrate that every account, model, or external adapter is operational.

## Development provenance

Codex assisted with repository analysis, architecture, implementation, security hardening, regression tests, bilingual UI work, and release preparation. The human owner made the product and authority decisions, including strict isolation, explicit approval, effect-aware fallback, tool-less Fusion consultants, native Neuralwatt, and governed local memory.

For Build Week, Codex also helped create the deterministic judge path and evidence package. The configured OpenAI route targets `openai-codex/gpt-5.6-sol`; current live-evidence status and credential-free reproduction notes are recorded in [BUILD_WEEK.md](BUILD_WEEK.md).

For an objective assessment—strengths, defects, priorities, and open decisions—see [docs/PRODUCT_ASSESSMENT.md](docs/PRODUCT_ASSESSMENT.md).

See also the [consolidated report](REPORT.md), [ordered roadmap](PLAN.md), and [known issues](KNOWN_ISSUES.md). This public repository begins from a clean root commit because private development branches retain retired identity work and local implementation history. Axiomux is a preliminary publication name selected after a basic web, GitHub-name, and npm-name collision check; that check is not legal trademark clearance.

## License and identity

Original code in this repository is distributed under [MIT](LICENSE). External dependencies and services retain their own licenses and terms.

The public identity is Axiomux: incisive, direct, and dryly humorous, without imitating third-party characters. The previous local agent audit is in [docs/LOCAL_AGENT_AUDIT.md](docs/LOCAL_AGENT_AUDIT.md).

The emblem in `assets/axiomux-emblem.png` was created from scratch for this project and does not reuse provider logos.
