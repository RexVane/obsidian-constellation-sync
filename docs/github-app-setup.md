# GitHub App setup

Constellation Sync uses OAuth Device Flow, so a client secret is not shipped in the plugin. The public App Client ID is injected at build time.

## Development App

1. Open GitHub **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Give it a development name and a stable homepage URL.
3. Enable **Device Flow**.
4. Set repository permissions to:
   - Contents: Read and write
   - Metadata: Read-only (implicit)
5. Do not enable Administration, webhooks, issues or pull requests.
6. Keep user authorization and repository selection enabled.
7. Copy the App Client ID to `CONSTELLATION_GITHUB_CLIENT_ID` in the local build environment.
8. Set `CONSTELLATION_GITHUB_APP_SLUG` and `CONSTELLATION_GITHUB_INSTALL_URL`.

## User setup

1. Create a dedicated private repository and initialize it with a README.
2. Install the App and choose **Only select repositories**.
3. Select that private repository.
4. Open the plugin dashboard and connect GitHub.
5. Create a new vault branch or join an existing branch.

The App does not receive repository Administration permission. Branch creation and branch renaming use the Git Database/branch APIs with Contents write permission. The repository must remain private; the plugin refuses to synchronize a public repository.

## Production release checklist

- Register a separate production App rather than reusing the development App.
- Verify the production App slug, Client ID and installation URL in a clean build.
- Confirm no client secret appears in GitHub Actions logs or release assets.
- Test sign-in, refresh, App uninstall and repository permission revocation against a disposable private repository.
