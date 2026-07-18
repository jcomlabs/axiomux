# Security policy

## Supported status

While Axiomux remains at version `0.x`, security fixes apply to the latest commit on the main branch. The project has not yet received an independent external audit.

No agent configuration has zero risk. The goal is to reduce privileges, make effects visible, fail closed at critical boundaries, and state residual risks clearly.

## Reporting a vulnerability

Do not open a public issue containing credentials, private prompts, personal paths, or an unmitigated exploit. Contact the maintainer through a private channel; once the repository enables Security Advisories, use that mechanism. Include the affected commit, a minimal reproduction, the impact, and the smallest safe proof of concept.

## Trust boundaries

### OMP and provider authentication

OMP is an external executable dependency and must come from a trusted source. Axiomux normally communicates with it over JSONL RPC; it does not read or copy OMP credential storage.

The audited contract is exactly `omp/17.0.4`, tag/commit `3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0`. Before every spawn, the runtime calculates the executable's SHA-256 and requires the digest published in the official release for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, or `win32-x64`. A mismatched version, a platform without an audited digest, or modified bytes fail closed. The observed Windows x64 artifact matches the official digest `326FB7DF19A8A4516F129A52D60373B547F732C17F19D4C38700F3591D85AA73`, but has Authenticode status `NotSigned`; hash verification does not eliminate trust in the official manifest/distribution channel.

`npm run omp:install` installs the official asset in a versioned location under `.superai/bin/`. The installer accepts only HTTPS and expected release hosts, enforces a 512 MiB limit, writes an exclusive temporary file, verifies the digest before renaming, and rechecks version/digest at the destination. An existing file with unexpected bytes fails closed and is not deleted or replaced automatically.

Axiomux is not an OMP fork/mod: it uses the executable as a process dependency and the observed public protocol. It loads no internal modules, does not modify the binary, and does not require OMP extensions.

In the default `strict` mode:

- `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`, and `PI_CODING_AGENT_DIR` point to the private `.superai/omp-runtime/` tree;
- every RPC/model process uses `--no-extensions`, `--no-skills`, and `--no-rules`;
- implicit extension, hook, tool, command, and plugin directories/configuration are rejected;
- explicit extension/hook/plugin arguments are rejected;
- the global OMP credential database is not imported automatically.

RPC/model processes and the authentication subcommand also use `PI_AUTH_NO_BORROW=1`, preventing silent import of supported credentials from desktop applications. Login tries RPC first. Only the exact audited pre-auth rejection switches to the official `omp auth-broker login <provider>` subcommand, with fixed arguments, an interactive terminal, and the same isolated vault; this route is not a coding-agent session and does not load extensions. Logout uses the same boundary, requires confirmation, and removes every stored account for that provider because UI `0.1.0` does not expose multi-account selection.

OMP `17.0.2` was observed binding OAuth callbacks for OpenAI Codex, Anthropic, and GitLab temporarily to `0.0.0.0` despite advertising `localhost`; the reviewed `17.0.4` monitored diff did not change those flows. Axiomux conservatively keeps the warning and confirmation because it cannot repair the upstream bind. Use a trusted network with no port forwarding; prefer `openai-codex-device` for OpenAI. The Perplexity flow is an unofficial, reverse-engineered email-OTP integration, may display values in the terminal, and may authenticate search without exposing any chat model.

This resolves the old Neuralwatt concern: extension discovery no longer needs to remain active. If a future OMP version changes the meaning of these flags or the protocol, compatibility must be retested before updating.

There is no supported `shared` mode. It would make configuration, credentials, and executable surfaces discovered in the global HOME implicit dependencies, contradicting reproducibility and least privilege. `SUPERAI_OMP_ISOLATION` accepts only `strict`, and `rejectUntrustedExtensions` must remain `true`.

There is also no `yolo` approval mode: auto-approving tools would erase the human decision, permit effects induced by prompt injection, and invalidate the effect ledger as a replay boundary. Only `always-ask` is supported; `shared` and `yolo` have no hidden bypass and will not return without a different, explicit threat model. The boundary rejects native OMP filesystem, shell, Python, browser, LSP, and image tools; it permits only `todo` and `web_search`, with search subject to OMP's approval prompt.

