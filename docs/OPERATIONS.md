# Axiomux operations

`SUPERAI` remains the internal compatibility namespace for environment variables, private state, and selected source identifiers.

## Installation and diagnostics

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

`validate` runs type checking, Biome lint and format checks, a clean build, tests, `npm audit --audit-level=low`, and worktree/Git-history secret scanning. `validate:full` adds the frozen Browser Use Python adapter audit.

`omp:install` installs/verifies the managed release under `.superai/bin/`. It accepts only release HTTPS hosts, limits transfer to 512 MiB, validates SHA-256 before rename, and confirms version/digest at the destination. If the file already exists with unexpected bytes, it is neither deleted nor replaced: inspect it, remove it manually if appropriate, then repeat the command.

`doctor` requires exactly the tested OMP contract (`omp/17.0.4`, commit `3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0`), starts an isolated RPC process, and verifies catalogue/login/configured model, but sends no prompt to the model. Before every spawn, the runtime also requires the official release SHA-256 for the platform; a mismatch or unaudited platform fails closed. Run it before login only for diagnosis: model/credential failures are expected in that state. The catalogue is discovered at runtime: absence of an expected flow (`openai-codex`, `anthropic`, `cursor`, `google-antigravity`, `perplexity`, or native `neuralwatt`) appears in diagnostic details without turning an optional OMP capability into an artificial blocker. An empty catalogue, missing configured model, or missing required credential still fails.

Axiomux neither modifies nor forks OMP and loads no extensions. From the upstream surface, it uses only required authentication/provider/model/RPC mechanisms; OMP TUI/hub/advisor/prewalk/autolearn/browser/image/speech remain excluded/disabled because the application has its own UI, governance, and tools.

```powershell
npm run doctor:online
```

`doctor:online` adds a real call and requires the exact response `AXIOMUX_DOCTOR_OK`. It consumes quota and requires login in the isolated OMP database.

```powershell
npm run e2e:host
```

`e2e:host` asks the model to make one real `memory_remember` call, confirms the proposal remains pending evidence, and removes the test memory/session. It grants no approval for workspace writes, processes, browser, desktop, or external actions.

## State and configuration

Local state lives under `.superai/`:

| Path | Contents |
|---|---|
| `.superai/config.json` | secret-free overrides |
| `.superai/state.db` | conversations, memory, sources, runtime, tasks, and effects |
| `.superai/workflows/` | workflow state/journals |
| `.superai/audit.jsonl` | sanitized audit data |
| `.superai/omp-runtime/` | isolated HOME, agent directory, credential database, and OMP sessions |
| `.superai/bin/` | managed, versioned, verified OMP executable |
| `.superai/secrets/` | DPAPI envelopes, currently Neuralwatt |
| `.superai/skills/` | active private skills and quarantined proposals |
| `.superai/user.md` | explicit private preferences approved by the operator |

Base variables:

```powershell
$env:SUPERAI_MODEL='provider/model'
$env:SUPERAI_FALLBACK_MODELS='provider/model-a,provider/model-b'
$env:SUPERAI_OMP='C:\path\to\omp.exe'
$env:SUPERAI_OMP_ENV_ALLOWLIST='NAME_REQUIRED_BY_PROVIDER'
```

Do not put secret values in `.superai/config.json`. `SUPERAI_OMP_ENV_ALLOWLIST` exposes listed names to the OMP process; review every variable before allowing it.

There is no shared override: `SUPERAI_OMP_ISOLATION` accepts only `strict`. `shared` was removed because it would import global OMP HOME/configuration/credentials/discovered code as implicit dependencies. Configurations with `rejectUntrustedExtensions=false` are also rejected. The only supported `approvalMode` is `always-ask`; `yolo` was removed because automatic approval would nullify the human decision and effect-ledger/replay safety. No hidden aliases reactivate these modes. At the OMP boundary, only `todo` and `web_search` are native. Local reads pass through Axiomux host tools; write/edit/process/adapter operations request approval and record the effect before acting.

Capability profiles:

