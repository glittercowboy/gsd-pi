# 动态模型路由

*引入于 v2.19.0。Capability scoring 引入于 v2.52.0。*

动态模型路由会为简单工作自动选择更便宜的模型，并把昂贵模型留给复杂 task。这样在有成本上限的套餐下，通常可以减少 20-50% 的 token 消耗，同时在关键位置保持质量。

从 v2.52.0 开始，router 使用 **capability-aware scoring**，为每个 task 选择最合适的 model，而不只是简单挑选该 tier 里最便宜的。

## 工作原理

自动模式派发的每个工作单元都会经过一个两阶段流水线：

**阶段 1：复杂度分类**：先把工作划分到某个 tier（light / standard / heavy）。

**阶段 2：能力评分**：在符合该 tier 的候选 models 里，根据它们的能力和 task 需求的匹配程度进行排序。

核心规则是：**只允许降级，不允许升级**。用户在偏好设置中配置的 model 始终是上限，router 不会把它升级到比你配置更强的 model。

| Tier | 典型工作 | 默认模型级别 |
|------|----------|--------------|
| **Light** | slice completion、UAT、hooks | Haiku 级 |
| **Standard** | research、planning、execution、milestone completion | Sonnet 级 |
| **Heavy** | replan、roadmap reassessment、复杂 execution | Opus 级 |

## 启用方式

动态路由默认关闭。可在偏好设置中开启：

```yaml
---
version: 1
dynamic_routing:
  enabled: true
---
```

## 配置

```yaml
dynamic_routing:
  enabled: true
  tier_models:                    # 可选：为每个 tier 显式指定 model
    light: claude-haiku-4-5
    standard: claude-sonnet-4-6
    heavy: claude-opus-4-6
  escalate_on_failure: true       # task 失败时提升 tier（默认：true）
  budget_pressure: true           # 接近预算上限时自动降级（默认：true）
  cross_provider: true            # 可跨 provider 选择 model（默认：true）
  hooks: true                     # 是否对 post-unit hooks 也应用路由（默认：true）
  capability_routing: true        # 在 tier 内启用 capability scoring（默认：true）
```

### `tier_models`

覆盖每个 tier 默认使用的 model。如果省略，router 会使用内置 capability mapping，它已经知道一些常见 model 家族的大致定位：

- **Light：** `claude-haiku-4-5`、`gpt-4o-mini`、`gemini-2.0-flash`
- **Standard：** `claude-sonnet-4-6`、`gpt-4o`、`gemini-2.5-pro`
- **Heavy：** `claude-opus-4-6`、`gpt-4.5-preview`、`gemini-2.5-pro`

### `escalate_on_failure`

当 task 在某个 tier 上失败时，router 会在重试时提升到下一层：Light → Standard → Heavy。这样可以避免便宜模型在其实需要更强推理能力的工作上浪费重试次数。

### `budget_pressure`

当预算接近上限时，router 会逐步降低 tier：

| 已使用预算 | 影响 |
|------------|------|
| < 50% | 不调整 |
| 50-75% | Standard → Light |
| 75-90% | 更激进地降级 |
| > 90% | 几乎所有工作都 → Light；只有 Heavy 保持在 Standard |

### `cross_provider`

开启后，router 可以从你的主 provider 之外选择 model。它会使用内置成本表，在每个 tier 里找到最便宜的 model。要求目标 provider 已经正确配置。

### `capability_routing`

开启后（默认：true），router 会通过 capability scoring 在某个 tier 内选出“最适合”的 model，而不是永远只选最便宜的那个。设为 `false` 可恢复到纯 cheapest-in-tier 行为：

```yaml
dynamic_routing:
  enabled: true
  capability_routing: false   # 关闭评分，改用 tier 内最便宜的 model
```

## Capability Profiles

每个 model 都有一个内置的 **capability profile**，它是一个 7 维评分（0-100），表示该 model 在不同 task 类型下的能力强弱：

| 维度 | 含义 |
|------|------|
| `coding` | 代码生成和实现准确性 |
| `debugging` | 诊断与修复错误的能力 |
| `research` | 信息综合与主题探索能力 |
| `reasoning` | 多步逻辑推理能力 |
| `speed` | 延迟与吞吐（可视为能力深度的反向维度） |
| `longContext` | 处理大代码库和长文档的能力 |
| `instruction` | 精确遵循结构化指令的能力 |

