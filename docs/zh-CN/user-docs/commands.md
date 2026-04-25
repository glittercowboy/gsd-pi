# 命令参考

## 会话命令

| 命令 | 说明 |
|------|------|
| `/gsd` | Step mode：一次执行一个工作单元，并在每步之间暂停 |
| `/gsd next` | 显式 Step mode（与 `/gsd` 相同） |
| `/gsd auto` | 自动模式：research、plan、execute、commit，然后重复 |
| `/gsd quick` | 在不经过完整 planning 开销的情况下，执行一个带 GSD 保证的 quick task（原子提交、状态跟踪） |
| `/gsd stop` | 优雅地停止自动模式 |
| `/gsd pause` | 暂停自动模式（保留状态，可用 `/gsd auto` 恢复） |
| `/gsd steer` | 在执行过程中强制修改 plan 文档 |
| `/gsd discuss` | 讨论架构和决策（可与自动模式并行使用） |
| `/gsd status` | 进度仪表板 |
| `/gsd widget` | 循环切换仪表板组件：full / small / min / off |
| `/gsd queue` | 给未来 milestones 排队和重排（自动模式中也安全） |
| `/gsd capture` | 随手记录一个想法，不打断当前流程（自动模式中可用） |
| `/gsd triage` | 手动触发待处理 captures 的 triage |
| `/gsd debug` | 创建并检查持久化的 /gsd debug 会话 |
| `/gsd debug list` | 列出已持久化的 debug 会话 |
| `/gsd debug status <slug>` | 查看指定 debug 会话 slug 的状态 |
| `/gsd debug continue <slug>` | 恢复一个已有的 debug 会话 slug |
| `/gsd debug --diagnose` | 检查 malformed artifacts 与会话健康（`--diagnose [<slug> | <issue text>]`） |
| `/gsd dispatch` | 直接派发一个指定阶段（research、plan、execute、complete、reassess、uat、replan） |
| `/gsd history` | 查看执行历史（支持 `--cost`、`--phase`、`--model` 过滤） |
| `/gsd forensics` | 全访问 GSD 调试器：用于分析自动模式失败，支持结构化异常检测、单元追踪和 LLM 引导的根因分析 |
| `/gsd cleanup` | 清理 GSD 状态文件和过期 worktrees |
| `/gsd visualize` | 打开工作流可视化器（进度、依赖、指标、时间线） |
| `/gsd export --html` | 为当前或已完成的 milestone 生成自包含 HTML 报告 |
| `/gsd export --html --all` | 一次性为所有 milestones 生成回顾报告 |
| `/gsd update` | 在会话内更新到最新版本 |
| `/gsd knowledge` | 添加持久化项目知识（规则、模式或经验） |
| `/gsd fast` | 为支持的模型切换 service tier（优先级 API 路由） |
| `/gsd rate` | 评价上一个单元所用模型层级（over / ok / under），帮助改进自适应路由 |
| `/gsd changelog` | 查看分类后的发行说明 |
| `/gsd logs` | 浏览活动日志、调试日志和指标 |
| `/gsd remote` | 控制远程自动模式 |
| `/gsd help` | 查看所有 GSD 子命令的分类参考及说明 |

## 配置与诊断

| 命令 | 说明 |
|------|------|
| `/gsd prefs` | 模型选择、超时和预算上限 |
| `/gsd mode` | 切换工作流模式（solo / team），同时应用与 milestone ID、git 提交行为和文档相关的协调默认值 |
| `/gsd config` | 重新运行 provider 配置向导（LLM provider + 工具 key） |
| `/gsd keys` | API key 管理器：列出、添加、移除、测试、轮换、doctor |
| `/gsd doctor` | 运行时健康检查与自动修复；问题会实时显示在 widget、visualizer 和 HTML reports 中（v2.40） |
| `/gsd inspect` | 查看 SQLite DB 诊断信息 |
| `/gsd init` | 项目初始化向导：检测、配置并 bootstrap `.gsd/` |
| `/gsd setup` | 查看全局 setup 状态和配置 |
| `/gsd skill-health` | 技能生命周期仪表板：使用统计、成功率、token 趋势、过期告警 |
| `/gsd skill-health <name>` | 查看某个 skill 的详细信息 |
| `/gsd skill-health --declining` | 只显示被标记为表现下降的 skills |
| `/gsd skill-health --stale N` | 显示 N 天以上未使用的 skills |
| `/gsd hooks` | 查看已配置的 post-unit 和 pre-dispatch hooks |
| `/gsd run-hook` | 手动触发一个指定 hook |
| `/gsd migrate` | 将 v1 的 `.planning` 目录迁移到 `.gsd` 格式 |

