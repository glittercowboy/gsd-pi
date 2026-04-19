# 配置

GSD 偏好设置保存在 `~/.gsd/PREFERENCES.md`（全局）或 `.gsd/PREFERENCES.md`（项目级）中。可以通过 `/gsd prefs` 进行交互式管理。

## `/gsd prefs` 命令

| 命令 | 说明 |
|------|------|
| `/gsd prefs` | 打开全局偏好设置向导（默认） |
| `/gsd prefs global` | 全局偏好设置交互向导（`~/.gsd/PREFERENCES.md`） |
| `/gsd prefs project` | 项目偏好设置交互向导（`.gsd/PREFERENCES.md`） |
| `/gsd prefs status` | 显示当前偏好文件、合并后的值以及 skill 解析状态 |
| `/gsd prefs wizard` | `/gsd prefs global` 的别名 |
| `/gsd prefs setup` | `/gsd prefs wizard` 的别名；若偏好文件不存在会自动创建 |
| `/gsd prefs import-claude` | 将 Claude marketplace plugins 和 skills 以命名空间化的 GSD 组件形式导入 |
| `/gsd prefs import-claude global` | 导入到全局作用域 |
| `/gsd prefs import-claude project` | 导入到项目作用域 |

## 偏好文件格式

偏好设置使用 markdown 文件中的 YAML frontmatter：

```yaml
---
version: 1
models:
  research: claude-sonnet-4-6
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
skill_discovery: suggest
auto_supervisor:
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
budget_ceiling: 50.00
token_profile: balanced
---
```

## 全局与项目偏好

| 作用域 | 路径 | 适用范围 |
|--------|------|----------|
| 全局 | `~/.gsd/PREFERENCES.md` | 所有项目 |
| 项目 | `.gsd/PREFERENCES.md` | 仅当前项目 |

**合并规则：**

- **标量字段**（`skill_discovery`、`budget_ceiling`）：如果项目级定义了，则项目级优先
- **数组字段**（`always_use_skills` 等）：拼接，顺序为全局在前、项目在后
- **对象字段**（`models`、`git`、`auto_supervisor`）：浅合并，项目级按 key 覆盖

<a id="global-api-keys-gsd-config"></a>
## 全局 API Keys（`/gsd config`）

工具 API keys 会全局保存在 `~/.gsd/agent/auth.json` 中，并自动应用到所有项目。只需用 `/gsd config` 配置一次，无需在每个项目里维护 `.env`。

```bash
/gsd config
```

这会打开一个交互式向导，显示哪些 key 已配置、哪些仍缺失。你可以选择一个工具并输入相应的 key。

### 支持的 keys

