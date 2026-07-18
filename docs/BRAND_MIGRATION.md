# Brand migration record

The product name is intentionally treated as a replaceable public layer. Persisted state and environment compatibility are a separate layer and must not be renamed blindly.

## Sources of truth

- `config/brand-migration.json` records Axiomux as the current public name, the retired RelayLoom identity, the known public-brand surface, and identifiers that must remain compatible.
- `npm run brand:audit` detects current-brand inventory drift and rejects retired public-brand text outside the explicit compatibility allowlist.
- `.superai/owner/IDENTITY_AND_NAMING_DOSSIER.md` is an ignored, owner-only decision file. It must never be committed or packaged.

## Completed public rename

The owner selected the exact spelling **Axiomux**. The public package and commands are `axiomux-agent`, `axiomux`, and `axiomux-demo`; the original emblem was retained under `assets/axiomux-emblem.png`. No GitHub organization, repository URL, or other external destination is asserted by this repository.

A public-web collision screen is useful but is not legal trademark clearance and does not reserve a name, account, or package.

## Compatibility boundary

The following are compatibility identifiers, not the public product brand:

- the `.superai` state directory;
- `SUPERAI` environment-variable prefixes and existing configuration keys;
- legacy state schema identifiers that already exist on user machines.

Keep these identifiers throughout the 1.x line unless a versioned migration with rollback and tests is implemented. A new public name may introduce aliases, but it must not silently orphan credentials, memory, skills, or audit data.

## Future rename sequence

1. Record the owner-approved identity and the previous identity in `config/brand-migration.json`.
2. Create a dedicated rename branch from the clean general-development branch.
3. Replace public text, package metadata, CLI binaries, UI labels, filenames, artwork, tests, and release-copy surfaces listed by `npm run brand:audit -- --json`.
4. Preserve compatibility markers needed to read state written by an earlier version.
5. Leave the internal compatibility boundary intact.
6. Run formatting, language, brand, security, test, packaging, and fresh-install checks.
7. Review the package contents and secret scan before any push or publication.
8. Publish only after the owner approves the final screenshots, README, and repository destination.

## Rollback

The clean release candidate remains on its own branch. Brand work must be isolated in a separate commit so it can be reverted without removing general engineering improvements or compatibility migrations.
