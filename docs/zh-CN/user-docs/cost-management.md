# 成本管理

GSD 会跟踪自动模式中每个派发工作单元的 Token 使用量和成本。这些数据会驱动仪表板、预算约束以及成本预测。

## 成本跟踪

每个工作单元的指标都会被自动记录：

- **Token 数量**：input、output、cache read、cache write、total
- **成本**：每个单元的美元成本
- **耗时**：真实墙钟时间
- **工具调用数**：工具调用次数
- **消息数量**：assistant 与 user 消息数

数据保存在 `.gsd/metrics.json` 中，并且可跨会话持续存在。

### 查看成本

**仪表板**：按 `Ctrl+Alt+G` 或执行 `/gsd status` 可查看实时成本拆分。

**可用聚合维度：**

- 按阶段（research、planning、execution、completion、reassessment）
- 按 slice（M001/S01、M001/S02 等）
- 按模型（哪些模型最耗预算）
- 项目总计

## 预算上限

可以为单个项目设置最大支出：

```yaml
---
version: 1
budget_ceiling: 50.00
---
```

### 执行模式

控制触达预算上限后会发生什么：

```yaml
budget_enforcement: pause    # 设置 ceiling 后的默认值
```

| 模式 | 行为 |
|------|------|
| `warn` | 记录警告，但继续执行 |
| `pause` | 暂停自动模式，等待用户动作 |
| `halt` | 直接停止自动模式 |

## 成本预测

当至少完成两个 slices 后，GSD 会预测剩余成本：

```
Projected remaining: $12.40 ($6.20/slice avg × 2 remaining)
```

预测基于已完成工作的每-slice 平均成本。如果预算上限已触达，结果中还会附带一条警告。

## 预算压力与模型降级

当预算接近上限时，[复杂度路由器](./token-optimization.md#budget-pressure)会自动把模型分配降到更便宜的层级。这是一个渐进过程：

- **已使用 < 50%**：不调整
- **已使用 50-75%**：standard task 降为 light
- **已使用 75-90%**：同样降级，但更激进
- **已使用 > 90%**：几乎所有 task 都降级，只有 heavy task 仍保留在 standard

这样可以把预算尽量均匀地分摊到剩余工作中，而不是过早在几个复杂 task 上耗尽。

## Token 配置与成本

`token_profile` 偏好会直接影响成本：

| 配置 | 常见节省幅度 | 方式 |
|------|--------------|------|
| `budget` | 40-60% | 更便宜的模型、跳过部分阶段、最小上下文 |
| `balanced` | 10-20% | 默认模型、跳过 slice research、标准上下文 |
| `quality` | 0%（基线） | 完整模型、完整阶段、完整上下文 |

更多细节见 [Token 优化](./token-optimization.md)。

## 建议

- 先用 `balanced` 配置，并设置一个较宽松的 `budget_ceiling` 来建立成本基线
- 完成几个 slices 后查看 `/gsd status`，确认每个 slice 的平均成本
- 对于已知流程、重复性高的工作，切换到 `budget` 配置
- 只有在做架构决策时才建议使用 `quality`
- 可以通过按阶段选模型，只在 planning 使用 Opus，而在 execution 保持 Sonnet
- 开启 `dynamic_routing`，让简单 task 自动下沉到更便宜的模型，详见 [动态模型路由](./dynamic-model-routing.md)
- 使用 `/gsd visualize` 的 Metrics 标签页查看预算具体花在了哪里