```powershell
npm run dev -- tools
npm run dev -- tools read
npm run dev -- tools write
npm run dev -- tools code
npm run dev -- tools automation
```

`code` is the default and does not register browser/desktop tools. `automation` only makes them eligible: `adapters.browserUse.enabled` or `adapters.computerUse.enabled` must also be active. The `bash` host tool accepts an executable plus arguments with `shell: false` and rejects shells; approved programs still run as the user's account, without a VM or operating-system sandbox.

## Login and model selection

First inspect the installed runtime's actual surface:

```powershell
npm run dev -- providers
npm run dev -- providers claude
npm run dev -- provider claude
npm run dev -- models anthropic
```

Login examples:

```powershell
npm run dev -- login openai-codex
npm run dev -- login anthropic
npm run dev -- login cursor
npm run dev -- login google-antigravity
npm run dev -- login perplexity
```

Axiomux forwards `select`, `confirm`, `input`, `editor`, and `open_url` emitted by the authentication broker. It prints the URL even if the browser does not open; callbacks may be pasted manually. Recognized password/token/API-key fields use a no-echo interactive terminal prompt.

RPC is the normal route. If OMP returns the exact audited pre-auth rejection, the CLI automatically switches to the official `omp auth-broker login <provider>` subcommand with fixed arguments, `PI_AUTH_NO_BORROW=1`, and the same isolated vault. This path needs a foreground terminal and works neither in the web UI nor with redirected stdin. Upstream readline may display inputs such as a Perplexity OTP.

OMP `17.0.2` was observed opening callbacks for OpenAI Codex, Anthropic, and GitLab on `0.0.0.0`; the reviewed `17.0.4` monitored diff did not change those flows. Axiomux keeps explaining the risk and requesting confirmation but does not repair the bind. Use a trusted network with no port forwarding; for OpenAI, prefer:

```powershell
npm run dev -- login openai-codex-device
```

Use `--no-open` to print an authentication URL without launching the operating system's default browser:

```powershell
npm run dev -- login openai-codex-device --no-open
```

The isolated credential database cannot see global OMP login state. Reauthenticate in Axiomux once per required provider/account. OMP tokens remain in SQLite under a private ACL; unlike the Neuralwatt credential, they receive no additional DPAPI encryption from Axiomux.

Switch models:

```powershell
npm run dev -- model openai-codex/<available-model>
npm run dev -- model anthropic/<available-model>
```

Do not assume a login name is a model provider. `perplexity`, for example, may authenticate web search only and expose zero chat selectors.

Global fallback:

```powershell
npm run dev -- fallback status
npm run dev -- fallback set anthropic/<model> neuralwatt/<model> [others...]
npm run dev -- fallback clear
```

The list begins empty, accepts 1–8 distinct catalogue-validated routes, and applies only to the global model before any consequential effect. An explicit per-session/request model uses neither fallback nor Fusion.

Perplexity uses an unofficial, reverse-engineered email-OTP flow. Treat it as experimental and always check `models perplexity` after login.

Remove authentication:

```powershell
npm run dev -- logout anthropic
```

OMP logout requests confirmation and removes every credential for that provider. The current version cannot select one of several accounts. `logout neuralwatt` removes the local DPAPI envelope.

### Neuralwatt

The persistent Windows flow requires PowerShell 7 (`pwsh`) to invoke DPAPI in `CurrentUser` scope.

```powershell
npm run dev -- login neuralwatt
npm run dev -- provider neuralwatt
npm run dev -- models neuralwatt
npm run dev -- model neuralwatt/<available-model>
```

Login:

1. receives the key without echo;
2. validates `https://api.neuralwatt.com/v1/quota`;
3. retrieves and validates `/v1/models`;
4. protects the key with DPAPI `CurrentUser` on Windows;
5. generates credential-free `.superai/omp-runtime/agent/models.yml`.

There is no OMP Neuralwatt extension. OMP continues to start with `--no-extensions --no-skills --no-rules`.

In CLI and UI, Neuralwatt appears in the same catalogue, provider selector, model selector, fallback, and Fusion/MoA as every other provider. “Native” describes the adapter/secret implementation, not a separate UX.

