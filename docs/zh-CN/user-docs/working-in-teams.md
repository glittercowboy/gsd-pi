# 团队协作

GSD 支持多人并行工作流，让多个开发者可以同时在同一个仓库中工作。

## 设置

### 1. 启用 Team Mode

为团队使用配置 GSD 的最简单方法，是在项目偏好中设置 `mode: team`。这会一次性开启唯一 milestone ID、推送分支和预合并检查：

```yaml
# .gsd/PREFERENCES.md（项目级，提交到 git）
---
version: 1
mode: team
---
```

这相当于手动设置 `unique_milestone_ids: true`、`git.push_branches: true`、`git.pre_merge_check: true` 以及其他适合团队协作的默认值。你仍然可以覆盖单个选项，例如如果团队偏好自动推送，也可以在 `mode: team` 基础上再加 `git.auto_push: true`。

你也可以不使用 mode，而是单独配置每一项设置（详见 [Git 策略](git-strategy.md)）。

### 2. 配置 `.gitignore`

共享规划产物（milestones、roadmaps、decisions），同时把运行时文件保留在本地：

```bash
# ── GSD：运行时 / 临时文件（按开发者、按会话隔离）──────
.gsd/auto.lock
.gsd/completed-units.json
.gsd/STATE.md
.gsd/metrics.json
.gsd/activity/
.gsd/runtime/
.gsd/worktrees/
.gsd/milestones/**/continue.md
.gsd/milestones/**/*-CONTINUE.md
```

**会共享的内容**（提交到 git）：

- `.gsd/PREFERENCES.md`：项目偏好
- `.gsd/PROJECT.md`：持续维护的项目描述
- `.gsd/REQUIREMENTS.md`：需求契约
- `.gsd/DECISIONS.md`：架构决策
- `.gsd/milestones/`：roadmaps、plans、summaries 和 research

**仅保留本地的内容**（gitignore）：

- 锁文件、指标、状态缓存、运行时记录、worktrees、活动日志

### 3. 提交偏好设置

```bash
git add .gsd/PREFERENCES.md
git commit -m "chore: enable GSD team workflow"
```

## `commit_docs: false`

如果团队里只有部分成员使用 GSD，或者公司策略要求仓库保持干净：

```yaml
git:
  commit_docs: false
```

这会把整个 `.gsd/` 加入 `.gitignore`，让所有产物都保留在本地。这样使用 GSD 的开发者仍然能获得结构化规划的好处，而不会影响不使用 GSD 的同事。

## 迁移现有项目

如果你当前项目里对 `.gsd/` 做了整目录忽略：

1. 确保当前没有进行中的 milestones（工作区状态干净）
2. 按上面的选择性规则更新 `.gitignore`
3. 在 `.gsd/PREFERENCES.md` 中添加 `unique_milestone_ids: true`
4. 如有需要，重命名现有 milestones 以使用唯一 ID：
   ```
   I have turned on unique milestone ids, please update all old milestone
   ids to use this new format e.g. M001-abc123 where abc123 is a random
   6 char lowercase alpha numeric string. Update all references in all
   .gsd file contents, file names and directory names. Validate your work
   once done to ensure referential integrity.
   ```
5. 提交修改

## 计划评审工作流

对于会把规划产物纳入 git 跟踪的团队（也就是设置了 `mode: team`，并且没有把 `.gsd/milestones/` 加入 gitignore），可以使用双 PR 流程，在开始写代码之前先完成计划审批：

1. **Plan PR**：开发者在 `main` 上运行 `/gsd discuss`，它会把规划产物写入 `.gsd/milestones/<MID>/`（如 `<MID>-CONTEXT.md` 和 `<MID>-ROADMAP.md`），并更新顶层的 `.gsd/REQUIREMENTS.md` 与 `.gsd/DECISIONS.md`。开发者提交这些文档，然后发起一个纯文档 PR。
2. **Review**：团队直接在 GitHub 中审查 scope、风险、slice 拆分和完成定义。这时还没有代码需要审，只评审计划。
3. **Code PR**：计划 PR 合并后，开发者拉取最新 `main` 并运行 `/gsd auto`。GSD 会创建 worktree，并基于已批准的计划执行，最终形成第二个包含实际实现的 PR。

`/gsd discuss` 不会自动提交，开发者可以自行决定何时、以什么方式提交这些规划产物。

### Reviewer 应重点看什么

- **`<MID>-CONTEXT.md`**：scope 是否定义清楚？约束和非目标是否明确？
- **`<MID>-ROADMAP.md`**：slice 拆分是否合理？顺序是否符合依赖关系？
- **`.gsd/DECISIONS.md`**：架构选择是否有充分理由？

### 执行期间的引导

如果开发者在自动模式 worktree 内运行 `/gsd steer`，这些调整会保留在该 worktree 本地，并写入 worktree 中的 `.gsd/OVERRIDES.md`，不会去修改 `main` 上已经批准的计划文档。这些变化会随着实现代码一起出现在 code PR 的 diff 中。如果在 worktree 外运行 `/gsd steer`，则会修改当前所在 checkout 的内容。

### 自动化 gate

如果团队希望每个 slice 开始前都强制有一次讨论检查点，而不只是 milestone 级别，可以在偏好中加入 `require_slice_discussion: true`：

```yaml
phases:
  require_slice_discussion: true
```

这样一来，当某个 slice 缺少自己的 slice `CONTEXT` 文件时，自动模式会暂停，并要求开发者先对该 slice 执行 `/gsd discuss`，之后才能继续。

## 并行开发

多个开发者可以同时对不同 milestones 运行自动模式。每个开发者都会：

- 获得自己的 worktree（`.gsd/worktrees/<MID>/`，已加入 gitignore）
- 在独立的 `milestone/<MID>` 分支上工作
- 独立地 squash merge 回主分支

milestone 依赖可以通过 `M00X-CONTEXT.md` frontmatter 声明：

```yaml
---
depends_on: [M001-eh88as]
---
```

GSD 会强制要求上游依赖 milestone 先完成，之后才会启动下游工作。
