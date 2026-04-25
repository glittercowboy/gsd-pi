# 并行 Milestone 编排

在隔离的 git worktrees 中同时运行多个 milestones。每个 milestone 都拥有自己的 worker 进程、自己的分支和自己的上下文窗口；同时还会有一个 coordinator 跟踪进度、执行预算限制并保持整体同步。

> **状态：** 该功能默认处于 `parallel.enabled: false`。属于显式 opt-in，对现有用户零影响。

## 快速开始

1. 在偏好设置中开启并行模式：

```yaml
---
parallel:
  enabled: true
  max_workers: 2
---
```

2. 启动并行执行：

```
/gsd parallel start
```

GSD 会扫描所有 milestones，检查依赖与文件重叠，给出一份可并行性报告，并为符合条件的 milestones 启动 workers。

3. 监控进度：

```
/gsd parallel status
```

4. 完成后停止：

```
/gsd parallel stop
```

## 工作原理

### 架构

```
┌─────────────────────────────────────────────────────────┐
│  Coordinator（你的 GSD 会话）                           │
│                                                         │
│  职责：                                                 │
│  - 可并行性分析（依赖 + 文件重叠）                      │
│  - Worker 启动与生命周期管理                            │
│  - 全部 workers 的预算跟踪                              │
│  - 派发控制信号（pause / resume / stop）                │
│  - 会话状态监控                                         │
│  - Merge 对账                                           │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Worker 1 │  │ Worker 2 │  │ Worker 3 │  ...          │
│  │ M001     │  │ M003     │  │ M005     │              │
│  └──────────┘  └──────────┘  └──────────┘              │
│       │              │              │                   │
│       ▼              ▼              ▼                   │
│  .gsd/worktrees/ .gsd/worktrees/ .gsd/worktrees/       │
│  M001/           M003/           M005/                  │
│  (milestone/     (milestone/     (milestone/            │
│   M001 branch)    M003 branch)    M005 branch)          │
└─────────────────────────────────────────────────────────┘
```

### Worker 隔离

每个 worker 都是一个完全隔离的独立 `gsd` 进程：

| 资源 | 隔离方式 |
|------|----------|
| **文件系统** | Git worktree：每个 worker 都有自己的 checkout |
| **Git 分支** | `milestone/<MID>`：每个 milestone 一条分支 |
| **状态推导** | 通过 `GSD_MILESTONE_LOCK` 环境变量，让 `deriveState()` 只看到被分配的 milestone |
| **上下文窗口** | 独立进程：每个 worker 都有自己的 agent sessions |
| **指标** | 每个 worktree 都有自己的 `.gsd/metrics.json` |
| **崩溃恢复** | 每个 worktree 都有自己的 `.gsd/auto.lock` |

### 协调方式

Workers 和 coordinator 通过基于文件的 IPC 通信：

- **会话状态文件**（`.gsd/parallel/<MID>.status.json`）：worker 写入 heartbeat，coordinator 读取
- **信号文件**（`.gsd/parallel/<MID>.signal.json`）：coordinator 写信号，worker 消费
- **原子写入**：使用写临时文件再 rename 的方式，避免读到半成品

## 可并行性分析

在真正启动并行执行之前，GSD 会先检查哪些 milestones 可以安全并发运行。

### 规则

1. **未完成**：已完成的 milestones 会被跳过
2. **依赖满足**：所有 `dependsOn` 指向的 milestones 都必须已处于 `complete`
3. **文件重叠检查**：如果多个 milestones 会触碰同一批文件，会给出警告（但仍可执行）

### 示例报告

```
# Parallel Eligibility Report

## Eligible for Parallel Execution (2)

- **M002** — Auth System
  All dependencies satisfied.
- **M003** — Dashboard UI
  All dependencies satisfied.

## Ineligible (2)

- **M001** — Core Types
  Already complete.
- **M004** — API Integration
  Blocked by incomplete dependencies: M002.

## File Overlap Warnings (1)

- **M002** <-> **M003** — 2 shared file(s):
  - `src/types.ts`
  - `src/middleware.ts`
```

