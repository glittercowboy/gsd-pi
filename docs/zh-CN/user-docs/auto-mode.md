# 自动模式

自动模式是 GSD 的自主执行引擎。运行 `/gsd auto`，然后离开；回来时你会看到已经构建好的软件，以及干净的 git 历史。

## 工作原理

自动模式本质上是一个**由磁盘文件驱动的状态机**。它会读取 `.gsd/STATE.md`，确定下一个工作单元，创建一个新的 agent 会话，把所有相关上下文预先内联到一个聚焦 prompt 中，再让 LLM 执行。LLM 完成后，自动模式会再次读取磁盘状态，并派发下一个工作单元。

### 执行循环

每个 slice 都会自动经历以下阶段：

```
Plan (with integrated research) → Execute (per task) → Complete → Reassess Roadmap → Next Slice
                                                                                      ↓ (all slices done)
                                                                              Validate Milestone → Complete Milestone
```

- **Plan**：巡检代码库、研究相关文档，把 slice 分解成带 must-have 的 task
- **Execute**：在新的上下文窗口中逐个执行 task
- **Complete**：写 summary、UAT 脚本、标记 roadmap、提交代码
- **Reassess**：检查 roadmap 是否仍然合理
- **Validate Milestone**：在所有 slices 完成后做一致性校验，把 roadmap 的成功标准与实际结果对照，避免在封板前漏掉关键缺口

## 关键特性

### 每个单元都用全新会话

每个 task、research 阶段和 planning 步骤都会得到一个干净的上下文窗口。没有历史垃圾堆积，也不会因为上下文膨胀导致质量下降。派发 prompt 中已经包含 task plan、历史 summary、依赖上下文、决策记录等必要信息，因此 LLM 一开始就能对齐，而不必先花工具调用去读文件。

### 预加载上下文

派发 prompt 会精心组装以下内容：

| 内联产物 | 用途 |
|----------|------|
| Task plan | 告诉 agent 要构建什么 |
| Slice plan | 说明当前 task 在整体中的位置 |
| 历史 task summaries | 告诉 agent 已经完成了什么 |
| 依赖 summary | 提供跨 slice 上下文 |
| Roadmap 摘要 | 说明整体方向 |
| Decisions register | 提供架构上下文 |

具体内联多少内容由你的 [token profile](./token-optimization.md) 控制。`budget` 模式只内联最少上下文，`quality` 模式则把所有内容都内联进去。

### Git 隔离

GSD 支持三种 milestone 隔离模式（通过偏好设置中的 `git.isolation` 配置）：

- **`worktree`**（默认）：每个 milestone 都运行在 `.gsd/worktrees/<MID>/` 下自己的 git worktree 中，分支名为 `milestone/<MID>`。所有 slice 工作都顺序提交，不需要切分支，也不会在 milestone 内部产生合并冲突。milestone 完成后，再整体 squash merge 回主分支，形成一个干净提交。
- **`branch`**：工作发生在项目根目录下的 `milestone/<MID>` 分支上。适合子模块较多、worktree 表现不佳的仓库。
- **`none`**：直接在当前分支工作。没有 worktree，也没有 milestone 分支。适合文件隔离会破坏开发工具的热重载场景。

详见 [Git 策略](./git-strategy.md)。

### 并行执行

当项目里存在彼此独立的 milestones 时，可以同时运行它们。每个 milestone 都拥有自己的 worker 进程和 worktree。配置与用法见 [并行编排](./parallel-orchestration.md)。

### 崩溃恢复

自动模式会用锁文件跟踪当前工作单元。如果会话中途退出，下一次执行 `/gsd auto` 时，会读取残留的会话文件，从所有已经落盘的工具调用中综合生成一份恢复简报，然后带着完整上下文继续执行。

**Headless 自动重启（v2.26）：** 当运行 `gsd headless auto` 时，崩溃会触发带指数退避的自动重启（5s → 10s → 30s 上限，默认最多 3 次）。通过 `--max-restarts N` 配置。SIGINT/SIGTERM 不会触发重启。结合崩溃恢复机制，这让真正的“跑一夜直到完成”成为可能。

### Provider 错误恢复

GSD 会对 provider 错误分类，并在安全时自动恢复：

| 错误类型 | 示例 | 动作 |
|----------|------|------|
| **限流** | 429、`too many requests` | 按 `retry-after` 头等待，或默认 60 秒后自动恢复 |
| **服务端错误** | 500、502、503、`overloaded`、`api_error` | 30 秒后自动恢复 |
| **永久错误** | `unauthorized`、`invalid key`、`billing` | 无限期暂停，等待人工恢复 |

对临时性错误通常不需要人工介入，系统会短暂暂停后自动继续。

### 增量记忆（v2.26）