DPAPI storage does not exist on Linux/macOS. The runtime can receive an ephemeral key:

```bash
NEURALWATT_API_KEY='...' npm run dev -- chat "test"
```

Persistence outside Windows fails closed. This variable makes the provider usable only if `.superai/omp-runtime/agent/models.yml` was provisioned separately; CLI `0.1.0` does not yet generate that catalogue without completing DPAPI persistence. Treat Neuralwatt setup as Windows-only in this version.

## TUI and steering

```powershell
npm run dev
# equivalent
npm run dev -- tui
```

While a task is active:

- ordinary text is steering;
- `/status` inspects state;
- `/next <request>` schedules the next task;
- `/stop` or `/cancel` interrupts;
- other slash commands remain available without being mistaken for steering.

The TUI displays only a public trace. Reasoning is summarized by state/volume; chain-of-thought is neither stored nor displayed.

`/persona 0|1|2|3` dynamically changes voice intensity for later turns; it does not alter policy, permissions, or tools. A model selected inside a session is exact: it does not inherit global fallback and fails visibly when unusable.

## Projects

The central registry supports several workspaces without mixing authority:

```powershell
npm run dev -- projects list
npm run dev -- projects add C:\path\to\project
npm run dev -- projects use <id-or-name>
npm run dev -- projects remove <id-or-name>
```

In the TUI, `/project` shows/switches projects, `/projects` manages the registry, and `/search` performs explicit read-only global search. Sessions and tasks belong immutably to one project; each project has only one active task, but different projects may run concurrently. `remove` unlinks a project without deleting history. The OMP vault, configuration, persona, skills, and audit data are central; workspace tools, SourceHub, OMP/Fusion, and scoped memory use the chosen root.

## Local UI

```powershell
npm run dev -- ui
npm run dev -- ui --port 4317 --no-open
```

Without `--port`, the system selects a free port. Copy the `Local bootstrap` URL into a browser if automatic opening fails. The token works once.

The UI supports session creation/selection, history, per-turn provider/model selection, chat, steering, stop, and approval resolution. It also shows tasks, public trace, and local search. The **Routing** button edits fallback and Fusion/MoA from the unified catalogue; the API revalidates limits/models and explicit per-session selections remain exact.

English is the default. The **EN/PT** selector changes the web UI locale and asks the principal model, Fusion/MoA consultants, and optional synthesizer to write user-facing prose in the same language on subsequent turns. The choice is stored locally in the browser and sent as the bounded `en` or `pt` `responseLanguage` field on each new chat request. The runtime adds a model-side instruction; it does not post-process responses or rewrite conversation history. Code, commands, paths, logs, errors, quotations, source excerpts, data values, and exact requested tokens remain verbatim unless the user explicitly requests translation. An explicit per-turn language request overrides the UI preference. CLI, TUI, API diagnostics, source code, and persisted authority remain English.

Do not use an alternate `localhost`, proxy, or tunnel: the server validates the exact host `127.0.0.1:<port>` and Origin for mutations. Stop it with `Ctrl+C`.

## Fusion/MoA

```powershell
npm run dev -- fusion status
npm run dev -- fusion enable moa anthropic/<model> neuralwatt/<model> [others...]
npm run dev -- fusion enable fusion anthropic/<model> openai-codex/<model> [others...] --synthesis <provider/model|auto> --max-parallel 4
npm run dev -- fusion participants <provider/model...>
npm run dev -- fusion synthesis <provider/model|auto>
npm run dev -- fusion parallel <1-8>
npm run dev -- fusion mode <moa|fusion>
npm run dev -- fusion run "test request"
npm run dev -- fusion disable
```

The system permits 2–8 distinct participants from any providers in the catalogue, including Neuralwatt. Confirm login, quota, cost, and data policy for every consultant. Request text is sent to every configured model. Retrieved memory is not sent to the panel, but the request itself may contain sensitive data.

`maxParallel` and `candidateTimeoutMs` can be adjusted in `.superai/config.json`; startup rejects invalid limits.

