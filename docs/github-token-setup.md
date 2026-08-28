# How to get a GitHub token

Constellation Sync connects to GitHub with a **personal access token (PAT)**. You create it once on github.com, paste it into the plugin, and everything else happens automatically. No GitHub App, no OAuth setup, no build variables.

## Recommended: fine-grained token (least privilege)

A fine-grained token can be limited to exactly one repository and one permission class. This is the safest choice.

1. Sign in to GitHub and open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   Direct link: <https://github.com/settings/personal-access-tokens/new>
2. **Token name**: any name you like, for example `Constellation Sync`.
3. **Expiration**: pick a long period (for example 1 year) or a custom date. When the token expires, synchronization stops until you paste a new one, so do not pick 7 days by accident.
4. **Resource owner**: your own account.
5. **Repository access**: choose **Only select repositories** and tick only the dedicated private repository you use for syncing.
6. **Permissions → Repository permissions**:
   - **Contents**: **Read and write**
   - Metadata is switched to **Read-only** automatically; that is required and expected.
   - Leave everything else as "No access". The plugin never needs Administration, Issues, or Webhooks.
7. Click **Generate token** and copy the token (it starts with `github_pat_`).
8. Back in Obsidian: open the Constellation Sync dashboard, paste the token into the token field, and click **Connect GitHub**.

## Fastest: classic token (one click with the plugin)

The classic token page can be pre-filled with the right name and scope.

1. In the plugin's login screen, click **Create a token on GitHub**. The browser opens GitHub with the description and `repo` scope already filled in.
   Manual link: <https://github.com/settings/tokens/new?description=Constellation%20Sync&scopes=repo>
2. **Expiration**: choose **No expiration** so synchronization never stops unexpectedly. If you pick a fixed period, you will need to paste a fresh token when it lapses.
3. Scroll down, click **Generate token**, and copy the token (it starts with `ghp_`).
4. Paste it into the plugin's token field and click **Connect GitHub**.

> Note: the classic `repo` scope grants **read and write access to every repository on your account**, not just the sync repository. If that bothers you, use the fine-grained token above.

## Which one should I use?

| | Fine-grained token | Classic token |
| --- | --- | --- |
| Repository scope | Only the repositories you tick | Every repository on your account |
| Permissions | Contents read/write only | Full `repo` scope |
| Pre-filled creation page | No (a short form to fill) | Yes (button in the plugin) |
| Best for | Long-term use, least privilege | Getting started fastest |

## Security notes

- The token is stored **only** in Obsidian SecretStorage. It is never written to your notes, `data.json`, or Git history.
- You can revoke the token at any time under **Settings → Developer settings → Personal access tokens**; the plugin then simply cannot sync until you paste a new one.
- The plugin needs only Contents read/write. Never grant a token more permissions than that.
- The plugin refuses to synchronize public repositories. Always use a dedicated private repository.
- A private repository controls access, but it is not end-to-end encryption: GitHub and anyone with repository access can read the synchronized files.
- If the token stops working (revoked, expired, or scope removed), the plugin shows a re-authentication prompt; paste a fresh token to continue.