GSD 会维护一个 `KNOWLEDGE.md` 文件，作为项目特有规则、模式和经验的追加式记录。agent 在每个工作单元开始时都会读取它；当发现反复出现的问题、非显而易见的模式或未来会话需要遵循的规则时，也会把内容追加进去。这样一来，自动模式就有了跨会话、跨上下文窗口的持久记忆。

### 上下文压力监视器（v2.26）

当上下文使用达到 70% 时，GSD 会向 agent 发送收尾信号，提醒它优先完成可持久化的输出（例如提交、写 summary），避免在 task 中途因为上下文打满而什么都没来得及落盘。

### 有意义的提交信息（v2.26）

提交信息不是通用的 “complete task”，而是从 task summary 生成的。每条提交消息都反映了真正完成了什么，因此 `git log` 看起来更像一份高质量的变更日志。

### 卡死检测（v2.39）

GSD 使用滑动窗口分析来检测卡死循环。它不只是简单地统计“同一单元是否重复派发两次”，而是会分析近期派发历史中的重复模式，因此既能发现单点重复，也能发现 A→B→A→B 这样的循环。一旦检测到，GSD 会先带着更深的诊断 prompt 重试一次；如果仍然失败，自动模式就会停止，并指出它原本期待的具体文件，便于你介入。

这种滑动窗口方法能降低合法重试场景（例如可自动修复的 verification 失败）的误报，同时更快抓到真正的卡死循环。

### 事后取证（v2.40）

`/gsd forensics` 是一个面向自动模式失败分析的全访问 GSD 调试器，提供：

- **异常检测**：对卡死循环、成本尖峰、超时、产物缺失和崩溃做结构化识别，并标注严重级别
- **单元追踪**：最近 10 次单元执行，包含错误细节和执行时长
- **指标分析**：成本、token 数量和执行时间拆分
- **Doctor 集成**：把 `/gsd doctor` 中的结构性健康问题一起纳入
- **LLM 引导调查**：启动一个拥有完整工具访问权限的 agent 会话来调查根因

```
/gsd forensics [optional problem description]
```

更多诊断方式见 [故障排查](./troubleshooting.md)。

### 超时监管

三层超时机制可以防止会话失控：

| 超时类型 | 默认值 | 行为 |
|----------|--------|------|
| Soft | 20 分钟 | 警告 LLM 应该开始收尾 |
| Idle | 10 分钟 | 检测停滞并介入 |
| Hard | 30 分钟 | 暂停自动模式 |

恢复引导会提醒 LLM 在真正超时前尽量完成可持久化输出。配置方式如下：

```yaml
auto_supervisor:
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
```

### 成本跟踪

每个工作单元的 token 使用量和成本都会被记录，并按阶段、slice 和模型拆分。仪表板会显示运行总量和预测值。预算上限可以在超支前主动暂停自动模式。

详见 [成本管理](./cost-management.md)。

### 自适应重规划

每完成一个 slice，roadmap 都会重新评估。如果最新工作暴露出会改变计划的新信息，后续 slices 就会在继续前被重新排序、添加或删除。`balanced` 和 `budget` token profile 可以跳过这一阶段。

### 验证强制执行（v2.26）

你可以配置 shell 命令，让它们在每个 task 执行后自动运行：

```yaml
verification_commands:
  - npm run lint
  - npm run test
verification_auto_fix: true    # 默认开启自动重试修复
verification_max_retries: 2    # 最大重试次数（默认 2）
```

一旦失败，agent 会看到 verification 输出并尝试自动修复后重试，再决定是否继续。这意味着代码质量门禁是靠机制强制执行，而不是靠 LLM“自觉遵守”。

### Slice 讨论门（v2.26）

如果你希望每个 slice 开始前都先经过人工确认：

```yaml
require_slice_discussion: true
```

自动模式会在每个 slice 开始前暂停，并把 slice 上下文展示出来供你讨论。确认后才继续执行。适用于高风险项目，尤其是你希望 agent 开始构建前先复核计划的时候。

### HTML 报告（v2.26）

每当 milestone 完成后，GSD 都会在 `.gsd/reports/` 中自动生成一个自包含的 HTML 报告。报告包括项目摘要、进度树、slice 依赖图（SVG DAG）、成本 / Token 柱状图、执行时间线、变更日志和知识库。没有外部依赖，所有 CSS 和 JS 都会内联。

```yaml
auto_report: true    # 默认开启
```

你也可以随时手动执行 `/gsd export --html` 生成报告，或通过 `/gsd export --html --all`（v2.28）为所有 milestones 一次性生成报告。

### 故障恢复强化（v2.28）

