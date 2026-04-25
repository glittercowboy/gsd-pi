# 故障排查

## `/gsd doctor`

内置诊断工具会校验 `.gsd/` 的完整性：

```
/gsd doctor
```

它会检查：

- 文件结构和命名约定
- roadmap ↔ slice ↔ task 的引用完整性
- 完成状态是否一致
- Git worktree 健康状态（仅 worktree 和 branch 模式；none 模式跳过）
- 过期锁文件和孤儿运行时记录

## 常见问题

### 自动模式在同一个单元上循环

**症状：** 同一个工作单元（例如 `research-slice` 或 `plan-slice`）被反复派发，直到触发 dispatch 上限。

**原因：**

- 崩溃后的缓存过期：内存中的文件列表没有反映新产物
- LLM 没有生成预期的 artifact 文件

**解决：** 先运行 `/gsd doctor` 修复状态，然后执行 `/gsd auto` 恢复。如果问题持续存在，检查预期 artifact 文件是否确实已经写到磁盘。

### 自动模式因 “Loop detected” 停止

**原因：** 同一个单元连续两次没有生成预期 artifact。

**解决：** 检查 task plan 是否足够清晰。如果 plan 存在歧义，先手动澄清，再执行 `/gsd auto` 恢复。

### Worktree 中出现了错误文件

**症状：** Planning 产物或代码被写到了错误目录。

**原因：** LLM 把内容写回了主仓库，而不是 worktree。

**解决：** 该问题已在 v2.14+ 修复。如果你仍在旧版本，请更新。现在 dispatch prompt 已包含明确的工作目录指令。

### 安装后出现 `command not found: gsd`

**症状：** `npm install -g gsd-pi` 成功，但系统找不到 `gsd`。

**原因：** npm 的全局 bin 目录没有加入 shell 的 `$PATH`。

**解决：**

```bash
# 找出 npm 安装二进制的目录
npm prefix -g
# 输出：/opt/homebrew（Apple Silicon）或 /usr/local（Intel Mac）

# 如果缺失，把 bin 目录加入 PATH
echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**临时方案：** 直接执行 `npx gsd-pi`，或使用 `$(npm prefix -g)/bin/gsd`。

**常见原因：**

- **Homebrew Node**：理论上 `/opt/homebrew/bin` 应该在 PATH 里，但如果 shell profile 没有初始化 Homebrew，就可能缺失
- **版本管理器（nvm、fnm、mise）**：全局 bin 路径是按版本区分的，需确保版本管理器正确初始化
- **oh-my-zsh**：`gitfast` 插件会把 `gsd` alias 到 `git svn dcommit`。可通过 `alias gsd` 检查，并在需要时取消 alias

### `npm install -g gsd-pi` 失败

**常见原因：**

- 缺少 workspace packages：已在 v2.10.4+ 修复
- Linux 上 `postinstall` 卡住（Playwright `--with-deps` 触发 sudo）：已在 v2.3.6+ 修复
- Node.js 版本过低：要求 ≥ 22.0.0

### 自动模式中的 provider 错误

**症状：** 自动模式因为 provider 错误暂停（限流、服务端错误、认证失败）。

**GSD 的处理方式（v2.26）：**

| 错误类型 | 自动恢复？ | 延迟 |
|----------|------------|------|
| Rate limit（429、`too many requests`） | ✅ 是 | `retry-after` 头或默认 60 秒 |
| Server error（500、502、503、`overloaded`） | ✅ 是 | 30 秒 |
| Auth / billing（`unauthorized`、`invalid key`） | ❌ 否 | 需要手动恢复 |

对于瞬时错误，GSD 会短暂停顿后自动继续。对于永久性错误，建议配置 fallback models：

```yaml
models:
  execution:
    model: claude-sonnet-4-6
    fallbacks:
      - openrouter/minimax/minimax-m2.5
