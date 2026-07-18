# Judge testing

Axiomux is submitted as a Windows desktop/CLI developer tool. The primary judge path is a prebuilt npm tarball: it installs compiled JavaScript and does not require TypeScript, a source build, an account, or provider credentials.

## Validated platform

| Surface | Status |
|---|---|
| Windows 11 x64 | validated target |
| Node.js 24.14.1 | validated runtime; `>=24` required |
| PowerShell 7 | required only for persistent Neuralwatt login on Windows |
| macOS/Linux | source and OMP assets exist, but the complete Axiomux package is not yet claimed as validated there |
| Browser Use/UFO | experimental and excluded from the judge path |

## Install the prebuilt test package

Download [`axiomux-agent-0.1.0.tgz`](https://github.com/jcomlabs/axiomux/releases/download/v0.1.0-alpha/axiomux-agent-0.1.0.tgz) and its matching [SHA-256 file](https://github.com/jcomlabs/axiomux/releases/download/v0.1.0-alpha/axiomux-agent-0.1.0.tgz.sha256). Then, in a new directory:

```powershell
New-Item -ItemType Directory axiomux-judge
Set-Location axiomux-judge
npm init -y
npm install C:\path\to\axiomux-agent-0.1.0.tgz
npx axiomux --help
npx axiomux-demo
```

Expected final result:

```text
Axiomux portable-continuity demo: PASS
  [PASS] portable-continuity: ...
  [PASS] effect-aware-fallback: ...
  [PASS] governed-memory: ...
  [PASS] effect-policy: ...
  [PASS] skill-governance: ...
  [PASS] fusion-fault-isolation: ...
```

The demo uses temporary isolated state and deletes it on exit. It makes no network request, reads no provider credential, and does not mutate the user's Axiomux state.

## What the demo proves—and does not prove

It executes the shipped agent session, memory, routing, effect-ledger, fallback, policy, skill, and Fusion implementations. Deterministic provider fixtures prove that the same local session can hand off between exact routes, that a pre-effect failure may fall back, and that a post-effect failure cannot replay a completed action. The fixtures do **not** claim live access to their named demo providers. Separately, `BUILD_WEEK.md` records the completed live GPT-5.6 turn, online doctor, and governed host-tool E2E. The demo does not prove that every provider account can authenticate, that every catalogue entry exposes a chat model, or that browser/desktop automation is safe for personal accounts.

## Optional live provider path

This path is not required for the offline demo and consumes the operator's own provider access:

```powershell
npm explore axiomux-agent -- npm run omp:install
npx axiomux providers
npx axiomux login openai-codex-device
npx axiomux models openai-codex
npx axiomux model openai-codex/<available-gpt-5.6-model>
npx axiomux chat "Reply with AXIOMUX_GPT56_OK only"
```

The actual model identifier must come from `models openai-codex`; never assume account entitlement from the existence of a login flow. The isolated vault intentionally does not borrow credentials from a global OMP installation.

## Maintainer release reproduction

These commands are for maintainers, not judges:

```powershell
npm ci
npm run validate:full
npm pack --pack-destination .superai\release
Get-FileHash .superai\release\axiomux-agent-0.1.0.tgz -Algorithm SHA256
```

The tarball excludes source tests, Git history, `.superai/` private state, credentials, and development-only TypeScript tooling. On 2026-07-18, the final tarball was installed with `--ignore-scripts` in a new directory: both binaries exited successfully, the six-check demo passed, and neither command wrote to stderr. Its matching `.sha256` file is published beside the release attachment; the uploaded asset is downloaded and checked once more after publication.

## Troubleshooting

- `axiomux` not found: use `npx axiomux` from the test directory or reopen the terminal after a global install.
- unsupported Node version: install Node 24 or newer.
- OMP version/hash failure: run `npm explore axiomux-agent -- npm run omp:install`; Axiomux deliberately rejects drift from its audited OMP contract.
- no OpenAI models after login: confirm the account, entitlement, quota, and isolated-vault login; a provider flow is not a model guarantee.
- SQLite experimental warning: the CLI suppresses Node's current warning; the alpha status and migration limitation remain documented in `KNOWN_ISSUES.md`.
