# Constellation Sync

Constellation Sync is an Obsidian community plugin for synchronizing multiple vaults through independent branches in one private GitHub repository.

## Data model

- One dedicated private GitHub repository can contain multiple vaults.
- Each vault lives at the root of one non-default branch.
- The branch name is the vault's shared English name, such as `work-notes`.
- `.constellation-sync/vault.json` stores a stable `vaultId`, so devices can follow branch renames safely.
- The default branch is only a repository landing page and is never used as a vault branch.
- Visible empty directories are represented by an internal `.constellation-sync-empty-folder` marker, allowing GitHub and other devices to reconstruct the complete vault folder structure.

## Security

GitHub App authentication uses OAuth Device Flow and repository-scoped Contents permission. Access and refresh tokens are stored only in Obsidian SecretStorage. A private repository controls access, but it is not end-to-end encryption: GitHub and anyone with repository access can read the synchronized files.

This repository intentionally contains no user tokens, refresh tokens, client secrets, local vault data or `.env.local` files. Compiled `main.js` is kept out of the source branch and attached only to versioned GitHub Releases. A clean checkout has the project's public OAuth Client ID and App installation URL as reproducible build defaults; developers can override them with `.env.local` when testing a different GitHub App. A GitHub OAuth Client ID is public metadata; never put the App client secret in the plugin or in Git history.

## Installing the development build

1. Download or clone this repository.
2. Install Node.js 20 or newer and run `npm ci`.
3. Optionally copy `.env.example` to `.env.local` to use a different GitHub App; the public release App is used by default.
4. Run `npm run build`.
5. Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/constellation-sync/`, then enable the plugin in Obsidian.

The public repository is source-first. Community-plugin releases contain the configured `main.js` asset needed for one-click installation. The checked-in release defaults are public OAuth metadata, not credentials; no client secret is required or accepted by the plugin.

## Development

1. Copy `.env.example` to `.env.local` and provide the public client ID and installation URL of a test GitHub App.
2. Export the variables in the shell used for building.
3. Run `npm install`.
4. Run `npm run dev` for a watch build or `npm run check` for the complete verification suite.

The GitHub App needs only repository Contents read/write permission. Enable Device Flow and install it only on explicitly selected private repositories.

## Status

Version `0.1.3` preserves the complete visible vault structure, including empty directories, across desktop and mobile devices. Live OAuth integration uses a public GitHub App Client ID; no client secret is embedded in the plugin.

## 中文说明

Constellation Sync 是一个 Obsidian 社区插件，通过 GitHub 私有仓库在多台设备之间同步笔记。一个私有仓库可以承载多个笔记库，每个笔记库使用一个独立的 GitHub 分支。

### 数据模型

- 一个专用的 GitHub 私有仓库可以包含多个笔记库。
- 每个笔记库位于一个非默认分支的根目录中。
- 分支名使用笔记库的共享英文名，例如 `work-notes`。
- `.constellation-sync/vault.json` 保存稳定的 `vaultId`，因此分支改名后其他设备仍能跟随。
- 默认分支只作为仓库入口，不用于存放笔记库数据。
- 可见空目录会使用内部隐藏文件 `.constellation-sync-empty-folder` 表示，使 GitHub 和其他设备能够完整还原笔记库目录结构；目录中出现真实文件后，标记会自动移除。

### 同步规则

插件以最近一次成功同步的共同版本为基线，比较本地和远端分别发生的变化。只有一侧修改时，修改会同步到另一侧；两侧修改不同位置时会尝试合并；修改同一位置、删除与修改冲突、二进制文件或无法安全合并的内容会保留冲突副本并在冲突列表中等待处理。插件不会使用文件修改时间静默覆盖另一侧，也不会把冲突内容直接丢弃。

### 安全与隐私

GitHub 登录使用 OAuth Device Flow。访问令牌和刷新令牌只保存在 Obsidian SecretStorage 中，不写入笔记库或 Git 提交。私有仓库只控制访问权限，并不等于端到端加密：GitHub 以及拥有仓库权限的人可以读取同步内容。

本公开仓库不包含用户令牌、刷新令牌、GitHub App Client Secret、本地笔记、`.env.local` 或 Obsidian 配置。编译后的 `main.js` 不提交到源码分支，只作为带版本号的 GitHub Release 资产发布。源码检出后会使用项目公开的 OAuth Client ID 和安装地址作为可复现构建默认值；测试其他 GitHub App 时，再从 `.env.example` 创建 `.env.local` 覆盖它们。Client ID 属于公开元数据，但 App Client Secret 绝不能放入插件或 Git 历史。

### 安装开发版

1. 下载或克隆本仓库。
2. 安装 Node.js 20 或更高版本，执行 `npm ci`。
3. 如需测试其他 GitHub App，可复制 `.env.example` 为 `.env.local` 覆盖公开配置；否则直接使用项目默认配置。
4. 执行 `npm run build`。
5. 将 `main.js`、`manifest.json` 和 `styles.css` 复制到 `<笔记库>/.obsidian/plugins/constellation-sync/`，然后在 Obsidian 中启用插件。

本项目采用源码优先的公开发布方式；社区插件 Release 会提供已经配置好的 `main.js`，供 Obsidian 一键安装。源码中的默认值只是公开 OAuth 元数据；插件不需要、也不会接受 Client Secret。

### 开发与验证

```bash
npm install
npm run dev      # 监听模式构建
npm run check    # 类型检查、Lint、测试和生产构建
```

GitHub App 只需要仓库 Contents 的读写权限，并且应该只安装到明确选择的私有仓库。更多配置步骤请参阅 [`docs/github-app-setup.md`](docs/github-app-setup.md) 和 [`docs/testing.md`](docs/testing.md)。

### 开源协议

本项目采用 MIT License，详见 [`LICENSE`](LICENSE)。
