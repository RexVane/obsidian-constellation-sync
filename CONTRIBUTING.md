# Contributing

Thanks for helping improve Constellation Sync.

## Development

1. Install Node.js 20 or newer.
2. Run `npm ci`.
3. Optionally copy `.env.example` to `.env.local` to test a GitHub App you control. OAuth Client IDs and App slugs are public metadata; never add a client secret or user token.
4. Run `npm run check` before opening a pull request.

Pull requests should keep the plugin source-first: generated `main.js` is a release artifact and is intentionally ignored on the `main` branch.

## Releases

Release tags must match `manifest.json`, `package.json`, `package-lock.json`, and `versions.json`. Publishing a GitHub Release invokes the build workflow, uploads `main.js`, `manifest.json`, and `styles.css`, and generates artifact attestations for those files.