## Upstream radar

```powershell
npm run dev -- upstream list
npm run dev -- upstream check oh-my-pi
npm run dev -- upstream check --all
npm run dev -- upstream show oh-my-pi
npm run dev -- upstream mark oh-my-pi pending "review required"
npm run dev -- upstream mark oh-my-pi reviewed "relevant mechanisms reviewed"
npm run dev -- upstream mark oh-my-pi dismissed "not adopted in this version"
```

Normally use `check <id>`; `--all` is explicit and may hit public rate limits. The radar reads `config/upstreams.json`, queries only GitHub release/commit/tree metadata, and stores checks/reviews in `.superai/upstream-radar.json`. It downloads no blobs/patches, does not clone or apply changes, and does not update the baseline. Include/exclude/topic filters reduce noise; `mark` only records human review. To adopt something, review source and license, implement/test it explicitly, and only then update the baseline manually.

## Memory

```powershell
npm run dev -- memory list
npm run dev -- memory add --kind preference --scope global --importance 0.9 "text"
npm run dev -- memory get <id>
npm run dev -- memory recall "query"
npm run dev -- memory approve <id>
npm run dev -- memory reject <id>
npm run dev -- memory supersede <old-id> <new-id>
npm run dev -- memory forget <id>
npm run dev -- memory feedback <id> up "note"
npm run dev -- memory contradictions <id>
npm run dev -- memory relate <id-a> contradicts|duplicates|supports <id-b> "note"
npm run dev -- memory relations [id]
npm run dev -- memory sources
npm run dev -- memory stats
npm run dev -- memory export memory-export.json
```

`contradictions` is a similarity heuristic using negation patterns; it does not prove a logical conflict. `relate` stores a human decision and `relations` lists persisted relations.

When self-evaluation is active, each task may create only `pending` operational metadata with a TTL. It stores no complete prompt/response, does not measure factual accuracy, and must not be approved as evidence of quality without human review.

Memory is stored and searched locally. During a remote turn, retrieved memories and up to 14 recent messages enter the prompt sent to the selected provider. Review provider, fallback, and content before using sensitive data.

Exports contain plaintext data and receive restricted permissions, but must be treated as secrets. Manage conversations with:

```powershell
npm run dev -- sessions list
npm run dev -- sessions forget <session-id>
```

## Skills and learning

```powershell
npm run dev -- skills list
npm run dev -- skills candidates
npm run dev -- skills candidate-approve <id> "reason/evidence"
npm run dev -- skills candidate-reject <id> "reason"
npm run dev -- skills convert <id> <skill-id> "description"
npm run dev -- skills approve <skill-id>
npm run dev -- skills reject <skill-id>
npm run dev -- skills evaluate <skill-id> pass "test and result"
npm run dev -- skills versions <skill-id>
npm run dev -- skills rollback <skill-id> <content-hash>
npm run dev -- skills governance
```

In the TUI, `/learn id | description | procedure/evidence` creates a quarantined proposal directly; review the file before `skills approve`.

## Multi-source ingestion

One source:

```powershell
npm run dev -- source add docs\runbook.md
npm run dev -- source add https://example.com/reference
```

A manifest:

```json
{
  "sources": [
    "docs/runbook.md",
    "https://example.com/reference"
  ]
}
```

```powershell
npm run dev -- source import sources.json
```

Every document is associated with its URI, hash, and chunks. Resulting memories begin pending. URLs are limited to public HTTP/HTTPS destinations, and every redirect is revalidated.

This surface is deliberately smaller than OB1/Dify: it includes no automatic Drive, email, SaaS, or enterprise databases. Every new connector needs its own license, authentication, provenance, and threat model.

## Workflows

```powershell
npm run dev -- workflow run examples\research-workflow.json
npm run dev -- workflow status examples\research-workflow.json
```

State lives in `.superai/workflows/<id>.json`. The definition is bound by hash; changing steps after progress exists is rejected. A crash after an agent step's `started` marker pauses the workflow as an unknown effect to prevent automatic replay.

