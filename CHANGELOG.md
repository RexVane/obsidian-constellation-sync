# Changelog

## 0.1.4 — Canonical vault branch selection

- Deduplicate branches that carry the same stable `vaultId` and prefer the branch whose actual name matches the shared vault metadata.
- Display actual GitHub branch names in the join list instead of potentially stale metadata labels.
- Resolve the canonical branch again when joining, preventing an old duplicate branch from being selected from a stale screen.
- Add continuous integration checks for every push and pull request.

## 0.1.3 — Complete vault structure synchronization

- Preserve visible empty directories across Windows, macOS and mobile devices with internal hidden marker files.
- Remove stale markers when a directory gains content, and prune empty directory chains when a remote directory is deleted.
- Keep hidden Obsidian configuration directories and user-ignored paths outside empty-directory preservation.

## 0.1.2 — Settings heading review fix

- Use a generic settings heading so the tab remains consistent with the Community Plugin UI guidance.

## 0.1.1 — Community review fixes

- Use Obsidian platform and vault configuration APIs instead of browser or hardcoded platform paths.
- Keep workspace leaves intact during plugin unload and use an inline confirmation for disconnecting a vault.
- Add searchable declarative settings for Obsidian 1.13+ with a legacy settings-tab fallback.
- Make the release build reproducible from a clean source checkout and publish attestations for release assets.

## 0.1.0 — Initial implementation

- Added GitHub App Device Flow authentication with SecretStorage-backed sessions.
- Added private repository selection and one-vault-per-non-default-branch storage.
- Added stable `vaultId` markers and branch/English-name rename recovery.
- Added automatic/manual sync planning, three-way text merge and conflict copies.
- Added mass-deletion confirmation, portable-path checks and GitHub file-size guards.
- Added bilingual, responsive Nebula-inspired dashboard UI.