## Milestone 管理

| 命令 | 说明 |
|------|------|
| `/gsd new-milestone` | 创建一个新的 milestone |
| `/gsd skip` | 阻止某个工作单元被自动模式派发 |
| `/gsd undo` | 回退上一个已完成单元 |
| `/gsd undo-task` | 重置某个特定 task 的完成状态（DB + markdown） |
| `/gsd reset-slice` | 重置某个 slice 及其所有 tasks（DB + markdown） |
| `/gsd park` | Park 一个 milestone，不删除，只跳过 |
| `/gsd unpark` | 重新激活一个已 park 的 milestone |
| Discard milestone | 在 `/gsd` 向导的 “Milestone actions” → “Discard” 中可用 |

## 并行编排

| 命令 | 说明 |
|------|------|
| `/gsd parallel start` | 分析可并行性、确认后启动 workers |
| `/gsd parallel status` | 显示所有 workers 的状态、进度和成本 |
| `/gsd parallel stop [MID]` | 停止所有 workers，或停止某个指定 milestone 的 worker |
| `/gsd parallel pause [MID]` | 暂停所有 workers，或暂停某个指定 worker |
| `/gsd parallel resume [MID]` | 恢复已暂停的 workers |
| `/gsd parallel merge [MID]` | 把已完成的 milestones 合并回 main |

完整文档见 [并行编排](./parallel-orchestration.md)。

## Workflow Templates（v2.42）

| 命令 | 说明 |
|------|------|
| `/gsd start` | 启动一个 workflow template（bugfix、spike、feature、hotfix、refactor、security-audit、dep-upgrade、full-project） |
| `/gsd start resume` | 恢复一个进行中的 workflow |
| `/gsd templates` | 列出可用 workflow templates |
| `/gsd templates info <name>` | 查看某个 template 的详细信息 |

## 自定义 Workflows（v2.42）

| 命令 | 说明 |
|------|------|
| `/gsd workflow new` | 创建一个新的 workflow definition（通过 skill） |
| `/gsd workflow run <name>` | 创建一个 run 并启动自动模式 |
| `/gsd workflow list` | 列出 workflow runs |
| `/gsd workflow validate <name>` | 校验一个 workflow YAML definition |
| `/gsd workflow pause` | 暂停自定义 workflow 的自动模式 |
| `/gsd workflow resume` | 恢复已暂停的自定义 workflow 自动模式 |

## 扩展

| 命令 | 说明 |
|------|------|
| `/gsd extensions list` | 列出所有扩展及其状态 |
| `/gsd extensions enable <id>` | 启用一个被禁用的扩展 |
| `/gsd extensions disable <id>` | 禁用一个扩展 |
| `/gsd extensions info <id>` | 查看扩展详情 |

## cmux 集成

| 命令 | 说明 |
|------|------|
| `/gsd cmux status` | 显示 cmux 检测结果、prefs 和能力 |
| `/gsd cmux on` | 启用 cmux 集成 |
| `/gsd cmux off` | 禁用 cmux 集成 |
| `/gsd cmux notifications on/off` | 切换 cmux 桌面通知 |
| `/gsd cmux sidebar on/off` | 切换 cmux 侧边栏元数据 |
| `/gsd cmux splits on/off` | 切换 cmux subagent 可视化分屏 |

## GitHub Sync（v2.39）

