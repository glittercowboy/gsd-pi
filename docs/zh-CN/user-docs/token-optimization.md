# Token 优化

*引入于 v2.17.0*

GSD 2.17 引入了一套协同工作的 token 优化系统，在大多数工作负载下可以在不牺牲输出质量的前提下，将 token 使用降低 40-60%。这套系统由三部分构成：**token profiles**、**context compression** 和 **基于复杂度的 task 路由**。

## Token Profiles

Token profile 是一个单一偏好项，用来统一协调 model 选择、阶段跳过和上下文压缩级别。在偏好设置中这样配置：

```yaml
---
version: 1
token_profile: balanced
---
```

可用的 profile 有三个：

### `budget`：最大节省（降低 40-60%）

面向成本敏感型工作流。它会使用更便宜的 models，跳过可选阶段，并把 dispatch 上下文压缩到最低必要程度。

| 维度 | 设置 |
|------|------|
| Planning model | Sonnet |
| Execution model | Sonnet |
| Simple task model | Haiku |
| Completion model | Haiku |
| Subagent model | Haiku |
| Milestone research | **跳过** |
| Slice research | **跳过** |
| Roadmap reassessment | **跳过** |
| Context inline level | **Minimal**：丢弃 decisions、requirements、额外 templates |

适合：原型开发、小项目、已充分理解的代码库、强调成本控制的迭代。

### `balanced`：智能默认值（默认）

默认 profile。保留关键阶段，跳过那些对大多数项目边际收益不高的阶段，并采用标准级别的上下文压缩。

| 维度 | 设置 |
|------|------|
| Planning model | 用户默认值 |
| Execution model | 用户默认值 |
| Simple task model | 用户默认值 |
| Completion model | 用户默认值 |
| Subagent model | Sonnet |
| Milestone research | 执行 |
| Slice research | **跳过** |
| Roadmap reassessment | 执行 |
| Context inline level | **Standard**：保留关键上下文，丢弃低信号附加内容 |

适合：大多数项目、日常开发。

### `quality`：完整上下文（不压缩）

所有阶段都会运行。所有上下文产物都会被内联。没有捷径。

| 维度 | 设置 |
|------|------|
| 所有 models | 用户配置的默认值 |
| 所有阶段 | 执行 |
| Context inline level | **Full**：全部内联 |

适合：复杂架构、需要深度 research 的 greenfield 项目、关键生产环境工作。

## Context Compression

每个 token profile 都会映射到一个 **inline level**，它控制在 dispatch prompt 里预加载多少上下文：

| Profile | Inline Level | 包含内容 |
|---------|--------------|----------|
| `budget` | `minimal` | Task plan、关键历史 summaries（截断）。不包含 decisions register、requirements、UAT template、secrets manifest。 |
| `balanced` | `standard` | Task plan、历史 summaries、slice plan、roadmap 摘要。不包含部分辅助 templates。 |
| `quality` | `full` | 全部内容：所有 plans、summaries、decisions、requirements、templates 和根文件。 |

### 压缩如何工作

Dispatch prompt builder 接受一个 `inlineLevel` 参数。在不同级别下，特定产物会被按规则裁剪：

**Minimal 级别的裁剪：**

- `buildExecuteTaskPrompt`：丢弃 decisions template，并把历史 summaries 截断到只保留最近一个
- `buildPlanMilestonePrompt`：丢弃 `PROJECT.md`、`REQUIREMENTS.md`、decisions 以及 `secrets-manifest` 等补充 templates
- `buildCompleteSlicePrompt`：丢弃 requirements 和 UAT template 的内联
- `buildCompleteMilestonePrompt`：丢弃根级 GSD 文件内联
- `buildReassessRoadmapPrompt`：丢弃 project、requirements 和 decisions 文件

这些裁剪是累积式的：`standard` 会丢掉一部分，`minimal` 会丢掉更多；`full` 则保留全部上下文（也就是 v2.17 之前的行为）。

### 覆盖 Inline Level

Inline level 由 `token_profile` 推导而来。如果你想独立于 profile 控制阶段行为，请使用 `phases` 偏好设置：

```yaml
---
version: 1
token_profile: budget
phases:
  skip_research: false    # 覆盖：即使是 budget，也执行 research
---
```

显式设置的 `phases` 总是优先于 profile 默认值。

<a id="complexity-based-task-routing"></a>
## 基于复杂度的 Task 路由

当启用 dynamic routing 时，GSD 会根据复杂度对每个 task 做分类，并将其路由到合适的 model tier。简单的文档修复会使用更便宜的模型，而复杂的架构工作会获得所需的推理能力。

> **前提条件：** Dynamic routing 需要在偏好设置里显式配置 `models`。如果没有 `models` 段，routing 会被跳过，所有 phases 都会使用会话启动时的 model。Token profiles 会自动设置 `models`。

> **上限行为：** 当 dynamic routing 启用时，每个 phase 中配置的 model 充当的是**上限**，而不是固定绑定。Router 可以为更简单的工作降级到更便宜的 model，但绝不会超过你配置的 model。