目前 9 个 models 带有内置 profile：`claude-opus-4-6`、`claude-sonnet-4-6`、`claude-haiku-4-5`、`gpt-4o`、`gpt-4o-mini`、`gemini-2.5-pro`、`gemini-2.0-flash`、`deepseek-chat`、`o3`。

没有内置 profile 的 models 会收到**全维度均为 50** 的默认分数。这是一个冷启动策略：未知模型可以参与竞争，但不会凭空占优。从用户角度看，这类模型的路由行为和 capability scoring 引入前保持一致。

**这些 profiles 是启发式排序，不是 benchmark。** 它们表达的是大致的相对优势，而不是经过严格验证的 benchmark 结果。如果你很了解某个 model，可通过用户覆盖项（见下文）修正这些分值。

## 评分方式

tier 内的路由流程如下：

```
classify complexity tier
    ↓
filter eligible models for tier
    ↓
fire before_model_select hook (optional override)
    ↓
capability score eligible models
    ↓
select winner (or first eligible if scoring is disabled)
```

**评分公式：** 各能力维度的加权平均

```
score = Σ(weight × capability) / Σ(weights)
```

**Task requirements** 是动态的，不同 unit types 对维度的权重不同：

| Unit Type | 核心维度 |
|-----------|----------|
| `execute-task` | coding (0.9)、instruction (0.7)、speed (0.3) |
| `research-*` | research (0.9)、longContext (0.7)、reasoning (0.5) |
| `plan-*` | reasoning (0.9)、coding (0.5) |
| `replan-slice` | reasoning (0.9)、debugging (0.6)、coding (0.5) |
| `complete-slice`、`run-uat` | instruction (0.8)、speed (0.7) |

对于 `execute-task`，router 还会进一步根据 task metadata 微调需求：

- 带有 `docs`、`config`、`readme` 等 tag：提高 instruction 权重
- 包含 `concurrency`、`compatibility` 等关键词：提高 debugging 和 reasoning 权重
- 包含 `migration`、`architecture` 等关键词：提高 reasoning 和 coding 权重
- 文件数较多（≥6）或估计行数较大（≥500）：提高 coding 和 reasoning 权重

**平分时的决策：** 当两个 models 的得分相差不超过 2 分时，优先选择更便宜的那个。如果成本也相同，则按 model ID 字典序打破平局（确定性结果）。

## 用户覆盖

如果你对某个 model 的能力认知比内置 profile 更准确，可以通过 `models` 配置里的 `modelOverrides` 修正：

```json
{
  "providers": {
    "anthropic": {
      "modelOverrides": {
        "claude-sonnet-4-6": {
          "capabilities": {
            "debugging": 90,
            "research": 85
          }
        }
      }
    }
  }
}
```

这些覆盖会与内置默认值进行**深度合并**：你只需覆盖指定维度，未指定的维度仍保留内置值。

**典型用法：** 如果你发现某个 model 在某一类工作上持续优于内置 profile，就覆盖对应维度，把 router 更积极地引导到该 model。

## 详细输出

开启 verbose mode 时，router 会把自己的路由决策打印出来。如果使用了 capability scoring，日志会包含完整评分拆分：

```
Dynamic routing [S]: claude-sonnet-4-6 (capability-scored) — claude-sonnet-4-6: 82.3, gpt-4o: 78.1, deepseek-chat: 72.0
```

如果只使用了 tier 级路由（例如评分被禁用、只有一个符合条件的 model，或命中了路由守卫）：

```
Dynamic routing [S]: claude-sonnet-4-6 (standard complexity, multiple steps)
```

路由决策中的 `selectionMethod` 字段会说明采用了哪种路径：

- `"capability-scored"`：使用 capability scoring 选出了最终 model
- `"tier-only"`：使用了 tier 内最便宜的 model（或显式固定值）

## 扩展 Hook

扩展可以通过 `before_model_select` hook 拦截并覆盖 model 选择。

