**English** | [简体中文](README.zh-CN.md)

# Constellation Sync

Constellation Sync is an Obsidian community plugin for synchronizing multiple vaults through independent branches in one private GitHub repository.

## Data model

- One dedicated private GitHub repository can contain multiple vaults.
- Each vault lives at the root of one non-default branch.
- The branch name is the vault's shared English name, such as `work-notes`.
- `.constellation-sync/vault.json` stores a stable `vaultId`, so devices can follow branch renames safely.
- The default branch is only a repository landing page and is never used as a vault branch.
- Visible empty directories are represented by an internal `.constellation-sync-empty-folder` marker, allowing GitHub and other devices to reconstruct the complete vault folder structure. The marker is removed automatically once the directory holds a real file.
- Branch discovery deduplicates the stable `vaultId`, displays the actual GitHub branch name and revalidates it when another device joins.

## Sync rules

The plugin compares what changed locally and remotely against the last successfully synchronized common version. When only one side changed, that change is carried to the other. When both sides changed different regions, the plugin merges them. Edits to the same region, a delete that races a modification, binary files and anything that cannot be merged safely are preserved as a conflict copy and listed for you to resolve. The plugin never uses file modification times to silently overwrite one side, and never discards conflicting content.

Local files are rewritten only after the remote commit succeeds, so a failed push leaves the vault exactly as you left it. A path that cannot be stored safely on every platform is skipped and reported rather than stalling the rest of the vault.

## Security

GitHub App authentication uses OAuth Device Flow and repository-scoped Contents permission. Access and refresh tokens are stored only in Obsidian SecretStorage. A private repository controls access, but it is not end-to-end encryption: GitHub and anyone with repository access can read the synchronized files.

This repository intentionally contains no user tokens, refresh tokens, client secrets, local vault data or `.env.local` files. Compiled `main.js` is kept out of the source branch and attached only to versioned GitHub Releases. A clean checkout has the project's public OAuth Client ID and App installation URL as reproducible build defaults; developers can override them with `.env.local` when testing a different GitHub App. A GitHub OAuth Client ID is public metadata; never put the App client secret in the plugin or in Git history.

## Installing the development build

1. Download or clone this repository.
2. Install Node.js 20 or newer and run `npm ci`.
3. Optionally copy `.env.example` to `.env.local` to use a different GitHub App; the public release App is used by default.
4. Run `npm run build`.
5. Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/constellation-sync/`, then enable the plugin in Obsidian.

The public repository is source-first. Community-plugin releases contain the configured `main.js` asset needed for one-click installation. The checked-in release defaults are public OAuth metadata, not credentials; no client secret is required or accepted by the plugin.

## Development

1. Copy `.env.example` to `.env.local` and provide the public client ID and installation URL of a test GitHub App.
2. Export the variables in the shell used for building.
3. Run `npm install`.
4. Run `npm run dev` for a watch build or `npm run check` for the complete verification suite.

The GitHub App needs only repository Contents read/write permission. Enable Device Flow and install it only on explicitly selected private repositories. See [`docs/github-app-setup.md`](docs/github-app-setup.md) and [`docs/testing.md`](docs/testing.md) for the full configuration steps.

## Status

Version `0.1.5` makes a failed push leave the vault untouched, keeps one unportable filename from stalling the whole vault, and requires an explicit choice before a device binds to a vault branch. Live OAuth integration uses a public GitHub App Client ID; no client secret is embedded in the plugin.

## License

This project is released under the MIT License. See [`LICENSE`](LICENSE).
