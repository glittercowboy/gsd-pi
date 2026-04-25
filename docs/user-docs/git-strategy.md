# Git Strategy

GSD uses git for milestone isolation and sequential commits within each milestone. You choose an **isolation mode** that controls where work happens. The strategy is fully automated — you don't need to manage branches manually.

## Isolation Modes

GSD supports three isolation modes, configured via the `git.isolation` preference:

| Mode | Working Directory | Branch | Best For |
|------|-------------------|--------|----------|
| `worktree` (default) | `.gsd/worktrees/<MID>/` | `milestone/<MID>` | Most projects — full file isolation between milestones |
| `branch` | Project root | `milestone/<MID>` | Submodule-heavy repos where worktrees don't work well |
| `none` | Project root | Current branch (no milestone branch) | Hot-reload workflows where file isolation breaks dev tooling |

### `worktree` Mode (Default)

Each milestone gets its own git worktree at `.gsd/worktrees/<MID>/` on a `milestone/<MID>` branch. All execution happens inside the worktree. On completion, the worktree is squash-merged to main as one clean commit. The worktree and branch are then cleaned up.

This provides full file isolation — changes in a milestone can't interfere with your main working copy.

### `branch` Mode

Work happens in the project root on a `milestone/<MID>` branch. No worktree is created. On completion, the branch is merged to main (squash or regular merge, per `merge_strategy`).

Use this when worktrees cause problems — submodule-heavy repos, repos with hardcoded paths, or environments where worktree symlinks don't behave.

### `none` Mode

Work happens directly on your current branch. No worktree, no milestone branch. GSD still commits sequentially with conventional commit messages, but there's no branch isolation.

Use this for hot-reload workflows where file isolation breaks dev tooling (e.g., file watchers that only see the project root), or for small projects where branch overhead isn't worth it.

## Branching Model (Worktree Mode)

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

In **branch mode**, the flow is the same except work happens in the project root instead of a separate worktree directory.

In **none mode**, commits land directly on the current branch — no milestone branch is created, and no merge step is needed.

### Parallel Worktrees

With [parallel orchestration](./parallel-orchestration.md) enabled, multiple milestones run in separate worktrees simultaneously:

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

Each worktree operates on its own branch with its own commit history. Merges happen sequentially to avoid conflicts.

### Key Properties

- **Sequential commits on one branch** — no per-slice branches, no merge conflicts within a milestone
- **Squash merge to main** — in worktree and branch modes, all commits are squashed into one clean commit on main (configurable via `merge_strategy`)

### Commit Format

Commits use conventional commit format with GSD metadata in trailers:

```
feat: core type definitions

GSD-Task: M001/S01/T01

feat: markdown parser for plan files

GSD-Task: M001/S01/T02
```

## Worktree Management

These features apply only in **worktree mode**.

### Automatic (Auto Mode)

Auto mode creates and manages worktrees automatically:

1. When a milestone starts, a worktree is created at `.gsd/worktrees/<MID>/` on branch `milestone/<MID>`
2. Planning artifacts from `.gsd/milestones/` are copied into the worktree
3. All execution happens inside the worktree
4. On milestone completion, the worktree is squash-merged to the integration branch
5. The worktree and branch are removed

### Manual

Use the `/worktree` (or `/wt`) command for manual worktree management:

```
/worktree create
/worktree switch
/worktree merge
/worktree remove
```

## Workflow Modes

Instead of configuring each git setting individually, set `mode` to get sensible defaults for your workflow:

```yaml
mode: solo    # personal projects — auto-push, squash, simple IDs
mode: team    # shared repos — unique IDs, push branches, pre-merge checks
```

| Setting | `solo` | `team` |
|---|---|---|
| `git.auto_push` | `true` | `false` |
| `git.push_branches` | `false` | `true` |
| `git.pre_merge_check` | `false` | `true` |
| `git.merge_strategy` | `"squash"` | `"squash"` |
| `git.isolation` | `"worktree"` | `"worktree"` |
| `git.commit_docs` | `true` | `true` |
| `unique_milestone_ids` | `false` | `true` |

Mode defaults are the lowest priority — any explicit preference overrides them. For example, `mode: solo` with `git.auto_push: false` gives you everything from solo except auto-push.

Existing configs without `mode` work exactly as before — no defaults are injected.

## Git Preferences

Configure git behavior in preferences:

```yaml
git:
  auto_push: false            # push after commits
  push_branches: false        # push milestone branch
  remote: origin
  snapshots: false            # WIP snapshot commits
  pre_merge_check: false      # pre-merge validation
  commit_type: feat           # override commit type prefix
  main_branch: main           # primary branch name
  commit_docs: true           # commit .gsd/ to git
  isolation: worktree         # "worktree", "branch", or "none"
  auto_pr: false              # create PR on milestone completion
  pr_target_branch: develop   # PR target branch (default: main)
```

### Automatic Pull Requests

For teams using Gitflow or branch-based workflows, GSD can automatically create a pull request when a milestone completes:

```yaml
git:
  auto_push: true
  auto_pr: true
  pr_target_branch: develop
```

This pushes the milestone branch and creates a PR targeting `develop` (or whichever branch you specify). Requires `gh` CLI installed and authenticated. See [git.auto_pr](./configuration.md#gitauto_pr) for details.
```

### `commit_docs: false`

When set to `false`, GSD adds `.gsd/` to `.gitignore` and keeps all planning artifacts local-only. Useful for teams where only some members use GSD, or when company policy requires a clean repository.

## Self-Healing

GSD includes automatic recovery for common git issues:

- **Detached HEAD** — automatically reattaches to the correct branch
- **Stale lock files** — removes `index.lock` files from crashed processes
- **Orphaned worktrees** — detects and offers to clean up abandoned worktrees (worktree mode only)

Run `/gsd doctor` to check git health manually.

## Native Git Operations

Since v2.16, GSD uses libgit2 via native bindings for read-heavy operations in the dispatch hot path. This eliminates ~70 process spawns per dispatch cycle, improving auto-mode throughput.
