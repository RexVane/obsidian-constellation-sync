**English** | [简体中文](README.zh-CN.md)

# Constellation Sync

Constellation Sync is an Obsidian community plugin for synchronizing multiple vaults through independent branches in one private GitHub repository.

## Data model

- One dedicated private GitHub repository can contain multiple vaults.
- Each vault lives at the root of one non-default branch.
- The branch name is the vault's shared English name, such as `work-notes`.
- `.constellation-sync/vault.json` stores a stable `vaultId`, so devices can follow branch renames safely.
- A vault uses either the repository's default branch (the simple choice for a dedicated repository) or a dedicated non-default branch named after the vault's shared English name, which lets one repository hold several vaults.
- Visible empty directories are represented by an internal `.constellation-sync-empty-folder` marker, allowing GitHub and other devices to reconstruct the complete vault folder structure. The marker is removed automatically once the directory holds a real file.
- Branch discovery deduplicates the stable `vaultId`, displays the actual GitHub branch name and revalidates it when another device joins.

## Sync rules

The plugin compares what changed locally and remotely against the last successfully synchronized common version. When only one side changed, that change is carried to the other. When both sides changed different regions, the plugin merges them. Edits to the same region, a delete that races a modification, binary files and anything that cannot be merged safely are preserved as a conflict copy and listed for you to resolve. The plugin never uses file modification times to silently overwrite one side, and never discards conflicting content.

Local files are rewritten only after the remote commit succeeds, so a failed push leaves the vault exactly as you left it. A path that cannot be stored safely on every platform is skipped and reported rather than stalling the rest of the vault.

## Security

The plugin connects with a GitHub personal access token that you create once and paste into the plugin. The token is stored only in Obsidian SecretStorage and is never written to your notes, `data.json`, or Git history. A fine-grained token can be limited to the dedicated sync repository with only Contents read/write permission; the classic token pre-filled by the plugin carries the broader `repo` scope and is best created with no expiration. You can revoke the token at any time on GitHub. A private repository controls access, but it is not end-to-end encryption: GitHub and anyone with repository access can read the synchronized files. See [`docs/github-token-setup.md`](docs/github-token-setup.md) for step-by-step instructions.

This repository intentionally contains no user tokens, client secrets, local vault data or `.env.local` files. Compiled `main.js` is kept out of the source branch and attached only to versioned GitHub Releases.

## Installing the development build

1. Download or clone this repository.
2. Install Node.js 20 or newer and run `npm ci`.
3. Run `npm run build`.
4. Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/constellation-sync/`, then enable the plugin in Obsidian.

The public repository is source-first. Community-plugin releases contain the configured `main.js` asset needed for one-click installation.

## Development

1. Run `npm install`.
2. Run `npm run dev` for a watch build or `npm run check` for the complete verification suite.

No build variables are required: the plugin contains no OAuth client ID, no client secret and no GitHub App configuration. See [`docs/github-token-setup.md`](docs/github-token-setup.md) and [`docs/testing.md`](docs/testing.md) for configuration and testing steps.

## Status

Version `0.2.1` is the current release: connecting is a matter of creating a GitHub token and pasting it in, with the creation steps spelled out in the login screen. First-time binding can use the repository's default branch, a new branch, or an existing vault branch. The dashboard is reduced to Overview and Settings, with conflicts shown inline on the overview, and the sync-policy options are limited to ignore patterns and explicitly listed community plugin data. Devices connected with an older version re-connect once with a token after their App session expires.

## License

This project is released under the MIT License. See [`LICENSE`](LICENSE).