v2.28 通过多项机制强化了自动模式的可靠性：原子文件写入可避免崩溃时损坏文件；OAuth 拉取超时（30 秒）避免无限挂起；RPC 子进程退出能被检测并报告；blob 垃圾回收可防止磁盘无限增长。结合已有的崩溃恢复和 headless 自动重启，自动模式可以真正支持“扔在那里跑一晚上”的场景。

### 流水线架构（v2.40）

自动循环采用的是线性阶段流水线，而非递归派发。每轮迭代都经过明确的阶段：

1. **Pre-Dispatch**：校验状态、检查守卫、解析模型偏好
2. **Dispatch**：使用聚焦 prompt 执行当前单元
3. **Post-Unit**：关闭该单元、更新缓存、执行清理
4. **Verification**：可选验证门（lint、test 等）
5. **Stuck Detection**：滑动窗口模式分析

这种线性流程更容易调试，占用更少内存（没有递归调用栈），也使错误恢复更清晰，因为每个阶段都有明确的入口和出口条件。

### 实时健康可见性（v2.40）

`/gsd doctor` 发现的问题现在会实时出现在三个地方：

- **Dashboard widget**：健康指示器，显示问题数量和严重级别
- **Workflow visualizer**：状态面板中展示问题
- **HTML reports**：生成报告时带出完整健康信息

问题按严重程度分为：`error`（阻塞自动模式）、`warning`（不阻塞）和 `info`（提示性质）。自动模式会在派发时检查健康状态，并可在关键问题出现时主动暂停。

### Prompt 中的技能激活（v2.39）

配置好的技能会被自动解析并注入派发 prompt。agent 会收到一个 “Available Skills” 区块，列出当前上下文匹配的技能，来源包括：

- `always_use_skills`：始终注入
- `prefer_skills`：以偏好形式注入
- `skill_rules`：根据 `when` 条件做条件激活

技能路由偏好详见 [配置](./configuration.md)。

## 控制自动模式

### 启动

```
/gsd auto
```

### 暂停

按 **Escape**。对话会被保留，你可以继续和 agent 交互、查看状态，或者稍后恢复。

### 恢复

```
/gsd auto
```

自动模式会读取磁盘状态，并从中断处继续。

### 停止

```
/gsd stop
```

优雅地停止自动模式。这个命令也可以从另一个终端执行。

### 引导

```
/gsd steer
```

在不中断流水线的情况下，强制修改计划文档。修改会在下一个阶段边界生效。

### 捕获

```
/gsd capture "add rate limiting to API endpoints"
```

随手记录想法，不打断当前执行。Captures 会在 tasks 之间自动 triage。详见 [捕获与分流](./captures-triage.md)。

### 可视化

```
/gsd visualize
```

打开工作流可视化器，交互式查看进度、依赖、指标和时间线。详见 [工作流可视化器](./visualizer.md)。

## 仪表板

`Ctrl+Alt+G` 或 `/gsd status` 会显示实时进度：

- 当前 milestone、slice 和 task
- 自动模式的已运行时间和当前阶段
- 每个单元的成本与 token 拆分
- 成本预测
- 已完成和进行中的单元
- 待 triage 的 capture 数量（如果存在）
- 并行 worker 状态（运行并行 milestones 时显示，也包含 80% 预算预警）

## 跳过阶段

Token profile 可以通过跳过某些阶段来降低成本：

| 阶段 | `budget` | `balanced` | `quality` |
|------|----------|------------|-----------|
| Milestone Research | 跳过 | 执行 | 执行 |
| Slice Research | 跳过 | 跳过 | 执行 |
| Reassess Roadmap | 跳过 | 执行 | 执行 |

更多细节见 [Token 优化](./token-optimization.md)。

## 动态模型路由

启用后，自动模式会为简单工作单元（例如 slice completion、UAT）自动选择更便宜的模型，并把昂贵模型保留给复杂工作（例如重规划或架构 task）。详见 [动态模型路由](./dynamic-model-routing.md)。

## 响应式 Task 执行（v2.38）

当在偏好中设置 `reactive_execution: true` 时，GSD 会从 task plan 中的 IO 注解推导依赖图。互不冲突的 tasks（没有共享文件读写）会通过 subagents 并行派发，而存在依赖的 tasks 则等待前驱完成。

```yaml
reactive_execution: true    # 默认关闭
```

依赖图推导是纯函数且确定性的：它会解析 ready-set、检测冲突和死锁，并做相应防护。并行批次中的 verification 结果会被沿用，因此某些 tasks 如果已经通过验证，后续同一 slice 中其他 tasks 完成时就不需要再次验证。

这套实现位于 `reactive-graph.ts`（负责图推导、ready-set 解析、冲突 / 死锁检测），并集成到了 `auto-dispatch.ts` 和 `auto-prompts.ts`。
