# Changelog

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
