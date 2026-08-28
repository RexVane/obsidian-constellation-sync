# Testing checklist

The automated suite is run by `npm run check` and includes type checking, linting, Vitest and a production esbuild.

Before a public beta, run the following against a disposable private repository:

- Create two vault branches in one repository and verify branch isolation.
- Join from an empty Vault and from a non-empty Vault; inspect the initial preview before confirming.
- Edit different sections on two devices and verify a clean merge.
- Edit the same section and verify the original remote path plus a local conflict copy.
- Test local-delete/remote-modify and remote-delete/local-modify.
- Delete 20 files representing at least 25% of the tracked tree and verify the guard pauses.
- Test files at 50 MiB and 100 MiB boundaries.
- Rename the English name in the dashboard and verify every device follows the new branch through `vaultId`.
- Rename a branch from GitHub and verify automatic discovery and metadata repair.
- Restore one file from history and verify a new commit is created.
- Connect with a fine-grained token and with a classic token; verify repository listing respects each token's access.
- Paste an invalid or expired token and verify the error is clear; revoke the token on GitHub and verify local files remain untouched until a new token is pasted.
- Repeat the core flow on Android and iOS with the app backgrounded and resumed.
