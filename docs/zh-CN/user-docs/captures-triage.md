# 捕获与分流

*引入于 v2.19.0*

Captures 允许你在自动模式执行过程中随手记录想法，而不必打断当前流程。你可以把新想法、bug 或范围变更记录下来，让 GSD 在 tasks 之间的自然间隙中进行分流处理。

## 快速开始

在自动模式运行期间（或任何时候）：

```
/gsd capture "add rate limiting to the API endpoints"
/gsd capture "the auth flow should support OAuth, not just JWT"
```

这些 capture 会追加到 `.gsd/CAPTURES.md`，并在 tasks 之间自动参与 triage。

## 工作原理

### 流程

```
capture → triage → confirm → resolve → resume
```

1. **Capture**：`/gsd capture "thought"` 会带着时间戳和唯一 ID 追加到 `.gsd/CAPTURES.md`
2. **Triage**：在 tasks 之间的自然衔接点（`handleAgentEnd` 中），GSD 会检测待处理 capture 并进行分类
3. **Confirm**：向用户展示建议的处理方式，由用户确认或调整
4. **Resolve**：应用该处理方案（插入 task、触发重规划、延期等）
5. **Resume**：自动模式继续运行

### 分类类型

每条 capture 都会被分类到以下五种类型之一：

| 类型 | 含义 | 处理方式 |
|------|------|----------|
| `quick-task` | 小型、可独立完成的修复 | 立即以内联 quick task 执行 |
| `inject` | 当前 slice 需要新增 task | 将 task 注入当前活跃的 slice plan |
| `defer` | 重要但不紧急 | 延后到 roadmap reassessment 时处理 |
| `replan` | 改变当前实现路径 | 带着 capture 上下文触发 slice replan |
| `note` | 仅供记录，不需要动作 | 记录并确认，不修改计划 |

### 自动分流

在自动模式下，triage 会在 tasks 之间自动触发。triage prompt 会收到：

- 所有待处理 captures
- 当前 slice plan
- 当前活跃 roadmap

LLM 会对每条 capture 进行分类并给出建议处理方案。会修改计划的处理方式（`inject`、`replan`）需要用户确认。

### 手动分流

你也可以随时手动触发 triage：

```
/gsd triage
```

这在你积累了多条 capture，并希望在下一个自然间隙之前先处理掉它们时很有用。

## 仪表板集成

当有待 triage 的 capture 时，进度组件会显示一个待处理数量徽标。无论是在 `Ctrl+Alt+G` 仪表板里，还是自动模式进度组件里，都能看到这个提示。

## 上下文注入

Capture 上下文会自动注入到：

- **Replan-slice prompts**：让重规划知道是什么触发了它
- **Reassess-roadmap prompts**：让被延后的 capture 也会影响 roadmap 决策

## Worktree 感知

Captures 总是写回**原始项目根目录**下的 `.gsd/CAPTURES.md`，而不是 worktree 的本地副本。这样从 steering 终端记录的内容，也能被运行在 worktree 里的自动模式会话看到。

## 命令

| 命令 | 说明 |
|------|------|
| `/gsd capture "text"` | 记录一个想法（单词时引号可省略） |
| `/gsd triage` | 手动触发待处理 captures 的 triage |
