# Changelog

## 0.2.0 — Sign in with a GitHub token

Breaking change: the GitHub App and OAuth Device Flow are gone. Existing devices keep working until their App session expires, then re-connect once by pasting a token.

- Connect by pasting a GitHub personal access token. The plugin validates it, stores it only in Obsidian SecretStorage, and lists private repositories through `/user/repos`. A fine-grained token limited to the sync repository is the least-privilege option; the login screen offers a one-click pre-filled classic token page. Step-by-step instructions live in the new `docs/github-token-setup.md` (English and Chinese).
- Remove every build variable, `.env.example`, the release-workflow OAuth defaults and the "install the App" detour — the plugin carries no OAuth metadata at all now.
- When a token expires or is revoked, the plugin clears the stored account and shows the token screen again instead of failing in the background.
- Reduce the dashboard to two pages: Overview (status, sync, pending review, inline conflicts, skipped files, recent activity) and Settings (vault management with rename and disconnect, preferences, shared policy, an advanced section with diagnostics and file restore, sign-out).
- Drop the "sync core Obsidian settings" and "sync themes and CSS snippets" policy toggles and their plumbing. The shared policy now only carries ignore patterns and explicitly listed community plugin data; policy fields written by older devices are ignored gracefully.
- Remove the standalone history page. Restoring a file from a commit moves into the settings' advanced section; commit browsing remains available on github.com.

## 0.1.8 — Reliable shared policy changes

- Resolve the head for a commit through GraphQL. The REST ref endpoint is served from a replica and can still report the previous commit moments after a write, while `createCommitOnBranch` is strongly consistent, so a policy change made shortly after a sync failed with `Expected branch to point to ... but it did not`.
- Replay a metadata write that GitHub rejects because the branch moved, instead of surfacing the rejection.
- Commit the shared marker before adopting a policy change locally. A failed write used to leave the device holding a policy that neither disk nor the remote agreed with.
- Ignore a remote policy whose `policyRevision` is lower than the one already accepted. A lagging read could otherwise roll back a setting seconds after it was changed.

## 0.1.7 — Popout window timer compatibility

- Schedule the device-flow poll and the request backoff through `window.setTimeout` and `window.clearTimeout` again. A popout window has its own timer scope, so the bare globals introduced in 0.1.5 resolve against the wrong window.

## 0.1.6 — Settings toggles render as toggles

- Scope and qualify the switch selectors so they outrank Obsidian's rules for a bare `input[type="checkbox"]`. The attribute selector had been winning, so a checked row drew Obsidian's accent circle while the plugin's transform dragged its checkmark outside the control.
- Clear the core checkbox marker, including its mask, and take the track and thumb colours from Obsidian's own toggle variables so the row matches the surrounding app in any theme.

## 0.1.5 — Sync durability and safety fixes

- Apply conflict copies and merged files only after the remote commit succeeds, so a failed push leaves the vault exactly as the user left it instead of overwriting local edits and discarding the conflict record.
- Share a single refresh across concurrent requests, because GitHub invalidates a rotating refresh token as soon as one caller redeems it.
- Report a branch without a vault marker as an absent marker rather than a request failure, matching what every caller already expects.
- Skip paths that cannot be stored portably and report them, instead of refusing to synchronize the entire vault because of one filename.
- Bind a vault only from an explicit choice; a branch guessed from the local folder name silently forked devices onto separate branches.
- Queue preference, policy, restore, disconnect and sign-out operations so they can no longer interleave with a running sync.
- Reuse content hashes for files whose modification time and size are unchanged, removing a full vault rehash from every automatic sync.
- Add a settings field for community plugin data, which the sync policy supported but no screen exposed.
- Accept an empty device-name field while typing instead of rejecting every keystroke.

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