文件重叠只是警告，不是阻断条件。因为两个 milestones 会运行在各自独立的 worktree 中，它们不会在文件系统层面互相干扰。真正的冲突会在 merge 阶段被检测和处理。

## 配置

把下面内容加到 `~/.gsd/PREFERENCES.md` 或 `.gsd/PREFERENCES.md`：

```yaml
---
parallel:
  enabled: false            # 总开关（默认：false）
  max_workers: 2            # 并发 workers 数（1-4，默认：2）
  budget_ceiling: 50.00     # 聚合成本上限（美元，可选）
  merge_strategy: "per-milestone"  # 何时 merge："per-slice" 或 "per-milestone"
  auto_merge: "confirm"            # "auto"、"confirm" 或 "manual"
---
```

### 配置参考

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `enabled` | boolean | `false` | 总开关。只有设为 `true`，`/gsd parallel` 命令才可用。 |
| `max_workers` | number（1-4） | `2` | 最大并发 worker 进程数。值越高，内存与 API 预算消耗也越高。 |
| `budget_ceiling` | number | 无 | 所有 workers 的聚合美元预算上限。达到后不会再派发新单元。 |
| `merge_strategy` | `"per-slice"` 或 `"per-milestone"` | `"per-milestone"` | worktree 变更何时回合并到主分支。Per-milestone 会等整个 milestone 完成后再合并。 |
| `auto_merge` | `"auto"`、`"confirm"`、`"manual"` | `"confirm"` | merge-back 策略。`confirm` 会在合并前询问；`manual` 要求显式执行 `/gsd parallel merge`。 |

## 命令

| 命令 | 说明 |
|------|------|
| `/gsd parallel start` | 分析可并行性、确认并启动 workers |
| `/gsd parallel status` | 显示所有 workers 的状态、已完成单元和成本 |
| `/gsd parallel stop` | 停止所有 workers（发送 SIGTERM） |
| `/gsd parallel stop M002` | 停止某个指定 milestone 的 worker |
| `/gsd parallel pause` | 暂停所有 workers（完成当前单元后等待） |
| `/gsd parallel pause M002` | 暂停某个指定 worker |
| `/gsd parallel resume` | 恢复所有已暂停 workers |
| `/gsd parallel resume M002` | 恢复某个指定 worker |
| `/gsd parallel merge` | 把所有已完成 milestones 合并回 main |
| `/gsd parallel merge M002` | 只把某个指定 milestone 合并回 main |

## 信号生命周期

Coordinator 通过信号和 workers 通信：

```
Coordinator                    Worker
    │                            │
    ├── sendSignal("pause") ──→  │
    │                            ├── consumeSignal()
    │                            ├── pauseAuto()
    │                            │   (完成当前单元后等待)
    │                            │
    ├── sendSignal("resume") ─→  │
    │                            ├── consumeSignal()
    │                            ├── 继续 dispatch loop
    │                            │
    ├── sendSignal("stop") ───→  │
    │   + SIGTERM ────────────→  │
    │                            ├── consumeSignal() or SIGTERM handler
    │                            ├── stopAuto()
    │                            └── 进程退出
```

Workers 会在单元之间检查信号（位于 `handleAgentEnd`）。在 stop 场景下，coordinator 还会额外发送 `SIGTERM` 来提高响应速度。

## Merge 对账

当 milestones 完成后，它们在 worktree 中的改动需要 merge 回主分支。

### Merge 顺序

- **顺序合并**（默认）：按 milestone ID 顺序合并（M001 在 M002 之前）
- **按完成顺序合并**：按照 milestones 实际完成的先后顺序合并

### 冲突处理

1. `.gsd/` 状态文件（如 `STATE.md`、`metrics.json`）会**自动解决**，默认接受 milestone 分支版本
2. 代码冲突则会**停止并报告**。合并会暂停，并显示哪些文件冲突。你需要手动解决后，再执行 `/gsd parallel merge <MID>` 重试

### 示例

```
/gsd parallel merge

# Merge Results

- **M002** — merged successfully (pushed)
- **M003** — CONFLICT (2 file(s)):
  - `src/types.ts`
  - `src/middleware.ts`
  Resolve conflicts manually and run `/gsd parallel merge M003` to retry.
```