```

**Headless 模式：** `gsd headless auto` 在进程崩溃时会自动重启整个进程（默认 3 次，带指数退避）。与 provider 错误自动恢复配合后，能支持真正的夜间无人值守运行。

常见的 provider 配置问题（role 错误、streaming 错误、model ID 不匹配）见 [Provider 设置指南：常见坑点](./providers.md#common-pitfalls)。

### 达到预算上限

**症状：** 自动模式因 “Budget ceiling reached” 暂停。

**解决：** 提高偏好设置中的 `budget_ceiling`，或者切换到 `budget` token profile 降低每个工作单元成本，然后再执行 `/gsd auto` 恢复。

### 过期锁文件

**症状：** 自动模式无法启动，提示另一个会话正在运行。

**解决：** GSD 会自动检测过期锁：如果持有锁的 PID 已死亡，则在下次 `/gsd auto` 时清理并重新获取锁。它也会处理 `proper-lockfile` 崩溃后遗留的 `.gsd.lock/` 目录。如果自动恢复失败，可手动删除 `.gsd/auto.lock` 和 `.gsd.lock/`：

```bash
rm -f .gsd/auto.lock
rm -rf "$(dirname .gsd)/.gsd.lock"
```

### Git merge 冲突

**症状：** Worktree merge 在 `.gsd/` 文件上失败。

**解决：** GSD 会自动解决 `.gsd/` 运行时文件上的冲突。对于代码文件的内容冲突，LLM 会先获得一次 fix-merge 会话进行自动修复；若失败，则需要手动解决。

### Pre-dispatch 提示 milestone integration branch 已不存在

**症状：** 自动模式或 `/gsd doctor` 报告某个 milestone 记录的 integration branch 已经不在 git 中。

**这意味着什么：** 该 milestone 的 `.gsd/milestones/<MID>/<MID>-META.json` 里仍然记录着启动时的 branch，但该 branch 之后被重命名或删除了。

**当前行为：**

- 如果 GSD 能确定性地恢复到一个安全 branch，就不会再直接 hard-stop 自动模式
- 安全回退的顺序是：
  - 显式配置且存在的 `git.main_branch`
  - 仓库自动检测到的默认 integration branch（例如 `main` 或 `master`）
- 在这种情况下，`/gsd doctor` 会给出 warning，而 `/gsd doctor fix` 会把过期的 metadata 改写为当前有效 branch
- 如果无法确定安全回退 branch，GSD 仍会阻止继续运行

**解决：**

- 先执行 `/gsd doctor fix`，在安全回退很明显时自动改写过期 metadata
- 如果 GSD 仍然阻塞，则请重新创建缺失 branch，或更新 git 偏好设置，让 `git.main_branch` 指向一个真实存在的 branch

### 写 `.gsd/` 文件时出现瞬时 `EBUSY` / `EPERM` / `EACCES`

**症状：** 在 Windows 上，自动模式或 doctor 在更新 `.gsd/` 文件时偶发 `EBUSY`、`EPERM` 或 `EACCES`。

**原因：** 杀毒软件、索引器、编辑器或文件监视器可能会在 GSD 执行原子 rename 的瞬间，短暂锁住目标文件或临时文件。

**当前行为：** GSD 现在会对这类瞬时 rename 失败做短时、有上界的退避重试；这样既能覆盖短暂锁竞争，也不会因为真正的文件系统问题而无限挂起。

**解决：**

- 重新执行操作；大多数瞬时锁竞争会很快自行解除
- 如果错误持续，关闭可能占用该文件的工具后再试
- 如果反复失败，运行 `/gsd doctor`，确认仓库状态依旧健康，并记录具体路径与错误码

### Node v24 Web 启动失败

**症状：** 在 Node v24 上执行 `gsd --web` 时，报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。

**原因：** Node v24 修改了对 `node_modules` 的 type stripping 行为，导致 Next.js Web 构建失败。

**解决：** 已在 v2.42.0+ 修复（#1864）。升级到最新版本。

### 孤儿 Web server 进程

**症状：** `gsd --web` 因端口 3000 已被占用而失败，但实际上并没有运行中的 GSD 会话。

**原因：** 上一次 Web server 退出时未能清理进程。

**解决：** 已在 v2.42.0+ 修复。现在 GSD 会自动清理过期的 Web server 进程。如果你还在旧版本，可手动终止孤儿进程：`lsof -ti:3000 | xargs kill`。

### 非 JS 项目被 worktree health check 阻挡

**症状：** 在不使用 Node.js 的项目（例如 Rust、Go、Python）中，worktree health check 失败或阻塞自动模式。

**原因：** 在 v2.42.0 之前，worktree health check 只识别 JavaScript 生态。

**解决：** 已在 v2.42.0+ 修复（#1860）。现在 health check 已支持 17+ 生态。升级到最新版本。

### 德语 / 非英语 locale 下的 git 错误

**症状：** 当系统 locale 不是英语（例如德语）时，Git 命令失败或输出异常。

**原因：** GSD 之前假设 git 输出永远是英文。

**解决：** 已在 v2.42.0+ 修复。现在所有 git 命令都会强制 `LC_ALL=C`，从而无论系统 locale 如何，都保证 git 输出一致为英文。

## MCP Client 问题

### `mcp_servers` 显示没有已配置 servers

**症状：** `mcp_servers` 报告没有配置任何 server。

**常见原因：**

- 当前项目里不存在 `.mcp.json` 或 `.gsd/mcp.json`
- 配置文件不是合法 JSON
- 你是在另一个项目目录中配置的 server，但当前启动 GSD 的目录不同

**解决：**

- 把 server 配置加到 `.mcp.json` 或 `.gsd/mcp.json`
- 确认文件能被正常解析为 JSON
- 重新执行 `mcp_servers(refresh=true)`

### `mcp_discover` 超时

**症状：** `mcp_discover` 因超时失败。

**常见原因：**

- Server 进程启动了，但没有完成 MCP 握手
- 配置的命令指向一个启动时会卡住的脚本
- Server 正在等待某个不可用依赖或后端服务

**解决：**

- 在 GSD 外部直接运行该命令，确认 server 能真正启动
- 检查后端 URL 或依赖服务是否可达
- 如果是本地自定义 server，确认它使用的是 MCP SDK 或正确的 stdio 协议实现

### `mcp_discover` 报 connection closed

**症状：** `mcp_discover` 立即失败，并提示连接被关闭。

**常见原因：**

- 可执行文件路径错误
- 脚本路径错误
- 缺失运行时依赖
- Server 在响应前就崩溃了

**解决：**

- 确认 `command` 和 `args` 路径正确且尽量使用绝对路径
- 手动运行命令，查看导入 / 运行时错误
- 检查配置中的解释器或运行时在当前机器上是否存在

### `mcp_call` 因缺少必填参数失败

**症状：** MCP tool 已成功发现，但调用时因缺少必填字段而校验失败。

**常见原因：**

- 调用形状写错了
- 目标 server 的 tool schema 已更新
- 你调用的是旧 server 定义或旧分支构建

**解决：**

- 重新执行 `mcp_discover(server="name")`，确认实际要求的参数名
- 按 `mcp_call(server="name", tool="tool_name", args={...})` 的形式调用
- 如果你正在开发 GSD 本身，在 schema 变更后重新执行 `npm run build`

### 本地 stdio server 手动可用，但在 GSD 中不可用

**症状：** 手动执行 server 命令没有问题，但 GSD 连接不上。

**常见原因：**

- Server 依赖某些 GSD 不会继承的 shell 状态
- 相对路径只有在另一个 working directory 中才成立
- 需要的环境变量存在于你的 shell 中，但没有写进 MCP 配置

**解决：**

- 对 `command` 和脚本参数都使用绝对路径
- 把所需环境变量写进 MCP 配置的 `env` 块
- 有必要时，在 server 定义里显式设置 `cwd`

### Session lock 被另一个终端中的 `/gsd` 抢走

**症状：** 在第二个终端运行 `/gsd`（step mode）时，正在运行的自动模式会话失去了锁。

**解决：** 已在 v2.36.0 修复。现在裸 `/gsd` 不会再从运行中的自动模式会话手里抢 session lock。升级到最新版本。

### Worktree 中的提交落到了 main，而不是 `milestone/<MID>` 分支

**症状：** 自动模式在 worktree 中提交时，最终落在了 `main`，而不是 `milestone/<MID>`。

**解决：** 已在 v2.37.1 修复。现在 dispatch 前会重新校正 CWD，并在失败时清理过期 merge 状态。升级到最新版本。

### Extension loader 因 subpath export 错误而失败

**症状：** 扩展加载时报 `Cannot find module`，并且错误信息引用了 npm subpath exports。

**原因：** Extension loader 中的动态导入过去无法解析 npm subpath exports（例如 `@pkg/foo/bar`）。

**解决：** 已在 v2.38+ 修复。现在 extension loader 会自动解析 npm subpath exports，并为动态导入创建 `node_modules` symlink。升级到最新版本。

## 恢复流程

### 重置自动模式状态

```bash
rm .gsd/auto.lock
rm .gsd/completed-units.json
```

然后执行 `/gsd auto`，从当前磁盘状态重新开始。

### 重置路由历史

如果自适应模型路由给出了糟糕的结果，可以清空路由历史：

```bash
rm .gsd/routing-history.json
```

### 完整重建状态

```
/gsd doctor
```

Doctor 会从磁盘上的 plan 和 roadmap 文件重建 `STATE.md`，并修复检测到的不一致项。

## 获取帮助

- **GitHub Issues：** [github.com/gsd-build/GSD-2/issues](https://github.com/gsd-build/GSD-2/issues)
- **Dashboard：** `Ctrl+Alt+G` 或 `/gsd status`，查看实时诊断信息
- **Forensics：** `/gsd forensics`，用于对自动模式失败做结构化事后分析
- **Session logs：** `.gsd/activity/` 中包含用于崩溃取证的 JSONL 会话转储

## iTerm2 专属问题

### Ctrl+Alt 快捷键触发了错误动作（例如 Ctrl+Alt+G 打开了外部编辑器，而不是 GSD dashboard）

**症状：** 按下 Ctrl+Alt+G 后，会触发外部编辑器提示（Ctrl+G），而不是 GSD dashboard。其它 Ctrl+Alt 快捷键也表现得像它们对应的 Ctrl-only 快捷键。

**原因：** iTerm2 默认的 Left Option Key 设置是 “Normal”，这会吞掉 Ctrl+Alt 组合中的 Alt 修饰键。终端实际只收到了 Ctrl，所以 Ctrl+Alt+G 最终变成 Ctrl+G。

**解决：** 在 iTerm2 中进入 **Profiles → Keys → General**，把 **Left Option Key** 改成 **Esc+**。这样 Alt / Option 会发送 escape 前缀，终端应用就能正确识别 Ctrl+Alt 快捷键。

## Windows 专属问题

### Windows 上 LSP 返回 ENOENT（MSYS2 / Git Bash）

**症状：** LSP 初始化因 `ENOENT` 失败，或者把 `/c/Users/...` 这类 POSIX 路径错误地解析为 `C:\Users\...`。

**原因：** MSYS2 / Git Bash 中的 `which` 命令返回的是 POSIX 风格路径，而 Node.js 的 `spawn()` 无法正确解析。

**解决：** 已在 v2.29+ 修复，Windows 现在改用 `where.exe`。升级到最新版本。

### 构建 WXT / 浏览器扩展时出现 EBUSY

**症状：** 构建浏览器扩展时出现 `EBUSY: resource busy or locked, rmdir .output/chrome-mv3`。

**原因：** Chromium 浏览器仍然从构建输出目录加载着该扩展，导致目录无法删除。

**解决：** 关闭浏览器中的该扩展，或者在 WXT 配置里使用不同的 `outDirTemplate`，避开被锁住的目录。

## 数据库问题

### “GSD database is not available”

**症状：** `gsd_decision_save`（及其别名 `gsd_save_decision`）、`gsd_requirement_update`（及其别名 `gsd_update_requirement`）或 `gsd_summary_save`（及其别名 `gsd_save_summary`）报这个错误。

**原因：** SQLite 数据库未初始化。这个问题会出现在 v2.29 之前的手动 `/gsd` 会话（非自动模式）中。

**解决：** 已在 v2.29+ 修复。现在数据库会在第一次 tool call 时自动初始化。升级到最新版本。

## Verification 问题

### Verification gate 因 shell 语法错误失败

**症状：** 在 verification 阶段出现 `stderr: /bin/sh: 1: Syntax error: "(" unexpected`。

**原因：** 某个描述性字符串（例如 `All 10 checks pass (build, lint)`）被误当成 shell 命令执行。这通常发生在 task plans 的 `verify:` 字段里写了 prose，而不是实际命令。

**解决：** 已在 v2.29+ 修复，现在偏好命令会先通过 `isLikelyCommand()` 过滤。请确保偏好中的 `verification_commands` 只包含合法 shell 命令，而不是文字描述。

## LSP（Language Server Protocol）

### “LSP isn't available in this workspace”

GSD 会根据项目文件自动检测 language servers（例如 `package.json` → TypeScript、`Cargo.toml` → Rust、`go.mod` → Go）。如果没有检测到 server，agent 会跳过 LSP 功能。

**查看状态：**

```
lsp status
```

它会显示哪些 servers 已经激活；如果一个都没找到，也会说明原因，包括发现了哪些项目标记、但缺失了哪些 server 命令。

**常见修复方式：**

| 项目类型 | 安装命令 |
|----------|----------|
| TypeScript / JavaScript | `npm install -g typescript-language-server typescript` |
| Python | `pip install pyright` 或 `pip install python-lsp-server` |
| Rust | `rustup component add rust-analyzer` |
| Go | `go install golang.org/x/tools/gopls@latest` |

安装完成后，执行 `lsp reload` 即可重新检测，无需重启 GSD。

## Notifications

<a id="notifications-not-appearing-on-macos"></a>
### macOS 上通知不显示

**症状：** 偏好中已设置 `notifications.enabled: true`，但自动模式期间没有任何桌面通知（没有 milestone 完成提示、预算预警或错误通知），同时日志里也没有报错。

**原因：** GSD 在 macOS 上会把 `osascript display notification` 作为回退方案。这个命令的通知归属你的终端应用（Ghostty、iTerm2、Alacritty、Kitty、Warp 等）。如果该终端应用在 System Settings → Notifications 中没有权限，macOS 会静默丢弃通知，而 `osascript` 仍然返回 0，不会报错。

很多终端应用只有在成功送出过至少一条通知后，才会出现在通知设置面板里，这就形成了“先能通知，系统才给你配置通知”的鸡生蛋蛋生鸡问题。

**推荐修复方式：** 安装 `terminal-notifier`，它会注册为独立的 Notification Center 应用：

```bash
brew install terminal-notifier
```

GSD 在检测到 `terminal-notifier` 可用时会自动优先使用它。首次使用时，macOS 会弹出通知权限请求，这是预期行为。

**替代修复方式：** 进入 **System Settings → Notifications**，为你的终端应用启用通知。如果终端应用不在列表中，可以先在 Terminal.app 中手动发送一条测试通知，注册出 “Script Editor”：

```bash
osascript -e 'display notification "test" with title "GSD"'
```

**验证：** 完成任一修复后，用下面命令测试：

```bash
terminal-notifier -title "GSD" -message "working!" -sound Glass
```