| 命令 | 说明 |
|------|------|
| `/github-sync bootstrap` | 初始配置：根据当前 `.gsd/` 状态创建 GitHub Milestones、Issues 和 draft PRs |
| `/github-sync status` | 显示同步映射数量（milestones、slices、tasks） |

在偏好设置里启用 `github.enabled: true`。要求已安装并认证 `gh` CLI。同步映射会保存在 `.gsd/.github-sync.json`。

## Git 命令

| 命令 | 说明 |
|------|------|
| `/worktree`（`/wt`） | Git worktree 生命周期管理：create、switch、merge、remove |

## 会话管理

| 命令 | 说明 |
|------|------|
| `/clear` | 启动一个新会话（`/new` 的别名） |
| `/exit` | 优雅退出，会在退出前保存会话状态 |
| `/kill` | 立即终止 GSD 进程 |
| `/model` | 切换当前 active model |
| `/login` | 登录一个 LLM provider |
| `/thinking` | 在会话中切换 thinking level |
| `/voice` | 切换实时语音转文字（macOS、Linux） |

## 键盘快捷键

| 快捷键 | 动作 |
|--------|------|
| `Ctrl+Alt+G` | 切换 dashboard overlay |
| `Ctrl+Alt+V` | 切换语音转录 |
| `Ctrl+Alt+B` | 显示后台 shell 进程 |
| `Ctrl+V` / `Alt+V` | 从剪贴板粘贴图片（截图 → vision 输入） |
| `Escape` | 暂停自动模式（保留对话） |

> **注意：** 在不支持 Kitty keyboard protocol 的终端中（如 macOS Terminal.app、JetBrains IDEs），界面会显示 slash-command 形式的回退命令，而不是 `Ctrl+Alt` 快捷键。
>
> **提示：** 如果 `Ctrl+V` 被终端拦截（例如 Warp），可改用 `Alt+V` 粘贴剪贴板图片。

## CLI 参数