### 分类如何工作

Tasks 会通过分析 task plan 来分类：

| 信号 | Simple | Standard | Complex |
|------|--------|----------|---------|
| Step 数量 | ≤ 3 | 4-7 | ≥ 8 |
| 文件数 | ≤ 3 | 4-7 | ≥ 8 |
| 描述长度 | < 500 chars | 500-2000 | > 2000 chars |
| 代码块数 | — | — | ≥ 5 |
| 信号词 | 无 | 任意出现 | — |

**会阻止判定为 simple 的信号词：** `research`、`investigate`、`refactor`、`migrate`、`integrate`、`complex`、`architect`、`redesign`、`security`、`performance`、`concurrent`、`parallel`、`distributed`、`backward compat`、`migration`、`architecture`、`concurrency`、`compatibility`。

空 plan 或格式错误的 plan 会默认归类到 `standard`（偏保守的选择）。

### Unit Type 默认值

非 task 单元也有内置的 tier 分配：

| Unit Type | 默认 Tier |
|-----------|-----------|
| `complete-slice`、`run-uat` | Light |
| `research-*`、`plan-*`、`execute-task`、`complete-milestone` | Standard |
| `replan-slice`、`reassess-roadmap` | Heavy |
| `hook/*` | Light |

### Model 路由

每个 tier 会映射到某类 model 配置：

| Tier | 对应 Model Phase Key | 常见 Model |
|------|----------------------|------------|
| Light | `completion` | Haiku（budget）/ 用户默认值 |
| Standard | `execution` | Sonnet / 用户默认值 |
| Heavy | `execution` | Opus / 用户默认值 |

如果配置了 `execution_simple`，simple tasks 会优先使用它。`budget` profile 会自动把该键设为 Haiku。

<a id="budget-pressure"></a>
### 预算压力

当接近预算上限时，分类器会自动降低 tier：

| 已使用预算 | 影响 |
|------------|------|
| < 50% | 不调整 |
| 50-75% | Standard → Light |
| 75-90% | Standard → Light |
| > 90% | 除 Heavy 之外全部 → Light；Heavy → Standard |

这种逐步降级方式能尽量把最复杂工作的模型质量保留下来，同时随着预算逼近上限逐步降低成本。

## 自适应学习（Routing History）

GSD 会随着时间推移记录每个 tier 分配的成功 / 失败情况，并据此调整未来的分类。它默认自动生效，并持久化在 `.gsd/routing-history.json` 中。

### 工作方式

1. 每个工作单元完成后，系统会把结果（成功 / 失败）记录到对应的 unit type 和 tier 上
2. 结果会按 pattern 跟踪，例如 `execute-task` 或 `execute-task:docs`，并维护最近 50 条的滚动窗口
3. 如果某个 pattern 下某个 tier 的失败率超过 20%，未来相同 pattern 的分类会自动上调一个 tier
4. 系统也支持更细粒度的 tag pattern，例如 `execute-task:test` 和 `execute-task:frontend`

### 用户反馈

你可以通过 `/gsd rate` 为最近完成的工作单元提交反馈：

```
/gsd rate over    # model 太强了，下次更倾向便宜一点
/gsd rate ok      # model 选得合适，不调整
/gsd rate under   # model 太弱了，下次更倾向强一点
```

这些反馈的权重是自动结果的 2 倍。要求 dynamic routing 已启用（最近完成的单元必须带有 tier 数据）。

### 数据管理

```bash
# Routing history 按项目存储
.gsd/routing-history.json

# 清空历史以重置自适应学习
# （通过 routing-history 模块 API 完成）
```

反馈数组最多保留 200 条。每个 pattern 的结果统计使用 50 条滚动窗口，以防陈旧数据长期主导判断。

## 配置示例

### 成本优先配置

```yaml
---
version: 1
token_profile: budget
budget_ceiling: 25.00
models:
  execution_simple: claude-haiku-4-5-20250414
---
```

### 使用自定义 Models 的平衡配置

```yaml
---
version: 1
token_profile: balanced
models:
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
  execution: claude-sonnet-4-6
---
```

### 面向关键工作的高质量配置

```yaml
---
version: 1
token_profile: quality
models:
  planning: claude-opus-4-6
  execution: claude-opus-4-6
---
```

### 按阶段覆盖

`token_profile` 会设置默认值，但显式偏好始终优先：

```yaml
---
version: 1
token_profile: budget
phases:
  skip_research: false       # 覆盖：保留 milestone research
models:
  planning: claude-opus-4-6  # 覆盖：即使是 budget profile，planning 也用 Opus
---
```

## 这些机制如何协同

