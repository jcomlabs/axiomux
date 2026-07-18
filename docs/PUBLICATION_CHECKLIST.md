# Publication checklist

This is the authoritative path from a validated local checkout to the first public GitHub release. A checked item must have evidence; intention or a passing subset is not enough.

## Gate 1: owner decisions and reservations

- [ ] The owner has explicitly approved the product display name, repository slug, package name, CLI names, and visual direction.
- [ ] An exact collision screen has been refreshed immediately before reservation. It covers GitHub, npm, PyPI, common domains, web search, and a preliminary trademark search.
- [ ] The owner has reserved the GitHub account or organization, repository slug, package names, and any domain that will be announced.
- [ ] The owner has approved the public profile name, bio, avatar, and original persona.

No automated check can reserve an identity or replace legal trademark clearance.

## Gate 2: isolated migration

- [ ] General engineering changes are committed before the brand migration.
- [ ] The brand migration is one reviewable commit on its own branch.
- [ ] `config/brand-migration.json` contains the approved target.
- [ ] Public names, package metadata, CLI binaries, UI, documentation, tests, release copy, and artwork use the approved brand.
- [ ] `.superai`, `SUPERAI_*`, stored credentials, memory, audit data, and schema identifiers remain compatible through 1.x.
- [ ] Temporary aliases exist for any command already distributed to testers.
- [ ] `npm run brand:audit` reports the approved state with no drift.

## Gate 3: open-source and security evidence

- [ ] `LICENSE`, `SOURCES.md`, and `THIRD_PARTY_NOTICES.md` match the exact distributed contents.
- [ ] No incompatible, proprietary, leaked, FSL, SUL, AGPL-service, or third-party branded code is distributed under the project's MIT license.
- [ ] Runtime and development dependency licenses have been reviewed from their current authoritative metadata.
- [ ] `npm run validate:full` passes from a clean checkout with complete Git history.
- [ ] The managed OMP release is the audited version and every platform digest matches the official release metadata.
- [ ] `doctor` passes offline and `doctor --online` completes a live turn without exposing credentials.
- [ ] `npm pack --dry-run --json` contains no private state, research checkout, secret, personal path, or retired identity asset.
- [ ] Known limitations and untested provider/account paths are stated without inflated claims.

## Gate 4: repository preparation

- [ ] The public repository is created under the approved owner with no generated README, license, or `.gitignore` that could conflict with the audited root.
- [ ] The clean publication branch is pushed as the default branch.
- [ ] GitHub Actions has read-only contents permissions unless a job explicitly needs more.
- [ ] CI passes on Windows and Linux; optional adapters pass their frozen checks.
- [ ] Dependabot is enabled for npm, Python, and GitHub Actions.
- [ ] Private vulnerability reporting and GitHub Security Advisories are enabled.
- [ ] Branch protection requires CI and prevents accidental force pushes to the default branch.
- [ ] Topics, description, website, social preview, and screenshots match the approved release copy.

## Gate 5: release

- [ ] A clean-clone installation is tested using only the public repository instructions.
- [ ] The release package is rebuilt from the public commit and its SHA-256 is recorded.
- [ ] The tag and release version agree with `package.json` and `CHANGELOG.md`.
- [ ] The GitHub release is created as a draft and the owner reviews title, notes, package contents, screenshots, and known issues.
- [ ] The draft is published only after owner approval.
- [ ] The public clone, install, managed OMP installation, login catalogue, UI launch, and one live turn are retested from the release instructions.

## Gate 6: submission-only work

- [ ] Competition copy, judge script, screenshots, demo timing, and submission metadata remain in a separate commit or branch.
- [ ] Removing the submission-only commit leaves a clean, coherent general-purpose product.
- [ ] The general release does not claim provider E2E coverage, computer-use parity, or independent security review that was not actually demonstrated.

## Owner-only actions

The owner must make identity choices, accept provider and GitHub terms, reserve names or domains, change account settings, approve the public destination, and approve the final release. The implementation agent can prepare and verify everything else, update local remotes after a username change, push after explicit authorization, configure the repository through GitHub, and validate the published result.