The CLI exposes the human decision without continuing automatically:

```powershell
npm run dev -- workflow recover examples\research-workflow.json <step-id> retry
npm run dev -- workflow recover examples\research-workflow.json <step-id> complete '"confirmed result"'
npm run dev -- workflow recover examples\research-workflow.json <step-id> fail "reviewed reason"
```

`retry` authorizes another attempt; `complete` records a verified result; `fail` terminates with an explicit error. Then review `workflow status` and use `workflow run` to continue where applicable. Do not edit the journal manually.

## Optional Browser Use

Requirements: `uv`, a `BROWSER_USE_API_KEY` or `OPENAI_API_KEY` credential, and a domain allowlist.

Example `.superai/config.json` override:

```json
{
  "adapters": {
    "browserUse": {
      "enabled": true,
      "allowedDomains": ["example.com", "*.example.org"]
    }
  }
}
```

```powershell
$env:BROWSER_USE_API_KEY='...'
# or
$env:OPENAI_API_KEY='...'
$env:SUPERAI_BROWSER_MODEL='gpt-4.1-mini'
npm run dev -- doctor
```

The domain list is privileged configuration; the model cannot widen it in the payload. Every execution requests approval. Use test accounts and confirm the destination in the approval description.

The task, page state, and—depending on mode/model—screenshots or vision are sent to Browser Use's cloud LLM in addition to the primary provider. Use only a VM/profile and disposable accounts; do not open personal sessions in this adapter.

Also select the `automation` profile with `npm run dev -- tools automation`; without both gates, `browser_task` is not registered.

Test the frozen package import without navigating:

```powershell
uv run --link-mode copy --project adapters/browser-use --frozen python -c "from browser_use import Agent, ChatBrowserUse, ChatOpenAI; print('browser-sidecar-ok')"
```

## Optional Microsoft UFO

Install and review the upstream project outside the repository. Then set:

```powershell
$env:SUPERAI_UFO_DIR='C:\Tools\UFO'
$env:SUPERAI_UFO_PYTHON='C:\Tools\UFO\.venv\Scripts\python.exe'
```

Enable `adapters.computerUse.enabled` in `.superai/config.json` only after testing UFO directly in a VM/disposable account. The wrapper requires `ufo/ufo.py`, constrains duration/output, and returns JSON, but the upstream process controls the real desktop.

Also select the `automation` profile; without both gates, `computer_use` is not registered.

## Backups and logs

Stop the agent before copying the SQLite database:

```powershell
Copy-Item .superai\state.db .\state-backup.db
Copy-Item .superai\workflows .\workflow-backup -Recurse
Get-Content .superai\audit.jsonl -Tail 50
Get-Content .superai\skill-audit.jsonl -Tail 50
```

Backups and exports are not encrypted. Do not commit or share them without inspection.

## Common failures

| Symptom | Check |
|---|---|
| global login does not appear | expected in strict mode; run `login <provider>` inside Axiomux |
| OMP fails because of a digest | do not bypass it: inspect/manually remove the mismatched artifact and repeat `npm run omp:install`, or explicitly audit a new release |
| login warns about `0.0.0.0` | use a trusted network; prefer device flow; do not expose/forward the port |
| Perplexity login opens a CLI | expected for the pre-auth prompt; the OTP may be displayed and login may still expose no models |
| configured model is missing | run `providers`, `models <provider>`, and log in again inside the isolated OMP database |
| `doctor` reports a missing login flow | confirm the OMP version; the actual catalogue may have changed; this is blocking only if you need that flow |
| Neuralwatt lists models but does not authenticate | repeat `login neuralwatt`; `/v1/models` is not proof of a valid key |
| UI returns 401 | restart it and use the new bootstrap URL exactly once |
| Browser Use does not start | confirm `uv`, lockfile, credential, and a non-empty `allowedDomains` |
| workflow remains paused after a crash | do not retry automatically; the effect may already have occurred |
| recall misses concepts expressed with different words | expected feature-hashing limit; use explicit terms/aliases or improve the source |
