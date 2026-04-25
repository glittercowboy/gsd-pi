# Git 策略

GSD 使用 git 来实现 milestone 隔离，以及每个 milestone 内部的顺序提交。你可以通过 **isolation mode** 控制工作发生在哪里。整个策略是自动化的，你不需要手工管理分支。

## 隔离模式

GSD 支持三种隔离模式，通过 `git.isolation` 偏好设置：

| 模式 | 工作目录 | 分支 | 适用场景 |
|------|----------|------|----------|
| `worktree`（默认） | `.gsd/worktrees/<MID>/` | `milestone/<MID>` | 大多数项目，milestones 之间文件完全隔离 |
| `branch` | 项目根目录 | `milestone/<MID>` | 子模块较多、worktree 表现不佳的仓库 |
| `none` | 项目根目录 | 当前分支（不建 milestone 分支） | 热重载工作流中，文件隔离会破坏开发工具的场景 |

### `worktree` 模式（默认）

每个 milestone 都会在 `.gsd/worktrees/<MID>/` 下拥有自己的 git worktree，对应一个 `milestone/<MID>` 分支。所有执行都发生在该 worktree 中。完成后，worktree 会被 squash merge 回主分支，形成一个干净的提交，然后清理对应 worktree 和分支。

这提供了完整的文件隔离，某个 milestone 的变更不会干扰你的主工作副本。

### `branch` 模式

工作直接在项目根目录中的 `milestone/<MID>` 分支上进行，不会创建 worktree。完成后，该分支会被合并回主分支（是 squash merge 还是普通 merge 由 `merge_strategy` 控制）。

当 worktree 会带来问题时使用它，例如：子模块较多的仓库、包含硬编码路径的仓库、或者 worktree symlink 表现异常的环境。

### `none` 模式

工作直接发生在当前分支。没有 worktree，也没有 milestone 分支。GSD 依然会按顺序提交，并使用 conventional commit message，但不会提供分支级隔离。

适用于热重载工作流中“文件隔离会破坏开发工具”的情况（例如只能监视项目根目录的文件监听器），或者很小的项目里不值得承担分支开销的情况。

## 分支模型（worktree 模式）

```
main ─────────────────────────────────────────────────────────
  │                                                     ↑
  └── milestone/M001 (worktree) ────────────────────────┘
       commit: feat: core types
       commit: feat: markdown parser
       commit: feat: file writer
       commit: docs: workflow docs
       ...
       → squash-merged to main as single commit
```

在 **branch 模式** 下，流程相同，只是工作发生在项目根目录而不是独立的 worktree 目录。

在 **none 模式** 下，提交直接落到当前分支，不会创建 milestone 分支，也不需要合并步骤。

### 并行 worktrees

如果启用了 [并行编排](./parallel-orchestration.md)，多个 milestones 可以同时运行在各自独立的 worktree 中：

```
main ──────────────────────────────────────────────────────────
  │                                      ↑              ↑
  ├── milestone/M002 (worktree) ─────────┘              │
  │    commit: feat: auth types                         │
  │    commit: feat: JWT middleware                     │
  │    → squash-merged first                            │
  │                                                     │
  └── milestone/M003 (worktree) ────────────────────────┘
       commit: feat: dashboard layout
       commit: feat: chart components
       → squash-merged second
```

每个 worktree 都工作在自己的分支和自己的提交历史上。为了避免冲突，合并会顺序进行。

### 关键特性

- **单分支顺序提交**：没有按 slice 单独分支，也不会在单个 milestone 内产生合并冲突
- **Squash merge 到主分支**：在 worktree 和 branch 模式下，所有提交最终都会以一个干净的提交压缩到主分支（可通过 `merge_strategy` 配置）

### 提交格式

提交使用 conventional commit 格式，并在 trailer 中带上 GSD 元数据：

```
feat: core type definitions

GSD-Task: M001/S01/T01

feat: markdown parser for plan files

GSD-Task: M001/S01/T02
```

## Worktree 管理

以下特性仅适用于 **worktree 模式**。

### 自动（自动模式）

自动模式会自动创建并管理 worktrees：

1. milestone 启动时，在 `.gsd/worktrees/<MID>/` 创建 worktree，并切到 `milestone/<MID>` 分支
2. 将 `.gsd/milestones/` 下的规划产物复制到该 worktree
3. 所有执行都发生在 worktree 内部
4. milestone 完成后，把该 worktree squash merge 回集成分支
5. 删除 worktree 和对应分支

### 手动

使用 `/worktree`（或 `/wt`）命令手动管理 worktree：

```
/worktree create
/worktree switch
/worktree merge
/worktree remove
```

## 工作流模式

如果不想逐个配置 git 设置，可以通过 `mode` 获得一组更合理的默认值：

```yaml
mode: solo    # 个人项目：自动推送、squash、简单 ID
mode: team    # 共享仓库：唯一 ID、推送分支、预合并检查
```

| 设置 | `solo` | `team` |
|---|---|---|
| `git.auto_push` | `true` | `false` |
| `git.push_branches` | `false` | `true` |
| `git.pre_merge_check` | `false` | `true` |
| `git.merge_strategy` | `"squash"` | `"squash"` |
| `git.isolation` | `"worktree"` | `"worktree"` |
| `git.commit_docs` | `true` | `true` |
| `unique_milestone_ids` | `false` | `true` |

Mode 默认值的优先级最低，任何显式偏好设置都会覆盖它们。例如，`mode: solo` 配合 `git.auto_push: false`，就表示除了自动推送以外，其它行为都沿用 solo 的默认配置。

已有但未设置 `mode` 的配置会保持原样，不会被自动注入新默认值。

## Git 偏好设置

可以在偏好设置中配置 git 行为：

```yaml
git:
  auto_push: false            # 提交后推送
  push_branches: false        # 推送 milestone 分支
  remote: origin
  snapshots: false            # WIP 快照提交
  pre_merge_check: false      # 合并前校验
  commit_type: feat           # 覆盖提交类型前缀
  main_branch: main           # 主分支名称
  commit_docs: true           # 将 .gsd/ 提交到 git
  isolation: worktree         # "worktree"、"branch" 或 "none"
  auto_pr: false              # milestone 完成时自动创建 PR
  pr_target_branch: develop   # PR 目标分支（默认 main）
```

### 自动创建 Pull Request

对于使用 Gitflow 或分支工作流的团队，GSD 可以在 milestone 完成时自动创建 pull request：

```yaml
git:
  auto_push: true
  auto_pr: true
  pr_target_branch: develop
```

这样会把 milestone 分支推送到远程，并创建一个目标分支为 `develop`（或你指定的其它分支）的 PR。要求已安装并认证 `gh` CLI。详见 [git.auto_pr](./configuration.md#gitauto_pr)。

### `commit_docs: false`

当设置为 `false` 时，GSD 会把 `.gsd/` 添加到 `.gitignore`，所有规划产物只保留在本地。适合只有部分成员使用 GSD 的团队，或者公司要求仓库保持干净的场景。

## 自愈能力

GSD 内置了对常见 git 问题的自动恢复：

- **Detached HEAD**：自动重新附着到正确分支
- **过期锁文件**：移除崩溃进程残留的 `index.lock`
- **孤儿 worktree**：检测并提供清理废弃 worktree 的选项（仅 worktree 模式）

可通过 `/gsd doctor` 手动检查 git 健康状态。

## 原生 Git 操作

从 v2.16 起，GSD 在派发热路径中的读密集 git 操作改用 libgit2 原生绑定。这消除了每次派发周期中约 70 次进程拉起，从而提升了自动模式吞吐量。