```
PREFERENCES.md
  └─ token_profile: balanced
       ├─ resolveProfileDefaults() → model 默认值 + phase 跳过默认值
       ├─ resolveInlineLevel() → standard
       │    └─ prompt builders 根据 level 决定纳入哪些上下文
       ├─ classifyUnitComplexity() → 路由到 execution / execution_simple model
       │    ├─ task plan 分析（steps、files、signals）
       │    ├─ unit type 默认值
       │    ├─ budget pressure 调整
       │    ├─ 从 routing-history.json 做自适应学习
       │    └─ capability scoring（当 `capability_routing: true` 时）
       │         └─ 7 维 model profile × task requirement vectors
       └─ context_management
            ├─ observation masking（before_provider_request hook）
            ├─ tool result truncation（tool_result_max_chars）
            └─ phase handoff anchors（注入 prompt builders）
```

Profile 会在 dispatch pipeline 的起点解析一次，并一路向下流动。每一层上，显式偏好都优先于 profile 默认值。

## Observation Masking

*引入于 v2.59.0*

在自动模式会话中，tool results 会不断堆积在会话历史里并占用上下文窗口。Observation masking 会在每次 LLM 调用前，把早于最近 N 个 user turns 的 tool result 内容替换成轻量占位符。这样可以在**不增加任何 LLM 开销**的前提下减少 token 使用：不需要额外总结调用，也不会带来额外延迟。

Observation masking 在自动模式中默认开启。可通过偏好设置控制：

```yaml
context_management:
  observation_masking: true     # 默认：true（设为 false 可关闭）
  observation_mask_turns: 8     # 保留最近 8 个 user turns 内的结果（范围：1-50）
  tool_result_max_chars: 800    # 单个 tool result 超过该长度时进行截断
```

### 工作方式

1. 每次 provider request 之前，`before_provider_request` hook 会检查 messages 数组
2. 早于阈值的 tool results（`toolResult`、`bashExecution`）会被替换成 `[result masked — within summarized history]`
3. 最近的 tool results（仍在保留窗口内）会完整保留
4. 所有 assistant 和 user messages 始终保留，只有 tool result 内容会被 masking

它与现有的 compaction 系统配套：masking 负责减少两次 compaction 之间的上下文压力，而 compaction 负责在窗口填满时执行完整上下文重置。

### Tool Result Truncation

单个 tool result 如果超过 `tool_result_max_chars`（默认 800），会被加上 `…[truncated]` 标记后截断。这可以防止某一次特别大的工具输出独占上下文窗口。

## Phase Handoff Anchors

*引入于 v2.59.0*

当自动模式在 phases 之间切换（research → planning → execution）时，系统会把结构化 JSON anchors 写到 `.gsd/milestones/<mid>/anchors/<phase>.json`。下游 prompt builders 会自动注入这些 anchors，让下一阶段继承前一阶段的意图、决策、阻塞点和下一步，而不必重新从 artifact 文件里推断。

这能减少上下文漂移，也就是企业级 agent 失败案例中最常见的一类问题：agent 在 phase 边界上丢失了之前的决策脉络。

Anchors 会在 `research-milestone`、`research-slice`、`plan-milestone` 和 `plan-slice` 成功完成后自动写入，不需要任何配置。

## Prompt Compression

*引入于 v2.29.0*

GSD 可以在退回到 section-boundary truncation 之前，先做确定性的 prompt compression。这样在上下文超预算时，可以保留更多信息。

### 压缩策略

在偏好设置中配置：

```yaml
---
version: 1
compression_strategy: compress
---
```

可用策略有两个：

| 策略 | 行为 | 默认适用对象 |
|------|------|--------------|
| `truncate` | 在边界处整段丢弃 section（v2.29 之前的行为） | `quality` profile |
| `compress` | 先做启发式文本压缩，如果仍超预算，再截断 | `budget` 和 `balanced` profiles |

Compression 会确定性地去掉冗余空白、缩短啰嗦表达、去重重复内容并删除低信息量样板文本，不涉及任何 LLM 调用。

### 上下文选择

控制文件如何内联进 prompt：

```yaml
---
version: 1
context_selection: smart
---
```

| 模式 | 行为 | 默认适用对象 |
|------|------|--------------|
| `full` | 内联完整文件 | `balanced` 和 `quality` profiles |
| `smart` | 对大文件（>3KB）使用 TF-IDF 语义分块，只纳入相关部分 | `budget` profile |

### 结构化数据压缩

在 `budget` 和 `balanced` 的 inline level 下，decisions 和 requirements 会被格式化成更紧凑的表示方式，相比完整 markdown tables 可节省 30-50% tokens。

### Summary Distillation

如果某个 slice 有 3 个以上依赖 summary，且总量超过 summary 预算，GSD 会先提取结构化核心数据（`provides`、`requires`、`key_files`、`key_decisions`），丢弃冗长 prose 段落，然后才会退回到 section-boundary truncation。

### Cache Hit Rate Tracking

指标账本现在会为每个工作单元记录 `cacheHitRate`（输入 tokens 中来自缓存的比例），并提供 `aggregateCacheHitRate()` 用于统计整场会话的缓存表现。
