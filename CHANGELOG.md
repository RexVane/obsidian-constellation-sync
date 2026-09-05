# Changelog

## 0.4.1 — Survive replica lag after a push

- A successful push was sometimes misread as a failure: the post-push snapshot comes from a REST replica that can lag behind the GraphQL write for a few seconds, so the run saw the pre-push head, retried, and then failed the retry with a stale-head error (the uploaded commit was actually fine). The engine now waits the replica out — up to ~13 s — before deciding the branch moved on.
- A quiet background check that finds nothing to do now clears a stale error status, so one-off transient failures no longer linger after they stop reproducing.

## 0.4.0 — Config sync

- Selected Obsidian configuration now travels with the vault: the dashboard can scan `.obsidian/` and lets you tick what should sync. Appearance, editor settings, hotkeys, themes, snippets, and the enabled community plugins list are preselected; ticking a plugin's settings syncs its configuration, while the plugin itself is best installed from the community marketplace on each device.
- Workspace layout and cache are always excluded, and plugin code files are never uploaded — only the configuration you explicitly pick.
- The selection is stored per device and needs no protocol change: vault markers are untouched, and devices on older versions simply keep ignoring configuration files.

## 0.4.5 — Clearer sync-time label

- The metrics label "Last successful sync" is now "Last content sync" (上次内容同步): the timestamp intentionally refers to the last time real changes were carried over, not the latest no-change check.

## 0.4.4 — Spinner under reduced motion, stale-head-proof pushes

- The pre-push branch check now reads the head through the same consistent channel as the push mutation, so a lagging REST replica can no longer reject a fresh plan as stale; a genuinely moved branch replans automatically instead of surfacing an error.

### Earlier in 0.4.4
- The scan spinner keeps spinning even when the system asks for reduced motion.

- The scan spinner keeps spinning even when the system asks for reduced motion: it is functional feedback that a scan is running, not decoration.

## 0.4.3 — Config picker polish

- Always-excluded entries (workspace layout, cache) no longer clutter the config sync picker; the section help still notes they never sync.
- The "Scan config files" button now spins its icon while a scan runs.

## 0.4.2 — Persist a corrected base commit

- A quiet no-change check now persists a corrected base commit (once), so a lagging replica from a previous run cannot keep misclassifying remote configuration changes as conflicts on other devices.

## 0.3.1 — Repository visibility badge

- Repository cards in the setup screen show the visibility as a small gray badge (Private/Public) beside the repository name — GitHub-style — instead of icons.

## 0.3.0 — Drop the shared ignore rules and community plugin data

Breaking change: the shared sync policy (ignore patterns, community plugin data,and the policyRevision protocol) is gone. Versions before this release cannot read vault markers written by this release,so all devices should upgrade before syncing again. Vault markers written by older versions remain readable..

- Remove the "Shared ignore patterns" and "Community plugin data" settings cards. Contents of the config directory (`.obsidian/`) are now always excluded from sync instead of being synced only for listed plugins..
- Drop the shared policy revision machinery:as `policyRevision`/`syncPolicy` fields in vault.json and policy bookkeeping in settings. Stale policy fields in `data.json` are discarded on save.
- Remove the redundant "Sync now" button from the page header;the overview dashboard keeps its sync action..
- Redesign the dashboard into a single scrolling page: the overview and settings pages merge, the sidebar navigation is replaced by a top status chip, and advanced diagnostics are always expanded.
- Support private and public repositories: the picker lists every accessible repository with a visibility icon and an explicit warning for public ones, and syncing no longer blocks when a bound repository turns public. Private remains the recommended choice.
- Show whole-repository storage usage in the metrics row (GitHub reports the size asynchronously, so it may lag behind the latest commit).
- Remove the manual file-restore form (path + commit SHA); the commit history on GitHub remains the way back.
- Fix the preference rows triggering their switch or dropdown when clicking anywhere in the row; only the control itself responds now.
- Clean up stray UTF-8 BOMs, mixed line endings, and a missing final newline left by earlier edits.

## 0.2.2 — Quiet automatic syncs

- A routine background check that finds no changes is now fully silent: it no longer writes `data.json`, re-renders the dashboard (the flicker on every poll), or logs a "No changes" activity entry. Manual "Sync now" still reports "Up to date".
- "Last successful sync" now refers to the last time real changes were carried over, not the time of the most recent no-change check.
- Scheduled syncs (60 s polling by default, 30 s after edits, on window focus) no longer flip the status text or flash the buttons; only genuine changes update the UI.
- Identical status updates are skipped instead of re-rendering the whole dashboard.

## 0.2.1 — Bind the default branch as a vault

- The first-run setup now offers to use the repository's default branch (for example main) as the vault root — the simple choice for a dedicated repository — alongside creating a new branch and joining an existing one.
- Branch discovery includes the default branch, so other devices can join a vault that lives there.
- Binding keeps the branch's existing content: files already on the default branch are synced as notes instead of being cleared.
- Concurrent first-time bindings of the same default branch converge: the device that loses the race follows the winner's vault identity.
- The login screen spells out both token paths with GitHub's English UI labels (classic: set Expiration to No expiration; Fine-grained tokens: Only select repositories plus Contents = Read and write) and no longer points at the docs.

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