### Neuralwatt

Neuralwatt is integrated by Axiomux itself. After validating the key through `/v1/quota`, the project stores only:

- the protected credential in `.superai/secrets/neuralwatt.dpapi` on Windows, using DPAPI `CurrentUser`;
- a credential-free `models.yml` containing the name of the `NEURALWATT_API_KEY` variable.

The key is sent to OMP only in the environment of that child process. There is no persistent plaintext fallback. If a Axiomux-managed `models.yml` exists without an available/decryptable credential, the provider runtime fails closed rather than treating the literal placeholder as a key. The complete CLI flow is Windows-only in `0.1.0`; on other platforms, an ephemeral environment variable works only with a separately provisioned `models.yml`.

DPAPI protects against casual access by other accounts and simple offline copying; it does not protect against malware or code already running as the same user.

### Local state

`.superai/` contains conversations, memory, source chunks, workflow state, and audit logs. Startup applies a private ACL on Windows and `0700`/`0600` permissions on POSIX; if it cannot create that boundary, every command that would start the agent/provider fails closed. SQLite and JSON contents remain local plaintext; protect backups and exports as personal data.

Tokens obtained by the authentication broker belong to OMP's isolated SQLite store. Axiomux neither reads nor re-encrypts them; the private directory ACL is the protection. The Neuralwatt key is the exception and is protected by DPAPI `CurrentUser`. Malicious code running as the same user may still access both.

Audit filters remove common secret formats but cannot guarantee detection of every identifier or sensitive value. Do not place secrets in prompts, memory, skills, manifests, or file names.

### Memory, sources, and skills

Pages, files, model responses, and pending memories are untrusted content. Only approved instructions/preferences enter the prompt's authority layer.

Local storage does not imply local inference: the agent prompt includes relevant retrieved memories and up to 14 recent messages, which are sent to the selected provider. Fusion sends the current request to each configured consultant. Do not use remote providers for content that you are not permitted to transmit under their terms.

URL ingestion:

- accepts only HTTP/HTTPS without embedded credentials;
- resolves DNS, rejects local/private/reserved addresses, and pins the request to the validated public IP;
- revalidates every redirect;
- limits content size and types.

File ingestion prevents workspace escape, outward symlinks, and sensitive paths such as `.env` and `.superai`.

Proposed skills begin in quarantine, pass through a scanner, and require explicit approval. The scanner is an additional defense, not proof of safety: manually review instructions, commands, dependencies, and provenance before activation.

### Tools, effects, and fallback

OMP receives only `todo` and `web_search` as native tools, plus a minimal environment. Axiomux implements reads, local search, mutations, processes, browser, and desktop capabilities as host tools. The local layer pins the workspace by real path; rejects traversal, escape links, `.git/`, `.superai/`, sensitive paths, alternate data streams, and device names; and applies input/output limits. Writes, edits, execution, and external adapters fail closed without explicit approval.

The host tool named `bash` does not invoke a shell: it executes an allowlisted program with separate arguments and `shell: false`; shell interpreters are rejected. `python` uses `-I`. This reduces injection and inherited environment exposure, but is not an operating-system sandbox: an approved program runs with the current account's privileges and may have its own filesystem or network capabilities.

Host tools with effects first write a durable record. After a consequential effect, the agent does not silently try another provider, preventing replay and additional prompt disclosure.

Cross-provider fallback is empty by default. By configuring it, you accept that content may be sent to each provider in that list before any effect occurs. Check terms, data residency, and request sensitivity.

The global list accepts at most 8 distinct models validated against the catalogue. Fusion/MoA accepts 2–8 arbitrary participants from the same catalogue and sends the request to all of them; only the primary agent receives tools. The **Routing** UI and CLI modify the same configuration. Neuralwatt participates through its native implementation and the same `provider/model` selector, with no extension.

A model choice persisted in a session is exact routing and does not inherit the global fallback list. This rule preserves that session's explicit provider/privacy decision.

