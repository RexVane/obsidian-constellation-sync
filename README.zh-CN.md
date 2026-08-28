[English](README.md) | **简体中文**

# Constellation Sync

Constellation Sync 是一个 Obsidian 社区插件，通过 GitHub 私有仓库在多台设备之间同步笔记。一个私有仓库可以承载多个笔记库，每个笔记库使用一个独立的 GitHub 分支。

## 数据模型

- 一个专用的 GitHub 私有仓库可以包含多个笔记库。
- 每个笔记库位于一个非默认分支的根目录中。
- 分支名使用笔记库的共享英文名，例如 `work-notes`。
- `.constellation-sync/vault.json` 保存稳定的 `vaultId`，因此分支改名后其他设备仍能跟随。
- 默认分支只作为仓库入口，不用于存放笔记库数据。
- 可见空目录会使用内部隐藏文件 `.constellation-sync-empty-folder` 表示，使 GitHub 和其他设备能够完整还原笔记库目录结构；目录中出现真实文件后，标记会自动移除。
- 发现远端笔记库时会按稳定 `vaultId` 去重、显示真实 GitHub 分支名，并在其他设备加入时再次校验规范分支，避免误选旧的重复分支。

## 同步规则

插件以最近一次成功同步的共同版本为基线，比较本地和远端分别发生的变化。只有一侧修改时，修改会同步到另一侧；两侧修改不同位置时会尝试合并；修改同一位置、删除与修改冲突、二进制文件或无法安全合并的内容会保留冲突副本并在冲突列表中等待处理。插件不会使用文件修改时间静默覆盖另一侧，也不会把冲突内容直接丢弃。

本地文件只在远端提交成功之后才被改写，因此推送失败时笔记库保持原样。无法在所有平台安全保存的路径会被跳过并列出，而不会拖住其余文件的同步。

## 安全与隐私

GitHub 登录使用 OAuth Device Flow。访问令牌和刷新令牌只保存在 Obsidian SecretStorage 中，不写入笔记库或 Git 提交。私有仓库只控制访问权限，并不等于端到端加密：GitHub 以及拥有仓库权限的人可以读取同步内容。

本公开仓库不包含用户令牌、刷新令牌、GitHub App Client Secret、本地笔记、`.env.local` 或 Obsidian 配置。编译后的 `main.js` 不提交到源码分支，只作为带版本号的 GitHub Release 资产发布。源码检出后会使用项目公开的 OAuth Client ID 和安装地址作为可复现构建默认值；测试其他 GitHub App 时，再从 `.env.example` 创建 `.env.local` 覆盖它们。Client ID 属于公开元数据，但 App Client Secret 绝不能放入插件或 Git 历史。

## 安装开发版

1. 下载或克隆本仓库。
2. 安装 Node.js 20 或更高版本，执行 `npm ci`。
3. 如需测试其他 GitHub App，可复制 `.env.example` 为 `.env.local` 覆盖公开配置；否则直接使用项目默认配置。
4. 执行 `npm run build`。
5. 将 `main.js`、`manifest.json` 和 `styles.css` 复制到 `<笔记库>/.obsidian/plugins/constellation-sync/`，然后在 Obsidian 中启用插件。

本项目采用源码优先的公开发布方式；社区插件 Release 会提供已经配置好的 `main.js`，供 Obsidian 一键安装。源码中的默认值只是公开 OAuth 元数据；插件不需要、也不会接受 Client Secret。

## 开发与验证

1. 复制 `.env.example` 为 `.env.local`，填入测试用 GitHub App 的公开 Client ID 和安装地址。
2. 在构建所用的终端中导出这些环境变量。
3. 执行 `npm install`。
4. 执行 `npm run dev` 进入监听模式构建，或 `npm run check` 运行完整验证套件。

GitHub App 只需要仓库 Contents 的读写权限，并且应该只安装到明确选择的私有仓库。更多配置步骤请参阅 [`docs/github-app-setup.md`](docs/github-app-setup.md) 和 [`docs/testing.md`](docs/testing.md)。

## 状态

当前发布版本为 `0.1.8`：推送失败时笔记库保持原样，单个不可移植的文件名不会拖住整个笔记库，设备只在显式选择后才绑定笔记库分支，设置项开关也已正常渲染为开关。线上 OAuth 集成使用公开的 GitHub App Client ID；插件中不含任何 Client Secret。

## 开源协议

本项目采用 MIT License，详见 [`LICENSE`](LICENSE)。
