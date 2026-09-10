# How to get a GitHub token

Constellation Sync connects to GitHub with a **personal access token (PAT)**. You create it once on github.com, paste it into the plugin, and everything else happens automatically. No GitHub App, no OAuth setup, no build variables.

## Recommended: fine-grained token (least privilege)

A fine-grained token can be limited to exactly one repository and one permission class. This is the safest choice.

1. Sign in to GitHub and open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   Direct link: <https://github.com/settings/personal-access-tokens/new>
2. **Token name**: any name you like, for example `Constellation Sync`.
3. **Expiration**: pick a long period (for example 1 year) or a custom date. When the token expires, synchronization stops until you paste a new one, so do not pick 7 days by accident.
4. **Resource owner**: your own account.
5. **Repository access**: choose **Only select repositories** and tick only the dedicated repository you use for syncing. A private repository is strongly recommended.
6. **Permissions → Repository permissions**:
   - **Contents**: **Read and write**
   - Metadata is switched to **Read-only** automatically; that is required and expected.
   - Leave everything else as "No access". The plugin never needs Administration, Issues, or Webhooks.
7. Click **Generate token** and copy the token (it starts with `github_pat_`).
8. Back in Obsidian: open the Constellation Sync dashboard, paste the token into the token field, and click **Connect GitHub**.

## Alternative: classic token (broader access)

Classic tokens are supported for compatibility, but the fine-grained token above is the safer default.

1. Open GitHub's classic token form: <https://github.com/settings/tokens/new?description=Constellation%20Sync&scopes=repo>. The link pre-fills the description and `repo` scope.
2. **Expiration**: choose **No expiration** so synchronization never stops unexpectedly. If you pick a fixed period, you will need to paste a fresh token when it lapses.
3. Scroll down, click **Generate token**, and copy the token (it starts with `ghp_`).
4. Paste it into the plugin's token field and click **Connect GitHub**.

> Note: the classic `repo` scope grants **read and write access to every repository on your account**, not just the sync repository. If that bothers you, use the fine-grained token above.

## Which one should I use?

| | Fine-grained token | Classic token |
| --- | --- | --- |
| Repository scope | Only the repositories you tick | Every repository on your account |
| Permissions | Contents read/write only | Full `repo` scope |
| Creation page | Opened by the plugin | Manual compatibility link |
| Best for | Long-term use, least privilege | Existing classic-token workflows |

## Security notes

- The token is stored **only** in Obsidian SecretStorage. It is never written to your notes, `data.json`, or Git history.
- You can revoke the token at any time under **Settings → Developer settings → Personal access tokens**; the plugin then simply cannot sync until you paste a new one.
- The plugin needs only Contents read/write. Never grant a token more permissions than that.
- Private repositories are strongly recommended. Public repositories are supported, but every synchronized file in one is visible to everyone.
- A private repository controls access, but it is not end-to-end encryption: GitHub and anyone with repository access can read the synchronized files.
- If the token stops working (revoked, expired, or scope removed), the plugin shows a re-authentication prompt; paste a fresh token to continue.