## 预算管理

当设置了 `budget_ceiling` 时，coordinator 会跟踪所有 workers 的聚合成本：

- 成本会从每个 worker 的 session status 中汇总
- 达到上限后，coordinator 会向 workers 发出停止信号
- 每个 worker 仍会独立遵守项目级 `budget_ceiling` 偏好

## 健康监控

### Doctor 集成

`/gsd doctor` 能检测并行会话相关问题：

- **过期的并行会话**：worker 进程已经死亡，但没有清理干净。Doctor 会检查 `.gsd/parallel/*.status.json` 中记录的 PID 和 heartbeat，发现失效后自动清理。

可以执行 `/gsd doctor --fix` 自动清理。

### 过期检测

满足以下任一条件时，会话会被视为 stale：

- Worker PID 已经不存在（通过 `process.kill(pid, 0)` 检查）
- 最近一次 heartbeat 超过 30 秒

Coordinator 会在 `refreshWorkerStatuses()` 中执行 stale detection，并自动移除已经死亡的会话。

## 安全模型

| 安全层 | 保护内容 |
|--------|----------|
| **Feature flag** | 默认 `parallel.enabled: false`，不影响现有用户 |
| **可并行性分析** | 启动前检查依赖和文件重叠 |
| **Worker 隔离** | 独立进程、worktrees、分支、上下文窗口 |
| **`GSD_MILESTONE_LOCK`** | 每个 worker 在状态推导时只能看到自己的 milestone |
| **`GSD_PARALLEL_WORKER`** | Worker 不能再嵌套启动新的并行会话 |
| **预算上限** | 跨所有 workers 执行聚合成本限制 |
| **信号式关闭** | 通过文件信号 + SIGTERM 优雅停止 |
| **Doctor 集成** | 检测并清理孤儿会话 |
| **冲突感知 merge** | 遇到代码冲突时停止；`.gsd/` 状态冲突自动解决 |

## 文件布局

```
.gsd/
├── parallel/                    # Coordinator ↔ worker IPC
│   ├── M002.status.json         # Worker heartbeat + progress
│   ├── M002.signal.json         # Coordinator → worker signals
│   ├── M003.status.json
│   └── M003.signal.json
├── worktrees/                   # Git worktrees（每个 milestone 一个）
│   ├── M002/                    # M002 的隔离 checkout
│   │   ├── .gsd/                # M002 自己的状态文件
│   │   │   ├── auto.lock
│   │   │   ├── metrics.json
│   │   │   └── milestones/
│   │   └── src/                 # M002 的工作副本
│   └── M003/
│       └── ...
└── ...
```

`.gsd/parallel/` 和 `.gsd/worktrees/` 都会被 gitignore，因为它们只是运行时协调文件，永远不会提交。

## 故障排查

### “Parallel mode is not enabled”

在偏好设置里加入 `parallel.enabled: true`。

### “No milestones are eligible for parallel execution”

说明所有 milestones 要么已完成，要么被依赖阻塞。可通过 `/gsd queue` 查看 milestone 状态和依赖链。

### Worker 崩溃后如何恢复

Workers 会自动把状态持久化到磁盘。如果某个 worker 进程死亡，coordinator 会通过 heartbeat 超时检测到死掉的 PID，并把该 worker 标记为 crashed。重启后，worker 会从磁盘状态继续：崩溃恢复、worktree 重入和 completed-unit 跟踪都会延续之前的状态。

1. 执行 `/gsd doctor --fix` 清理 stale sessions
2. 执行 `/gsd parallel status` 查看当前状态
3. 重新执行 `/gsd parallel start`，为剩余 milestones 启动新的 workers

### 并行执行完成后发生 merge 冲突

1. 执行 `/gsd parallel merge` 查看哪些 milestones 存在冲突
2. 在 `.gsd/worktrees/<MID>/` 对应的 worktree 中手动解决冲突
3. 执行 `/gsd parallel merge <MID>` 重试

### Workers 看起来卡住了

先检查是否触达了预算上限：`/gsd parallel status` 会显示每个 worker 的成本。继续执行的话，提升 `parallel.budget_ceiling` 或直接移除它。
