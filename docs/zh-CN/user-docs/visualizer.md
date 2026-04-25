# 工作流可视化器

*引入于 v2.19.0*

工作流可视化器是一个全屏 TUI 叠层视图，以交互式四标签页的形式展示项目进度、依赖关系、成本指标和执行时间线。

## 打开可视化器

```
/gsd visualize
```

或者配置为在 milestone 完成后自动显示：

```yaml
auto_visualize: true
```

## 标签页

可通过 `Tab`、`1`-`4` 或方向键切换标签页。

### 1. 进度

以树状视图展示 milestones、slices 和 tasks 的完成状态：

```
M001: User Management                        3/6 tasks ⏳
  ✅ S01: Auth module                         3/3 tasks
    ✅ T01: Core types
    ✅ T02: JWT middleware
    ✅ T03: Login flow
  ⏳ S02: User dashboard                      1/2 tasks
    ✅ T01: Layout component
    ⬜ T02: Profile page
  ⬜ S03: Admin panel                         0/1 tasks
```

已完成项显示勾选，进行中项显示转圈，待处理项显示空框。每一层级也会显示 task 数量和完成百分比。

如果某个 milestone 经过 discussion 阶段，还会显示**讨论状态**，用于表明需求是否已经记录，以及讨论停留在哪个状态。

### 2. 依赖

用 ASCII 依赖图展示 slices 之间的关系：

```
S01 ──→ S02 ──→ S04
  └───→ S03 ──↗
```

它会把 roadmap 中的 `depends:` 字段可视化出来，便于快速判断哪些 slices 被阻塞、哪些可以继续推进。

### 3. 指标

通过柱状图展示成本和 Token 使用情况：

- **按阶段**：research、planning、execution、completion、reassessment
- **按 slice**：每个 slice 的成本以及累计总额
- **按模型**：哪些模型消耗了最多预算

数据来自 `.gsd/metrics.json`。

### 4. 时间线

按时间顺序展示执行历史，包括：

- 单元类型和 ID
- 开始 / 结束时间戳
- 持续时间
- 使用的模型
- Token 数量

条目按执行时间排序，因此可以看到自动模式的完整派发历史。

## 控制

| 按键 | 动作 |
|------|------|
| `Tab` | 下一个标签页 |
| `Shift+Tab` | 上一个标签页 |
| `1`-`4` | 直接跳转到标签页 |
| `↑` / `↓` | 在当前标签页内滚动 |
| `Escape` / `q` | 关闭可视化器 |

## 自动刷新

可视化器每 2 秒从磁盘刷新一次数据，因此即使它和自动模式会话同时打开，也能保持最新状态。

## HTML 导出（v2.26）

如果需要在终端外部分享报告，可以使用 `/gsd export --html`。它会在 `.gsd/reports/` 中生成一个自包含的 HTML 文件，包含与 TUI 可视化器相同的数据：进度树、依赖图（SVG DAG）、成本 / Token 柱状图、执行时间线、变更日志和知识库。所有 CSS 和 JS 都会内联，无外部依赖，也可以在任意浏览器中打印为 PDF。

自动生成的 `index.html` 会集中列出所有报告，并显示跨 milestones 的推进指标。

```yaml
auto_report: true    # 在 milestone 完成后自动生成（默认开启）
```

## 配置

```yaml
auto_visualize: true    # 在 milestone 完成后显示可视化器
```
