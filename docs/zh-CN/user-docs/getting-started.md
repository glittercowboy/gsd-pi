# GSD 快速开始

GSD 是一个 AI 编程代理，负责规划、执行、验证和交付，让你可以把注意力放在“要构建什么”上。本指南会带你完成 macOS、Windows 和 Linux 的安装，并启动你的第一个会话。

---

## 前置条件

| 要求 | 最低版本 | 推荐版本 |
|------|----------|----------|
| **[Node.js](https://nodejs.org/)** | 22.0.0 | 24 LTS |
| **[Git](https://git-scm.com/)** | 2.20+ | 最新版 |
| **LLM API key** | 任意受支持提供商 | Anthropic（Claude） |

如果你还没有安装 Node.js 或 Git，请按下面对应操作系统的步骤进行。

---

## 按操作系统安装

### macOS

> **下载链接：** [Node.js](https://nodejs.org/) | [Git](https://git-scm.com/download/mac) | [Homebrew](https://brew.sh/)

**第 1 步：安装 Homebrew**（如果已安装可跳过）：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**第 2 步：安装 Node.js 和 Git：**

```bash
brew install node git
```

**第 3 步：验证依赖已安装：**

```bash
node --version   # 应输出 v22.x 或更高
git --version    # 应输出 2.20+
```

**第 4 步：安装 GSD：**

```bash
npm install -g gsd-pi
```

**第 5 步：设置你的 LLM provider：**

```bash
# 选项 A：设置环境变量（推荐 Anthropic）
export ANTHROPIC_API_KEY="sk-ant-..."

# 选项 B：使用内置配置向导
gsd config
```

如果想永久保存这个 key，把 export 语句写入 `~/.zshrc`：

```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
```

所有 20+ provider 的完整配置方式请见 [提供商设置指南](./providers.md)。

**第 6 步：启动 GSD：**

```bash
cd ~/my-project   # 进入任意项目目录
gsd               # 启动一个会话
```

**第 7 步：确认一切正常：**

```bash
gsd --version     # 输出已安装版本
```

进入会话后，输入 `/model` 以确认你的 LLM 已成功连接。

> **Apple Silicon PATH 修复：** 如果安装后找不到 `gsd`，可能是 npm 的全局 bin 目录没有加入 PATH：
> ```bash
> echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc
> source ~/.zshrc
> ```

> **oh-my-zsh 冲突：** oh-my-zsh 的 git 插件定义了 `alias gsd='git svn dcommit'`。可在 `~/.zshrc` 中加入 `unalias gsd 2>/dev/null`，或者改用 `gsd-cli`。

---

### Windows

> **下载链接：** [Node.js](https://nodejs.org/) | [Git for Windows](https://git-scm.com/download/win) | [Windows Terminal](https://aka.ms/terminal)

#### 选项 A：使用 winget（推荐 Windows 10/11）

**第 1 步：安装 Node.js 和 Git：**

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

**第 2 步：重启终端**（关闭并重新打开 PowerShell 或 Windows Terminal）。

**第 3 步：验证依赖已安装：**

```powershell
node --version   # 应输出 v22.x 或更高
git --version    # 应输出 2.20+
```

**第 4 步：安装 GSD：**

```powershell
npm install -g gsd-pi
```

**第 5 步：设置你的 LLM provider：**

```powershell
# 选项 A：设置环境变量（仅当前会话）
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# 选项 B：使用内置配置向导
gsd config
```

如果要永久保存该 key，可在系统设置的环境变量中添加，或者执行：

```powershell
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")
```

所有 20+ provider 的完整配置方式请见 [提供商设置指南](./providers.md)。

**第 6 步：启动 GSD：**

```powershell
cd C:\Users\you\my-project   # 进入任意项目目录
gsd                           # 启动一个会话
```

**第 7 步：确认一切正常：**

```powershell
gsd --version     # 输出已安装版本
```

进入会话后，输入 `/model` 以确认你的 LLM 已成功连接。

#### 选项 B：手动安装

1. 下载并安装 [Node.js LTS](https://nodejs.org/)，安装时勾选 **“Add to PATH”**
2. 下载并安装 [Git for Windows](https://git-scm.com/download/win)，使用默认选项
3. 打开一个**新的**终端，然后继续执行上面的第 3-7 步

> **Windows 提示：**
> - 建议使用 **Windows Terminal** 或 **PowerShell**，体验最佳。Command Prompt 也能用，但颜色支持较弱。
> - 如果 `gsd` 无法识别，先重启终端。Windows 需要新开终端才能读取更新后的 PATH。
> - **WSL2** 也可用，安装 WSL 后，在发行版内部按 Linux 说明继续。

---

### Linux

> **下载链接：** [Node.js](https://nodejs.org/) | [Git](https://git-scm.com/download/linux) | [nvm](https://github.com/nvm-sh/nvm)

先确认你的发行版，然后按对应步骤安装。

#### Ubuntu / Debian

**第 1 步：安装 Node.js 和 Git：**

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

#### Fedora / RHEL / CentOS

**第 1 步：安装 Node.js 和 Git：**

```bash
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf install -y nodejs git
```

#### Arch Linux

**第 1 步：安装 Node.js 和 Git：**

```bash
sudo pacman -S nodejs npm git
```

#### 使用 nvm（任意发行版）

**第 1 步：先安装 nvm，再安装 Node.js：**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc   # 或 ~/.zshrc
nvm install 24
nvm use 24
```

#### 所有发行版：第 2-7 步

**第 2 步：验证依赖已安装：**

```bash
node --version   # 应输出 v22.x 或更高
git --version    # 应输出 2.20+
```

**第 3 步：安装 GSD：**

```bash
npm install -g gsd-pi
```

**第 4 步：设置你的 LLM provider：**

```bash
# 选项 A：设置环境变量（推荐 Anthropic）
export ANTHROPIC_API_KEY="sk-ant-..."

# 选项 B：使用内置配置向导
gsd config
```

如果想永久保存这个 key，把 export 语句写到 `~/.bashrc`（或 `~/.zshrc`）中：

```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc
```

所有 20+ provider 的完整配置方式请见 [提供商设置指南](./providers.md)。

**第 5 步：启动 GSD：**

```bash
cd ~/my-project   # 进入任意项目目录
gsd               # 启动一个会话
```

**第 6 步：确认一切正常：**

```bash
gsd --version     # 输出已安装版本
```

进入会话后，输入 `/model` 以确认你的 LLM 已成功连接。

> **`npm install -g` 遇到权限错误？** 不要用 `sudo npm`。应改为修复 npm 的全局目录：
> ```bash
> mkdir -p ~/.npm-global
> npm config set prefix '~/.npm-global'
> echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
> source ~/.bashrc
> npm install -g gsd-pi
> ```

---

### Docker（任意操作系统）

> **下载链接：** [Docker Desktop](https://www.docker.com/products/docker-desktop/)

如果你不想在宿主机安装 Node.js，可以在隔离沙箱中运行 GSD。

**第 1 步：安装 Docker Desktop**（要求 4.58+）。

**第 2 步：克隆 GSD 仓库：**

```bash
git clone https://github.com/gsd-build/gsd-2.git
cd gsd-2/docker
```

**第 3 步：创建并进入沙箱：**

```bash
docker sandbox create --template . --name gsd-sandbox
docker sandbox exec -it gsd-sandbox bash
```

**第 4 步：设置 API key 并运行 GSD：**

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
gsd auto "implement the feature described in issue #42"
```

完整的配置、资源限制和 compose 文件请见 [Docker Sandbox 文档](../../../docker/README.md)。

---

## 安装之后

### 选择模型

完成 provider 设置后，GSD 会自动选择一个默认模型。你可以在会话中随时切换：

```
/model
```

也可以在偏好设置中按阶段配置模型，详见 [配置](./configuration.md)。

---

## 两种工作方式

### 步骤模式 — `/gsd`

在会话内输入 `/gsd`。GSD 会一次执行一个工作单元，并在每一步之间暂停，通过向导展示刚完成了什么、下一步是什么。

- **没有 `.gsd/` 目录**：启动讨论流程，先收集你的项目愿景
- **已有 milestone，但没有 roadmap**：讨论或研究该 milestone
- **roadmap 已存在，仍有待完成的 slices**：规划下一个 slice 或执行一个 task
- **进行到一半的 task**：从上次停下的地方继续

步骤模式会让你始终留在回路中，在每一步之间查看和确认输出。

### 自动模式 — `/gsd auto`

输入 `/gsd auto` 后就可以离开。GSD 会自主完成 research、planning、execution、verification、commit，并持续推进每个 slice，直到 milestone 完成。

```
/gsd auto
```

完整细节请见 [自动模式](./auto-mode.md)。

---

## 推荐工作流：两个终端

一个终端跑自动模式，另一个终端负责引导和干预。

**终端 1：让它构建**

```bash
gsd
/gsd auto
```

**终端 2：在它工作时进行引导**

```bash
gsd
/gsd discuss    # 讨论架构决策
/gsd status     # 查看进度
/gsd queue      # 排队下一个 milestone
```

两个终端都会读写同一套 `.gsd/` 文件。你在终端 2 里做出的决策，会在下一个阶段边界被自动拾取。

---

## GSD 如何组织工作

```
Milestone  →  一个可交付版本（4-10 个 slice）
  Slice    →  一个可演示的垂直能力（1-7 个 task）
    Task   →  一个适合单个上下文窗口的工作单元
```

铁律是：**一个 task 必须能装进一个上下文窗口。** 装不下，就说明它应该拆成两个 task。

所有状态都保存在 `.gsd/` 中：

```
.gsd/
  PROJECT.md          — 项目当前是什么
  REQUIREMENTS.md     — 需求契约
  DECISIONS.md        — 追加式架构决策记录
  KNOWLEDGE.md        — 跨会话规则与模式
  STATE.md            — 一眼可见的状态摘要
  milestones/
    M001/
      M001-ROADMAP.md — 带依赖关系的 slice 计划
      slices/
        S01/
          S01-PLAN.md     — task 拆解
          S01-SUMMARY.md  — 实际发生了什么
```

---

## VS Code 扩展

GSD 也提供 VS Code 扩展。你可以从扩展市场安装（publisher: FluxLabs），或者在 VS Code 扩展面板中直接搜索 “GSD”：

- **`@gsd` 聊天参与者**：在 VS Code Chat 中直接与 agent 对话
- **侧边栏仪表板**：显示连接状态、模型信息、Token 使用量
- **完整命令面板**：启动 / 停止 agent、切换模型、导出会话

CLI（`gsd-pi`）需要先安装好，扩展会通过 RPC 与其连接。

---

## Web 界面

GSD 也提供一个基于浏览器的可视化项目管理界面：

```bash
gsd --web
```

详见 [Web 界面](./web-interface.md)。

---

## 恢复会话

```bash
gsd --continue    # 或 gsd -c
```

会恢复当前目录最近一次会话。

浏览所有保存过的会话：

```bash
gsd sessions
```

---

## 更新 GSD

GSD 每 24 小时检查一次更新，并在启动时提示。你也可以手动更新：

```bash
npm update -g gsd-pi
```

或者在会话中执行：

```
/gsd update
```

---

## 快速排障

| 问题 | 解决方式 |
|------|----------|
| `command not found: gsd` | 把 npm 全局 bin 目录加入 PATH（见上面的系统说明） |
| `gsd` 实际执行了 `git svn dcommit` | oh-my-zsh 冲突，执行 `unalias gsd` 或改用 `gsd-cli` |
| `npm install -g gsd-pi` 权限错误 | 修复 npm prefix（见 Linux 说明）或改用 nvm |
| 无法连接到 LLM | 用 `gsd config` 检查 API key，并确认网络可用 |
| `gsd` 启动时卡住 | 检查 Node.js 版本：`node --version`（需要 22+） |

更多问题见 [故障排查](./troubleshooting.md)。

---

## 下一步

- [自动模式](./auto-mode.md)：深入理解自主执行
- [配置](./configuration.md)：模型选择、超时和预算
- [命令参考](./commands.md)：所有命令和快捷键
- [提供商设置](./providers.md)：每个 provider 的详细配置
- [团队协作](./working-in-teams.md)：多开发者工作流