| 工具 | 环境变量 | 用途 | 获取地址 |
|------|----------|------|----------|
| Tavily Search | `TAVILY_API_KEY` | 为非 Anthropic models 提供 Web 搜索 | [tavily.com/app/api-keys](https://tavily.com/app/api-keys) |
| Brave Search | `BRAVE_API_KEY` | 为非 Anthropic models 提供 Web 搜索 | [brave.com/search/api](https://brave.com/search/api) |
| Context7 Docs | `CONTEXT7_API_KEY` | 库文档检索 | [context7.com/dashboard](https://context7.com/dashboard) |

### 工作方式

1. `/gsd config` 会把 keys 保存到 `~/.gsd/agent/auth.json`
2. 每次会话启动时，`loadToolApiKeys()` 都会读取该文件并设置环境变量
3. 这些 keys 对所有项目生效，无需单独配置
4. 环境变量（例如 `export BRAVE_API_KEY=...`）优先级高于保存下来的 keys
5. Anthropic models 不需要 Brave/Tavily，因为它们自带 Web 搜索

## MCP Servers

GSD 可以连接配置在项目文件中的外部 MCP servers。这适合接入本地工具、内部 API、自托管服务，或者那些未作为 GSD 原生扩展内置的集成。

### 配置文件位置

GSD 会从以下项目本地路径读取 MCP client 配置：

- `.mcp.json`
- `.gsd/mcp.json`

如果两个文件都存在，会按 server 名称做合并，先找到的定义优先。通常建议：

- 把你愿意提交到仓库的共享 MCP 配置放在 `.mcp.json`
- 把仅本机使用、不希望共享的 MCP 配置放在 `.gsd/mcp.json`

### 支持的 transport

| Transport | 配置形状 | 适用场景 |
|-----------|----------|----------|
| `stdio` | `command` + 可选 `args`、`env`、`cwd` | 启动本地 MCP server 进程 |
| `http` | `url` | 连接到已经运行中的 MCP server |

### 示例：stdio server

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "/absolute/path/to/python3",
      "args": ["/absolute/path/to/server.py"],
      "env": {
        "API_URL": "http://localhost:8000"
      }
    }
  }
}
```

### 示例：HTTP server

```json
{
  "mcpServers": {
    "my-http-server": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

### 验证一个 server

添加配置后，可以在 GSD 会话中这样验证：

```text
mcp_servers
mcp_discover(server="my-server")
mcp_call(server="my-server", tool="<tool_name>", args={...})
```

推荐验证顺序：

1. `mcp_servers`：确认 GSD 能看到配置文件并正确解析 server 条目
2. `mcp_discover`：确认 server 进程能启动，并能响应 `tools/list`
3. `mcp_call`：确认至少有一个真实 tool 可以成功调用

### 说明

- 尽量为本地可执行文件和脚本使用绝对路径
- 对于 `stdio` servers，优先在 MCP 配置里显式设置需要的环境变量，而不是依赖交互式 shell profile
- GSD 和 `gsd-mcp-server` 都会自动加载保存在 `~/.gsd/agent/auth.json` 中的 model / tool keys，因此 MCP 配置可以安全地通过 `${ENV_VAR}` 占位符引用这些值，而不必提交原始凭据
- 如果某个 server 是团队共享且适合提交到仓库，通常更适合放在 `.mcp.json`
- 如果某个 server 依赖本机路径、个人服务或本地 secrets，更适合放在 `.gsd/mcp.json`

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GSD_HOME` | `~/.gsd` | 全局 GSD 目录。除非单独覆盖，否则其它路径都从这里派生。影响偏好、skills、sessions 以及项目状态。（v2.39） |
| `GSD_PROJECT_ID` | （自动哈希） | 覆盖自动生成的项目身份哈希。这样项目状态会写入 `$GSD_HOME/projects/<GSD_PROJECT_ID>/`，而不是计算出的哈希目录。适用于 CI/CD 或多个克隆共享状态。（v2.39） |
| `GSD_STATE_DIR` | `$GSD_HOME` | 项目状态根目录。控制 `projects/<repo-hash>/` 的创建位置。对项目状态的优先级高于 `GSD_HOME`。 |
| `GSD_CODING_AGENT_DIR` | `$GSD_HOME/agent` | agent 目录，包含托管资源、扩展和 auth。对 agent 相关路径的优先级高于 `GSD_HOME`。 |
| `GSD_ALLOWED_COMMAND_PREFIXES` | （内置列表） | 允许用于 `!command` 值解析的命令前缀，逗号分隔。会覆盖 settings.json 中的 `allowedCommandPrefixes`。见 [自定义模型：命令允许列表](custom-models.md#command-allowlist)。 |
| `GSD_FETCH_ALLOWED_URLS` | （无） | 对 `fetch_page` URL block 免检的 hostnames，逗号分隔。会覆盖 settings.json 中的 `fetchAllowedUrls`。见 [URL Blocking](#url-blocking-fetch_page)。 |

## 全部设置

### `models`

按阶段选择 model。每个 key 都可以是一个 model 字符串，或者是带 fallbacks 的对象。

```yaml
models:
  research: claude-sonnet-4-6
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
  execution: claude-sonnet-4-6
  execution_simple: claude-haiku-4-5-20250414
  completion: claude-sonnet-4-6
  subagent: claude-sonnet-4-6
```

**阶段键：** `research`、`planning`、`execution`、`execution_simple`、`completion`、`subagent`

- `execution_simple`：用于被 [complexity router](./token-optimization.md#complexity-based-task-routing) 判断为 “simple” 的 task
- `subagent`：委派给 subagent 的 task 所使用的 model（scout、researcher、worker）
- 指定 provider：使用 `provider/model` 格式（例如 `bedrock/claude-sonnet-4-6`），或者在对象格式里额外写 `provider` 字段
- 省略某个 key 时，会使用当前 active model

### 自定义 Model 定义（`models.json`）

你可以在 `~/.gsd/agent/models.json` 里定义自定义 models 和 providers。这允许你添加默认注册表里没有的 models，适合自托管 endpoints（Ollama、vLLM、LM Studio）、微调模型、代理，或者刚发布的新 provider。

GSD 读取 `models.json` 的顺序如下：

1. `~/.gsd/agent/models.json`：主位置（GSD）
2. `~/.pi/agent/models.json`：回退位置（Pi）
3. 如果两者都不存在，则创建 `~/.gsd/agent/models.json`

**本地 models（Ollama）的快速示例：**

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

每次打开 `/model` 时，这个文件都会重新加载，无需重启。

关于 provider 配置、model overrides、OpenAI compatibility 和更多高级示例，见 [自定义模型指南](./custom-models.md)。

**带 fallbacks 的示例：**

```yaml
models:
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
      - openrouter/moonshotai/kimi-k2.5
    provider: bedrock    # 可选：固定到某个 provider
```

当某个 model 切换失败（provider 不可用、被限流、额度耗尽）时，GSD 会自动尝试 `fallbacks` 列表中的下一个 model。

### Community Provider Extensions

对于 GSD 未内置的 providers，社区扩展可以添加完整 provider 支持，包括正确的 model 定义、thinking format 配置以及交互式 API key 设置。

| 扩展 | Provider | Models | 安装命令 |
|------|----------|--------|----------|
| [`pi-dashscope`](https://www.npmjs.com/package/pi-dashscope) | Alibaba DashScope（ModelStudio） | Qwen3、GLM-5、MiniMax M2.5、Kimi K2.5 | `gsd install npm:pi-dashscope` |

对于 DashScope models，更推荐使用社区扩展而不是内置的 `alibaba-coding-plan` provider，因为前者会走正确的 OpenAI-compatible endpoint，并包含适配 thinking mode 的 per-model compatibility flags。

### `token_profile`

负责协调 model 选择、阶段跳过和上下文压缩。详见 [Token 优化](./token-optimization.md)。

可选值：`budget`、`balanced`（默认）、`quality`

| 配置 | 行为 |
|------|------|
| `budget` | 跳过 research + reassessment 阶段，优先使用便宜模型 |
| `balanced` | 默认行为：所有阶段运行，使用标准模型选择 |
| `quality` | 所有阶段运行，优先更高质量模型 |

### `phases`

对自动模式中哪些阶段运行做细粒度控制：

```yaml
phases:
  skip_research: false        # 跳过 milestone 级 research
  skip_reassess: false        # 在每个 slice 后跳过 roadmap reassessment
  skip_slice_research: true   # 跳过每个 slice 的 research
  reassess_after_slice: true  # 每个 slice 后执行 roadmap reassessment（reassessment 的前提）
  require_slice_discussion: false  # 每个 slice 前暂停，等待讨论
```

这些值通常由 `token_profile` 自动设置，但也可以显式覆盖。

> **注意：** Roadmap reassessment 需要显式设置 `reassess_after_slice: true`。如果没有它，无论 `skip_reassess` 怎么配，reassessment 都不会运行。

### `skill_discovery`

控制 GSD 在自动模式中如何发现并应用 skills。

| 值 | 行为 |
|----|------|
| `auto` | 自动查找并应用 skills |
| `suggest` | 在 research 阶段识别到 skills，但不自动安装（默认） |
| `off` | 关闭 skill discovery |

### `auto_supervisor`

自动模式监督器使用的超时阈值：

```yaml
auto_supervisor:
  model: claude-sonnet-4-6    # 可选：supervisor 使用的 model（默认当前 active model）
  soft_timeout_minutes: 20    # 提醒 LLM 收尾
  idle_timeout_minutes: 10    # 检测停滞
  hard_timeout_minutes: 30    # 暂停自动模式
```

### `budget_ceiling`

自动模式期间允许消耗的最大美元金额。不需要 `$`，直接填数字：

```yaml
budget_ceiling: 50.00
```

### `budget_enforcement`

预算上限的执行方式：

| 值 | 行为 |
|----|------|
| `warn` | 记录警告，但继续运行 |
| `pause` | 暂停自动模式（设置 ceiling 时的默认值） |
| `halt` | 彻底停止自动模式 |

### `context_pause_threshold`

上下文窗口使用率达到多少（0-100）时，自动模式会暂停并进行 checkpoint。设为 `0` 可关闭。

```yaml
context_pause_threshold: 80   # 在上下文使用达到 80% 时暂停
```

默认值：`0`（关闭）

### `uat_dispatch`

在 slice 完成后自动运行 UAT（User Acceptance Test）：

```yaml
uat_dispatch: true
```

### Verification（v2.26）

配置在每次 task 执行后自动运行的 shell 命令。若失败，会先尝试自动修复重试，再决定是否继续。

```yaml
verification_commands:
  - npm run lint
  - npm run test
verification_auto_fix: true       # 失败时自动重试修复（默认：true）
verification_max_retries: 2       # 最大重试次数（默认：2）
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `verification_commands` | string[] | `[]` | task 执行后要运行的 shell 命令 |
| `verification_auto_fix` | boolean | `true` | verification 失败时是否自动重试 |
| `verification_max_retries` | number | `2` | 自动修复重试的最大次数 |

<a id="url-blocking-fetch_page"></a>
### URL Blocking（`fetch_page`）

`fetch_page` 工具默认会阻止访问私有网络和内部网络地址，以防 SSRF（server-side request forgery）。这能防止 agent 被诱导去访问内部服务、云 metadata endpoint 或本地文件。

**默认会被拦截：**

| 类别 | 示例 |
|------|------|
| 私有 IP 段 | `10.x.x.x`、`172.16-31.x.x`、`192.168.x.x`、`127.x.x.x` |
| Link-local / 云 metadata | `169.254.x.x`（AWS/GCP instance metadata） |
| 云 metadata hostname | `metadata.google.internal`、`instance-data` |
| Localhost | `localhost`（任意端口） |
| 非 HTTP 协议 | `file://`、`ftp://` |
| IPv6 私有地址段 | `::1`、`fc00:`、`fd`、`fe80:` |

公共 URL（例如 `https://example.com`、`http://8.8.8.8`）不受影响。

**允许特定内部主机：**

如果你确实需要 agent 访问内网 URL（例如自托管文档、VPN 后的内部 API），可以在全局设置 `~/.gsd/agent/settings.json` 中添加 `fetchAllowedUrls`：

```json
{
  "fetchAllowedUrls": ["internal-docs.company.com", "192.168.1.50"]
}
```

或者设置 `GSD_FETCH_ALLOWED_URLS` 环境变量（逗号分隔）。环境变量优先级高于 settings.json：

```bash
export GSD_FETCH_ALLOWED_URLS="internal-docs.company.com,192.168.1.50"
```

被允许的 hostname 会绕过 blocklist 检查。但协议限制依然有效，也就是说 `file://` 和 `ftp://` 仍然不能加入 allowlist。

> **注意：** 这是一个仅全局生效的设置。项目级 settings.json 不能覆盖 URL allowlist，以防克隆下来的仓库把 `fetch_page` 指向内部基础设施。

### `auto_report`（v2.26）

在 milestone 完成后自动生成 HTML 报告：

```yaml
auto_report: true    # 默认：true
```

报告会以自包含 HTML 文件的形式写入 `.gsd/reports/`，所有 CSS / JS 都内嵌。

### `unique_milestone_ids`

为 milestone IDs 添加随机后缀，以避免团队协作中的 ID 冲突：

```yaml
unique_milestone_ids: true
# 输出示例：M001-eh88as，而不是 M001
```

### `git`

Git 行为配置。所有字段都是可选的：

```yaml
git:
  auto_push: false            # 提交后推送到远程
  push_branches: false        # 推送 milestone 分支到远程
  remote: origin              # git remote 名称
  snapshots: true             # 长 task 执行期间做 WIP snapshot commits
  pre_merge_check: auto       # worktree merge 前执行检查（true / false / "auto"）
  commit_type: feat           # 覆盖 conventional commit 前缀
  main_branch: main           # 主分支名称
  merge_strategy: squash      # worktree 分支合并方式："squash" 或 "merge"
  isolation: worktree         # git isolation："worktree"、"branch" 或 "none"
  commit_docs: true           # 是否把 .gsd/ 产物提交到 git（设为 false 时仅保留本地）
  manage_gitignore: true      # 设为 false 时，GSD 不再修改 .gitignore
  worktree_post_create: .gsd/hooks/post-worktree-create  # worktree 创建后执行的脚本
  auto_pr: false              # milestone 完成时自动创建 PR（要求 push_branches）
  pr_target_branch: develop   # 自动创建 PR 的目标分支（默认：main branch）
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `auto_push` | boolean | `false` | 提交后推送到远程 |
| `push_branches` | boolean | `false` | 把 milestone 分支推送到远程 |
| `remote` | string | `"origin"` | Git remote 名称 |
| `snapshots` | boolean | `true` | 长 task 期间做 WIP snapshot commits |
| `pre_merge_check` | bool/string | `"auto"` | merge 前是否执行检查（`true` / `false` / `"auto"`） |
| `commit_type` | string | （自动推断） | 覆盖 conventional commit 前缀（`feat`、`fix`、`refactor`、`docs`、`test`、`chore`、`perf`、`ci`、`build`、`style`） |
| `main_branch` | string | `"main"` | 主分支名称 |
| `merge_strategy` | string | `"squash"` | worktree 分支合并方式：`"squash"`（合并为单个提交）或 `"merge"`（保留单独提交） |
| `isolation` | string | `"worktree"` | 自动模式隔离方式：`"worktree"`（独立目录）、`"branch"`（直接在项目根目录工作，适合子模块多的仓库）、`"none"`（无隔离，直接提交到当前分支） |
| `commit_docs` | boolean | `true` | 是否把 `.gsd/` planning 产物提交到 git。设为 `false` 则仅保留本地 |
| `manage_gitignore` | boolean | `true` | 设为 `false` 后，GSD 将完全不修改 `.gitignore`，不会添加基础规则，也不会做自愈 |
| `worktree_post_create` | string | （无） | worktree 创建后执行的脚本。环境变量中会传入 `SOURCE_DIR` 和 `WORKTREE_DIR` |
| `auto_pr` | boolean | `false` | milestone 完成时自动创建 pull request。要求 `auto_push: true` 且已安装认证 `gh` CLI |
| `pr_target_branch` | string | （main branch） | 自动创建 PR 的目标分支，例如 `develop`、`qa`。未设置时默认回退到 `main_branch` |

#### `git.worktree_post_create`

在 worktree 创建后执行脚本（自动模式和手动 `/worktree` 都适用）。适合复制 `.env`、建立资源目录软链，或者执行那些 worktree 不会继承的 setup 步骤。

```yaml
git:
  worktree_post_create: .gsd/hooks/post-worktree-create
```

脚本会收到两个环境变量：

- `SOURCE_DIR`：原始项目根目录
- `WORKTREE_DIR`：新创建的 worktree 路径

示例 hook（`.gsd/hooks/post-worktree-create`）：

```bash
#!/bin/bash
# Copy environment files and symlink assets into the new worktree
cp "$SOURCE_DIR/.env" "$WORKTREE_DIR/.env"
cp "$SOURCE_DIR/.env.local" "$WORKTREE_DIR/.env.local" 2>/dev/null || true
ln -sf "$SOURCE_DIR/assets" "$WORKTREE_DIR/assets"
```

路径既可以是绝对路径，也可以相对项目根目录。脚本有 30 秒超时限制。失败不会中断流程，GSD 会记录告警后继续。

<a id="gitauto_pr"></a>
#### `git.auto_pr`

在 milestone 完成时自动创建 pull request。适用于 Gitflow 或分支工作流团队，在合并到目标分支前通过 PR 做审查。

```yaml
git:
  auto_push: true
  auto_pr: true
  pr_target_branch: develop  # 或 qa、staging 等
```

**要求：**

- `auto_push: true`：创建 PR 前必须先把 milestone 分支推送到远程
- 已安装并认证 [`gh` CLI](https://cli.github.com/)（`gh auth login`）

**工作方式：**

1. milestone 完成后，GSD 先把 worktree squash merge 回主分支
2. 如果 `auto_push: true`，把主分支推送到远程
3. 把 milestone 分支推送到远程
4. 通过 `gh pr create` 从 milestone 分支向 `pr_target_branch` 创建 PR

如果没有设置 `pr_target_branch`，PR 会默认指向 `main_branch`（或者自动检测出的主分支）。PR 创建失败不会中断流程，GSD 会记录日志后继续。

### `github`（v2.39）

GitHub 同步配置。启用后，GSD 会自动把 milestones、slices 和 tasks 同步到 GitHub Issues、PRs 和 Milestones。

```yaml
github:
  enabled: true
  repo: "owner/repo"              # 省略时从 git remote 自动检测
  labels: [gsd, auto-generated]   # 应用到创建出的 issues / PRs 的标签
  project: "Project ID"           # 可选的 GitHub Project board
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `false` | 是否启用 GitHub 同步 |
| `repo` | string | （自动检测） | `owner/repo` 格式的 GitHub 仓库名 |
| `labels` | string[] | `[]` | 创建的 issues / PRs 要附加的标签 |
| `project` | string | （无） | GitHub Project ID，用于接入 Project board |

**要求：**

- 已安装并认证 `gh` CLI（`gh auth login`）
- 同步映射会保存在 `.gsd/.github-sync.json`
- 具备速率限制感知：当 GitHub API rate limit 偏低时会跳过同步

**命令：**

- `/github-sync bootstrap`：初始化配置并执行同步
- `/github-sync status`：显示同步映射数量

### `notifications`

控制 GSD 在自动模式中发出哪些通知：

```yaml
notifications:
  enabled: true
  on_complete: true           # 单元完成时通知
  on_error: true              # 出错时通知
  on_budget: true             # 预算阈值通知
  on_milestone: true          # milestone 完成时通知
  on_attention: true          # 需要人工介入时通知
```

**macOS 通知方式：** GSD 会优先使用 [`terminal-notifier`](https://github.com/julienXX/terminal-notifier)，不可用时回退到 `osascript`。建议安装 `terminal-notifier`，获得更稳定的通知体验：

```bash
brew install terminal-notifier
```

原因：`osascript display notification` 的通知权限是算在你的终端应用（Ghostty、iTerm2 等）上的，而这些应用在 System Settings → Notifications 中未必被允许。`terminal-notifier` 会注册成独立 App，并在首次使用时主动请求通知权限。如果通知异常，见 [故障排查：macOS 上通知不显示](troubleshooting.md#notifications-not-appearing-on-macos)。

### `remote_questions`

把交互式问题路由到 Slack 或 Discord，以支持 headless 自动模式：

```yaml
remote_questions:
  channel: slack              # 或 discord
  channel_id: "C1234567890"
  timeout_minutes: 15         # 问题超时（1-30 分钟）
  poll_interval_seconds: 10   # 轮询间隔（2-30 秒）
```

### `post_unit_hooks`

在特定单元完成后触发的自定义 hooks：

```yaml
post_unit_hooks:
  - name: code-review
    after: [execute-task]
    prompt: "Review the code changes for quality and security issues."
    model: claude-opus-4-6          # 可选：覆盖 model
    max_cycles: 1                   # 每次触发最多执行几轮（1-10，默认 1）
    artifact: REVIEW.md             # 可选：若该文件已存在则跳过
    retry_on: NEEDS-REWORK.md       # 可选：若生成该文件，则回退并重跑触发单元
    agent: review-agent             # 可选：指定使用哪个 agent 定义
    enabled: true                   # 可选：保留配置但临时禁用
```

`after` 可识别的 unit types 包括：`research-milestone`、`plan-milestone`、`research-slice`、`plan-slice`、`execute-task`、`complete-slice`、`replan-slice`、`reassess-roadmap`、`run-uat`

**Prompt 占位符：** `{milestoneId}`、`{sliceId}`、`{taskId}` 会自动替换成当前上下文值。

### `pre_dispatch_hooks`

在 dispatch 前拦截某个单元。支持三种动作：

**Modify**：在单元 prompt 前后拼接文本

```yaml
pre_dispatch_hooks:
  - name: add-standards
    before: [execute-task]
    action: modify
    prepend: "Follow our coding standards document."
    append: "Run linting after changes."
```

**Skip**：完全跳过该单元

```yaml
pre_dispatch_hooks:
  - name: skip-research
    before: [research-slice]
    action: skip
    skip_if: RESEARCH.md            # 可选：仅当该文件存在时才跳过
```

**Replace**：完全替换该单元 prompt

```yaml
pre_dispatch_hooks:
  - name: custom-execute
    before: [execute-task]
    action: replace
    prompt: "Execute the task using TDD methodology."
    unit_type: execute-task-tdd     # 可选：覆盖 unit type 标签
    model: claude-opus-4-6          # 可选：覆盖 model
```

所有 pre-dispatch hooks 都支持 `enabled: true/false`，用于开关而不删除配置。

### `always_use_skills` / `prefer_skills` / `avoid_skills`

Skill 路由偏好：

```yaml
always_use_skills:
  - debug-like-expert
prefer_skills:
  - frontend-design
avoid_skills: []
```

Skills 既可以写裸名称（去 `~/.agents/skills/` 和 `.agents/skills/` 查找），也可以写绝对路径。

### `skill_rules`

基于人类可读触发条件的情景化 skill 路由：

```yaml
skill_rules:
  - when: task involves authentication
    use: [clerk]
  - when: frontend styling work
    prefer: [frontend-design]
  - when: working with legacy code
    avoid: [aggressive-refactor]
```

### `custom_instructions`

附加到每个会话上的持久指令：

```yaml
custom_instructions:
  - "Always use TypeScript strict mode"
  - "Prefer functional patterns over classes"
```

如果是项目特有知识（模式、坑点、经验），请优先放到 `.gsd/KNOWLEDGE.md` 中，因为它会自动注入每个 agent prompt。你也可以通过 `/gsd knowledge rule|pattern|lesson <description>` 添加。

### `RUNTIME.md`：运行时上下文（v2.39）

你可以在 `.gsd/RUNTIME.md` 中声明项目级运行时上下文。这个文件会内联进 task execution prompt，让 agent 能准确知道运行环境，而不必靠猜测路径或 URL。

**位置：** `.gsd/RUNTIME.md`

**示例：**

```markdown
# Runtime Context

## API Endpoints
- Main API: https://api.example.com
- Cache: redis://localhost:6379

## Environment Variables
- DEPLOYMENT_ENV: staging
- DB_POOL_SIZE: 20

## Local Services
- PostgreSQL: localhost:5432
- Redis: localhost:6379
```

适合放在这里的信息，是那些执行时需要知道、但又不属于 `DECISIONS.md`（架构）或 `KNOWLEDGE.md`（规则 / 模式）的内容。典型例子包括：API base URL、服务端口、部署目标，以及环境特有配置。

### `dynamic_routing`

基于复杂度的 model 路由。详见 [动态模型路由](./dynamic-model-routing.md)。

```yaml
dynamic_routing:
  enabled: true
  capability_routing: true          # 按 task capability 评分 models（v2.59）
  tier_models:
    light: claude-haiku-4-5
    standard: claude-sonnet-4-6
    heavy: claude-opus-4-6
  escalate_on_failure: true
  budget_pressure: true
  cross_provider: true
```

### `context_management`（v2.59）

控制自动模式会话中的 observation masking 和 tool result truncation。可在不增加 LLM 开销的前提下，减少 compaction 之间的上下文膨胀。

```yaml
context_management:
  observation_masking: true          # 用占位符替换旧 tool result（默认：true）
  observation_mask_turns: 8          # 保留最近 N 个 user turn 的结果（1-50，默认：8）
  compaction_threshold_percent: 0.70 # 在 70% 上下文使用率处触发 compaction（0.5-0.95，默认：0.70）
  tool_result_max_chars: 800         # 单个 tool result 的最大字符数（200-10000，默认：800）
```

### `service_tier`（v2.42）

OpenAI 支持模型的 service tier 偏好。可通过 `/gsd fast` 切换。

| 值 | 行为 |
|----|------|
| `"priority"` | Priority tier：2 倍成本，更快响应 |
| `"flex"` | Flex tier：0.5 倍成本，更慢响应 |
| （未设置） | 默认 tier |

```yaml
service_tier: priority
```

### `forensics_dedup`（v2.43）

可选启用：在 `/gsd forensics` 提交 issue 之前，先搜索现有 issues 和 PRs。会额外消耗一些 AI tokens。

```yaml
forensics_dedup: true    # 默认：false
```

### `show_token_cost`（v2.44）

可选启用：在 footer 中显示每次 prompt 和累计会话的 token 成本。

```yaml
show_token_cost: true    # 默认：false
```

### `auto_visualize`

在 milestone 完成后自动显示工作流可视化器：

```yaml
auto_visualize: true
```

详见 [工作流可视化器](./visualizer.md)。

### `parallel`

同时运行多个 milestones。默认关闭。

```yaml
parallel:
  enabled: false            # 总开关
  max_workers: 2            # 并发 workers 数（1-4）
  budget_ceiling: 50.00     # 聚合成本上限（美元）
  merge_strategy: "per-milestone"  # "per-slice" 或 "per-milestone"
  auto_merge: "confirm"            # "auto"、"confirm" 或 "manual"
```

完整细节见 [并行编排](./parallel-orchestration.md)。

## 完整示例

```yaml
---
version: 1

# Model selection
models:
  research: openrouter/deepseek/deepseek-r1
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
  execution: claude-sonnet-4-6
  execution_simple: claude-haiku-4-5-20250414
  completion: claude-sonnet-4-6

# Token optimization
token_profile: balanced

# Dynamic model routing
dynamic_routing:
  enabled: true
  escalate_on_failure: true
  budget_pressure: true

# Budget
budget_ceiling: 25.00
budget_enforcement: pause
context_pause_threshold: 80

# Supervision
auto_supervisor:
  soft_timeout_minutes: 15
  hard_timeout_minutes: 25

# Git
git:
  auto_push: true
  merge_strategy: squash
  isolation: worktree         # "worktree", "branch", or "none"
  commit_docs: true

# Skills
skill_discovery: suggest
skill_staleness_days: 60     # Skills unused for N days get deprioritized (0 = disabled)
always_use_skills:
  - debug-like-expert
skill_rules:
  - when: task involves authentication
    use: [clerk]

# Notifications
notifications:
  on_complete: false
  on_milestone: true
  on_attention: true

# Visualizer
auto_visualize: true

# Service tier
service_tier: priority         # "priority" or "flex" (for /gsd fast)

# Diagnostics
forensics_dedup: true          # deduplicate before filing forensics issues
show_token_cost: true          # show per-prompt cost in footer

# Hooks
post_unit_hooks:
  - name: code-review
    after: [execute-task]
    prompt: "Review {sliceId}/{taskId} for quality and security."
    artifact: REVIEW.md
---
```