| 参数 | 说明 |
|------|------|
| `gsd` | 启动新的交互式会话 |
| `gsd --continue`（`-c`） | 恢复当前目录最近一次会话 |
| `gsd --model <id>` | 为当前会话覆盖默认模型 |
| `gsd --print "msg"`（`-p`） | 单次 prompt 模式（无 TUI） |
| `gsd --mode <text\|json\|rpc\|mcp>` | 非交互使用时的输出模式 |
| `gsd --list-models [search]` | 列出可用模型并退出 |
| `gsd --web [path]` | 启动基于浏览器的 Web 界面（可选项目路径） |
| `gsd --worktree`（`-w`）[name] | 在 git worktree 中启动会话（未指定时自动生成名称） |
| `gsd --no-session` | 禁用会话持久化 |
| `gsd --extension <path>` | 加载一个额外扩展（可重复） |
| `gsd --append-system-prompt <text>` | 向 system prompt 末尾追加文本 |
| `gsd --tools <list>` | 启用的工具列表，逗号分隔 |
| `gsd --version`（`-v`） | 输出版本并退出 |
| `gsd --help`（`-h`） | 输出帮助并退出 |
| `gsd sessions` | 交互式会话选择器：列出当前目录所有保存的会话并选择一个恢复 |
| `gsd --debug` | 启用结构化 JSONL 诊断日志，用于排查 dispatch 和 state 问题 |
| `gsd config` | 配置搜索和文档工具所需的全局 API keys（保存到 `~/.gsd/agent/auth.json`，对所有项目生效）。见 [Global API Keys](./configuration.md#global-api-keys-gsd-config)。 |
| `gsd update` | 更新到最新版本 |
| `gsd headless new-milestone` | 根据上下文文件创建新的 milestone（headless，无需 TUI） |

## Headless 模式

`gsd headless` 可在无 TUI 的情况下运行 `/gsd` 命令，适合 CI、cron job 和脚本自动化。它会在 RPC 模式下启动一个子进程，自动回应交互式提示、检测完成状态，并用有意义的退出码退出。

```bash
# 运行自动模式（默认）
gsd headless

# 运行一个单元
gsd headless next

# 即时 JSON 快照，无需 LLM，约 50ms
gsd headless query

# 用于 CI 的超时参数
gsd headless --timeout 600000 auto

# 强制指定一个 phase
gsd headless dispatch plan

# 根据上下文文件创建新 milestone，并启动自动模式
gsd headless new-milestone --context brief.md --auto

# 用内联文本创建 milestone
gsd headless new-milestone --context-text "Build a REST API with auth"

# 从 stdin 管道输入上下文
echo "Build a CLI tool" | gsd headless new-milestone --context -
```

| 参数 | 说明 |
|------|------|
| `--timeout N` | 总超时（毫秒），默认 `300000` / 5 分钟 |
| `--max-restarts N` | 崩溃时自动重启并指数退避（默认 3）。设为 0 可关闭 |
| `--json` | 以 JSONL 形式把所有事件流式输出到 stdout |
| `--model ID` | 覆盖 headless 会话使用的模型 |
| `--context <file>` | 给 `new-milestone` 提供上下文文件（用 `-` 表示 stdin） |
| `--context-text <text>` | 给 `new-milestone` 提供内联上下文文本 |
| `--auto` | 在创建 milestone 后直接接续自动模式 |

**退出码：** `0` 表示完成，`1` 表示错误或超时，`2` 表示被阻塞。

任何 `/gsd` 子命令都可以作为位置参数使用，例如：`gsd headless status`、`gsd headless doctor`、`gsd headless dispatch execute` 等。

### `gsd headless query`

它会返回单个 JSON 对象，包含完整项目快照，无需 LLM 会话，也无需 RPC 子进程，响应几乎即时（约 50ms）。这是 orchestration 工具和脚本检查 GSD 状态的推荐方式。

```bash
gsd headless query | jq '.state.phase'
# "executing"

gsd headless query | jq '.next'
# {"action":"dispatch","unitType":"execute-task","unitId":"M001/S01/T03"}

gsd headless query | jq '.cost.total'
# 4.25
```

**输出结构：**

```json
{
  "state": {
    "phase": "executing",
    "activeMilestone": { "id": "M001", "title": "..." },
    "activeSlice": { "id": "S01", "title": "..." },
    "activeTask": { "id": "T01", "title": "..." },
    "registry": [{ "id": "M001", "status": "active" }, ...],
    "progress": { "milestones": { "done": 0, "total": 2 }, "slices": { "done": 1, "total": 3 } },
    "blockers": []
  },
  "next": {
    "action": "dispatch",
    "unitType": "execute-task",
    "unitId": "M001/S01/T01"
  },
  "cost": {
    "workers": [{ "milestoneId": "M001", "cost": 1.50, "state": "running", ... }],
    "total": 1.50
  }
}
```

<a id="mcp-server-mode"></a>
## MCP Server 模式

`gsd --mode mcp` 会通过 stdin/stdout 将 GSD 作为一个 [Model Context Protocol](https://modelcontextprotocol.io) server 运行。这会把所有 GSD 工具（read、write、edit、bash 等）暴露给外部 AI 客户端，例如 Claude Desktop、VS Code Copilot，以及任何兼容 MCP 的宿主。

```bash
# 以 MCP server 模式启动 GSD
gsd --mode mcp
```

服务会注册 agent 会话中的全部工具，并把 MCP 的 `tools/list` 与 `tools/call` 请求映射到 GSD 的工具定义上。连接会一直保持，直到底层 transport 关闭。

## 会话内更新

`/gsd update` 会检查 npm 上是否有更新版本，并在不离开当前会话的情况下完成安装。

```bash
/gsd update
# Current version: v2.36.0
# Checking npm registry...
# Updated to v2.37.0. Restart GSD to use the new version.
```

如果已经是最新版本，它会给出提示且不做任何操作。

## 导出

`/gsd export` 用于导出 milestone 工作报告。

```bash
# 为当前 active milestone 生成 HTML 报告
/gsd export --html

# 一次性为所有 milestones 生成回顾报告
/gsd export --html --all
```

报告会保存到 `.gsd/reports/`，并生成一个可浏览的 `index.html`，链接到所有已生成的快照。