Hook 触发时机在 **tier 过滤之后**（已知符合条件的 models），但在 **capability scoring 之前**（尚未计算分数）。Hook 可以完全接管选择，也可以返回 `undefined`，让 scoring 按默认逻辑继续。

**注册处理器：**

```typescript
pi.on("before_model_select", async (event) => {
  const { unitType, unitId, classification, taskMetadata, eligibleModels, phaseConfig } = event;

  // 自定义路由策略：research 一律优先用 gemini
  if (unitType.startsWith("research-")) {
    const gemini = eligibleModels.find(id => id.includes("gemini"));
    if (gemini) return { modelId: gemini };
  }

  // 返回 undefined，让 capability scoring 继续
  return undefined;
});
```

**事件负载：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `unitType` | `string` | 当前派发单元类型（例如 `"execute-task"`） |
| `unitId` | `string` | 此次单元派发的唯一标识符 |
| `classification` | `{ tier, reason, downgraded }` | 复杂度分类结果 |
| `taskMetadata` | `Record<string, unknown> \| undefined` | 从单元 plan 中提取出的 task 元数据 |
| `eligibleModels` | `string[]` | 符合该 tier 的 models |
| `phaseConfig` | `{ primary, fallbacks } \| undefined` | 用户为该 phase 配置的 model |

**返回值：** `{ modelId: string }` 表示覆盖默认选择；返回 `undefined` 表示交给 capability scoring。

**第一个覆盖者生效：** 如果多个扩展都注册了处理器，第一个返回非 `undefined` 的处理器获胜，后续处理器不会再被调用。

## 复杂度分类

工作单元通过纯启发式规则分类，不涉及 LLM 调用，耗时通常低于 1ms。

### Unit Type 默认值

| Unit Type | 默认 Tier |
|-----------|-----------|
| `complete-slice`、`run-uat` | Light |
| `research-*`、`plan-*`、`complete-milestone` | Standard |
| `execute-task` | Standard（可被 task 分析升级） |
| `replan-slice`、`reassess-roadmap` | Heavy |
| `hook/*` | Light |

### Task Plan 分析

对于 `execute-task` 单元，分类器会分析 task plan：

| 信号 | 简单 → Light | 复杂 → Heavy |
|------|--------------|--------------|
| Step 数量 | ≤ 3 | ≥ 8 |
| 文件数 | ≤ 3 | ≥ 8 |
| 描述长度 | < 500 chars | > 2000 chars |
| 代码块数 | — | ≥ 5 |
| 复杂度关键词 | 无 | 有 |

**复杂度关键词：** `research`、`investigate`、`refactor`、`migrate`、`integrate`、`complex`、`architect`、`redesign`、`security`、`performance`、`concurrent`、`parallel`、`distributed`、`backward compat`

### 自适应学习

路由历史（`.gsd/routing-history.json`）会按 unit type 和 tier 记录成功 / 失败情况。如果某种模式下某个 tier 的失败率超过 20%，未来相似分类会自动上调一个 tier。用户反馈（`over` / `under` / `ok`）的权重是自动结果的 2 倍。

## 与 Token Profile 的关系

动态路由和 token profile 是互补的：

- **Token profiles**（`budget` / `balanced` / `quality`）控制阶段跳过和上下文压缩
- **Dynamic routing** 控制每个工作单元在对应 phase 内的 model 选择

两者同时开启时，token profile 负责给出基础模型集，dynamic routing 再在这些基础之上做进一步优化。`budget` token profile + dynamic routing 组合能带来最大的成本节省。

## 成本表

Router 内置了一张常见 models 的成本表，用于跨 provider 成本比较。成本单位都是每百万 tokens（input / output）：

| Model | Input | Output |
|-------|-------|--------|
| claude-haiku-4-5 | $0.80 | $4.00 |
| claude-sonnet-4-6 | $3.00 | $15.00 |
| claude-opus-4-6 | $15.00 | $75.00 |
| gpt-4o-mini | $0.15 | $0.60 |
| gpt-4o | $2.50 | $10.00 |
| gemini-2.0-flash | $0.10 | $0.40 |

这张成本表仅用于比较，实际计费仍然来自你所使用的 provider。