Workflows retain a definition hash, a start journal before each effect, and idempotency keys. If the process exits after an effect whose outcome is unknown, automatic replay is blocked for a human decision. Idempotency also depends on each integration honoring the supplied key.

### Local UI

The UI listens only on `127.0.0.1` and uses a one-time bootstrap token followed by an `HttpOnly; SameSite=Strict` cookie. It validates `Host` and `Origin`, rejects proxy headers, does not enable CORS, and applies CSP/COOP/CORP and body-size limits.

These protections assume local access. Do not place the UI behind a reverse proxy, tunnel, port share, or alternate hostname. Other processes running as the same user remain inside the desktop trust boundary.

The UI exposes only a sanitized public trace; chain-of-thought and credentials are not part of the event contract.

The **Routing** dialog can change fallback and Fusion/MoA. The API revalidates models, limits, mode, synthesizer, and concurrency; an explicit per-session/request selection remains exact and disables both fan-outs.

### Upstream radar

The radar queries only the public GitHub API for release, commit, and tree metadata from configured sources. Baselines, licenses, include/exclude filters, and topics live in `config/upstreams.json`; private state/review lives in `.superai/upstream-radar.json`.

It downloads no file content or patches, clones no repositories, executes no code, and changes no baseline, code, or dependency. Results remain `pending` until `upstream mark ... reviewed|dismissed`; that mark is only human-decision metadata. Redirects/origins, sizes, JSON, owner/repository/SHAs, and history limits are validated. A “relevant” result is path/topic triage—not an adoption recommendation or evidence of safety.

### Projects

The central registry separates the installation from workspaces through canonical roots. Sessions and tasks belong to one project; host tools, SourceHub, OMP/Fusion, and scoped memory use the selected root. Cross-project search is read-only, bounded, and explicitly global. The two-workspace E2E test covers distinct current directories, one vault, escape blocking, project/global memory, and UI routing.

This prevents accidental mixing between projects, but is neither a multi-user boundary nor a sandbox. Every project remains under the same operating-system account, central configuration, and OMP vault.

### Browser and desktop automation

The Browser Use and Microsoft UFO adapters are disabled by default. Both execute third-party code capable of observing or modifying external systems.

Browser Use requires a fixed domain allowlist. The sidecar uses an ephemeral profile and downloads, headless operation, no extensions, IP blocking, and step limits. The task, page state, and—depending on model/mode—screenshots or vision may be sent to the second cloud LLM used by Browser Use, in addition to the primary provider. Pages may still contain prompt injection, navigate unexpectedly, or induce consequential actions. Use a VM and least-privilege test accounts; never reuse a personal session.

UFO controls the real desktop. Install it separately, pin/review the upstream commit, and run it in a VM or disposable Windows account without personal credentials. The Axiomux wrapper does not turn UFO into a sandbox.

Neither adapter has been validated end to end in this repository without the required external credentials and installations. Do not advertise either as reliably operational until a controlled test in the target environment.

## Operator checklist

Before publishing or using real data:

1. Run `npm run omp:install` and confirm the managed runtime version/digest before first use.
2. Run `npm run validate`, `npm run security:browser` if you use the Python adapter, and `npm run dev -- doctor`.
3. Log in only to required providers inside the isolated OMP database.
4. Keep `ompIsolation.mode` set to `strict`; the validator rejects every bypass.
5. Review `.superai/config.json`, fallback providers, tools, and environment/domain allowlists.
6. Run `npm run doctor:online` with a non-sensitive request.
7. Use `npm run e2e:host` for the single controlled consequential host test.
8. Test browser/desktop automation in a disposable account or VM before granting real access.
9. Inspect `.superai/audit.jsonl` and remove test data before sharing the project.

## Outside the current threat model

- compromise of the user's account or operating system itself;
- malicious/compromised OMP, Node.js, Python, provider SDKs, or models;
- strong operating-system/network isolation for approved host processes, Browser Use, or UFO;
- cryptographic protection of the entire local database;
- complete defense against prompt injection in browser/computer use;
- a guarantee against exfiltration after the operator approves code or external actions.
