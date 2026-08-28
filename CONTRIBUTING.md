# Contributing

Thanks for helping improve Constellation Sync.

## Development

1. Install Node.js 20 or newer.
2. Run `npm ci`.
3. Run `npm run check` before opening a pull request.

No build variables are required: the plugin contains no OAuth client ID, no client secret and no GitHub App configuration, and never should. Never add a client secret or user token to the repository.

Pull requests should keep the plugin source-first: generated `main.js` is a release artifact and is intentionally ignored on the `main` branch.

## Releases

Release tags must match `manifest.json`, `package.json`, `package-lock.json`, and `versions.json`. Publishing a GitHub Release invokes the build workflow, uploads `main.js`, `manifest.json`, and `styles.css`, and generates artifact attestations for those files.
