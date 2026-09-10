# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.6.x | ✅ |
| < 0.6.0 | ❌ |

## Reporting a vulnerability

Please report security problems privately through **GitHub's "Report a vulnerability"** (Security tab → Report a vulnerability) or by contacting the maintainers directly. Do not open a public issue for anything you believe is exploitable.

Include: the affected version, the steps to reproduce, and what an attacker could gain. You will get an acknowledgement within a few days, and a fix or a mitigation plan before any public disclosure.

## Scope and design notes

- GitHub access tokens are stored **only** in Obsidian SecretStorage. They are never written to `data.json`, vault files, or Git history, and the plugin never transmits them anywhere except `api.github.com` and `github.com`.
- The plugin contains **no** OAuth client ID, client secret, or GitHub App configuration, and never should. A PR introducing embedded credentials will be rejected.
- Private repositories are recommended. Public repositories are supported only with an explicit visibility warning; all synchronized content in one is visible to everyone.
- The token only needs **Contents** read/write. `.github/` is always excluded, so synchronization never needs Workflows or Administration permission.
- A private repository controls access but is **not end-to-end encryption**: GitHub and anyone with repository access can read the synchronized content. This is stated in the UI and README; reports about the absence of E2E encryption are welcome as design discussions, not vulnerabilities.
- Path traversal is guarded by `normalizeRepoPath` and the portable-path checks; fuzzing those guards is a welcome research area.

## What is out of scope

- A compromised device or a malicious plugin running in the same Obsidian instance can always read SecretStorage contents.
- GitHub-side access (a compromised GitHub account, GitHub itself).
- The local `data.json` metadata: it contains vault structure and commit ids, never tokens.
