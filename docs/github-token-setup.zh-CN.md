# 如何获取 GitHub 访问令牌（Token）

Constellation Sync 通过 GitHub **个人访问令牌（Personal Access Token，PAT）** 连接你的私有仓库。你只需要在 github.com 上创建一次，粘贴进插件，其余全部自动完成。无需 GitHub App、无需 OAuth 配置、无需任何构建变量。

## 推荐方式：细粒度令牌（Fine-grained token，权限最小）

细粒度令牌可以精确限制到"某个仓库 + 某一类权限"，是最安全的选择。

1. 登录 GitHub，打开 **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**。
   直达地址：<https://github.com/settings/personal-access-tokens/new>
2. **Token name（令牌名称）**：随意填写，例如 `Constellation Sync`。
3. **Expiration（有效期）**：建议选择 **1 年**或自定义较长日期。令牌过期后同步会停止，需要重新生成并粘贴，所以不要误选 7 天。
4. **Resource owner（资源所有者）**：选择你自己的账号。
5. **Repository access（仓库范围）**：选择 **Only select repositories**，只勾选专用于同步的那个**私有**仓库。
6. **Permissions → Repository permissions（权限）**：
   - **Contents**：设为 **Read and write**（读写）。
   - Metadata 会自动变为 Read-only，这是正常且必需的，插件需要它来列出分支。
   - 其余权限全部保持 **No access**。插件永远不需要 Administration、Issues 或 Webhooks。
7. 点击 **Generate token**，复制以 `github_pat_` 开头的令牌。
8. 回到 Obsidian：打开 Constellation Sync 仪表盘，把令牌粘贴进令牌输入框，点击 **连接 GitHub**。

## 最快方式：经典令牌（Classic token，插件一键直达）

经典令牌的创建页面支持通过链接预填名称和权限范围。

1. 在插件登录页点击 **"在 GitHub 创建令牌"** 按钮，浏览器会打开 GitHub 并预填好名称和 `repo` 权限。
   手动直达：<https://github.com/settings/tokens/new?description=Constellation%20Sync&scopes=repo>
2. **Expiration（有效期）**：建议选择 **No expiration**（永不过期），避免同步定期中断；如果选了固定期限，到期后需要重新粘贴一个新令牌。
3. 滚动到页面底部，点击 **Generate token**，复制以 `ghp_` 开头的令牌。
4. 粘贴到插件的令牌输入框，点击 **连接 GitHub**。

> 注意：经典令牌的 `repo` 权限覆盖你账号下的**所有**仓库（读 + 写），而不仅仅是同步仓库。如果介意这一点，请使用上面的细粒度令牌。

## 我该用哪一种？

| | 细粒度令牌 | 经典令牌 |
| --- | --- | --- |
| 仓库范围 | 只有你勾选的仓库 | 你账号下的所有仓库 |
| 权限 | 仅 Contents 读写 | 整个 `repo` 权限范围 |
| 创建页可预填 | 否（需要手动填写一个短表单） | 是（插件内按钮直达） |
| 适合场景 | 长期使用、注重最小权限 | 想最快开始使用 |

## 安全说明

- 令牌**只**保存在 Obsidian 的 SecretStorage 中，绝不写入笔记文件、`data.json` 或 Git 历史。
- 你随时可以在 **Settings → Developer settings → Personal access tokens** 吊销令牌；吊销后插件只是无法继续同步，粘贴新令牌即可恢复。
- 插件只需要 Contents 读写权限。永远不要给令牌授予比这更多的权限。
- 插件拒绝同步公开仓库，请始终使用专用的私有仓库。
- 私有仓库只控制访问权限，并不等于端到端加密：GitHub 以及拥有仓库权限的人可以读取同步内容。
- 如果令牌失效（被吊销、过期或权限被移除），插件会显示重新认证提示，粘贴一个新令牌即可继续使用。
