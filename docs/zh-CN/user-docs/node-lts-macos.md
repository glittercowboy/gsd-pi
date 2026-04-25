# 在 macOS 上通过 Homebrew 固定 Node.js LTS 版本

如果你是通过 Homebrew 安装 Node.js（`brew install node`），那你跟踪的是**当前最新正式版本**，其中可能包含奇数版本的开发分支（例如 23.x、25.x）。这些版本并不是 LTS，可能带来破坏性变更或稳定性问题。

GSD 要求 Node.js **v22 或更高版本**，并且在 **LTS（偶数版本）** 上运行效果最好。本指南展示如何用 Homebrew 固定到 Node 24 LTS。

## 检查当前版本

```bash
node --version
```

如果输出的是奇数主版本号（例如 `v23.x`、`v25.x`），说明你当前使用的是开发版。

## 安装 Node 24 LTS

Homebrew 为 LTS 版本提供了带版本号的 formula：

```bash
# 取消当前版本（可能不是 LTS）的链接
brew unlink node

# 安装 Node 24 LTS
brew install node@24

# 将它设为默认版本
brew link --overwrite node@24
```

验证：

```bash
node --version
# 应显示 v24.x.x
```

## 为什么要固定到 LTS？

- **稳定性**：LTS 版本会在 30 个月内持续收到 bug 修复和安全更新
- **兼容性**：包括 GSD 在内的 npm 包通常都会优先测试 LTS 版本
- **可预期**：`brew upgrade` 不会把你突然升级到不稳定的开发版

## 防止误升级

默认情况下，`brew upgrade` 会升级所有包，这可能让你离开固定版本。可以把对应 formula pin 住：

```bash
brew pin node@24
```

如果以后想取消固定：

```bash
brew unpin node@24
```

## 在多个版本之间切换

如果你需要同时使用多个 Node 版本（例如 22 和 24），更推荐使用版本管理器：

- **[nvm](https://github.com/nvm-sh/nvm)**：`nvm install 24 && nvm use 24`
- **[fnm](https://github.com/Schniz/fnm)**：`fnm install 24 && fnm use 24`（更快，基于 Rust）
- **[mise](https://mise.jdx.dev/)**：`mise use node@24`（多语言版本管理器）

这些工具允许你通过 `.node-version` 或 `.nvmrc` 为不同项目设置独立的 Node 版本。

## 验证 GSD 是否正常工作

固定版本后，执行：

```bash
node --version   # v24.x.x
npm install -g gsd-pi
gsd --version
```
