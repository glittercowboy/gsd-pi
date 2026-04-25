# Git & Worktrees

GSD uses git for milestone isolation and sequential commits. The strategy is fully automated — you don't need to manage branches manually.

## Isolation Modes

GSD supports three isolation modes, configured via `git.isolation` in preferences:

| Mode | Working Directory | Branch | Best For |
|------|-------------------|--------|----------|
| `worktree` (default) | `.gsd/worktrees/<MID>/` | `milestone/<MID>` | Most projects — full isolation |
| `branch` | Project root | `milestone/<MID>` | Submodule-heavy repos |
| `none` | Project root | Current branch | Hot-reload workflows |

### Worktree Mode (Default)

Each milestone gets its own git worktree and branch. All execution happens inside the worktree. On completion, everything is squash-merged to main as one clean commit. The worktree and branch are then cleaned up.

Changes in a milestone can't interfere with your main working copy.

### Branch Mode

Work happens in the project root on a `milestone/<MID>` branch. No worktree directory is created. Useful when worktrees cause problems with submodules or hardcoded paths.

### None Mode

Work happens directly on your current branch. No worktree, no milestone branch. GSD still commits with conventional commit messages. Use this when file isolation breaks dev tooling (file watchers, hot-reload, etc.).

## Branching Model

```
main ────────────────────────────────────────────
  │                                          ↑
  └── milestone/M001 (worktree) ─────────────┘
       commit: feat: core types
       commit: feat: markdown parser
       commit: feat: file writer
       → squash-merged to main
```

## Workflow Modes

Set `mode` for sensible defaults instead of configuring each setting individually:

```yaml
mode: solo    # personal projects
mode: team    # shared repos
```

| Setting | `solo` | `team` |
|---------|--------|--------|
| `git.auto_push` | `true` | `false` |
| `git.push_branches` | `false` | `true` |
| `git.pre_merge_check` | `false` | `true` |
| `unique_milestone_ids` | `false` | `true` |

Mode defaults are the lowest priority — any explicit preference overrides them.

## Git Preferences

```yaml
git:
  auto_push: false            # push after commits
  push_branches: false        # push milestone branch to remote
  remote: origin              # git remote name
  snapshots: true             # WIP snapshot commits during long tasks
  pre_merge_check: auto       # validation before merge
  commit_type: feat           # override conventional commit prefix
  main_branch: main           # primary branch name
  merge_strategy: squash      # "squash" or "merge"
  isolation: worktree         # "worktree", "branch", or "none"
  commit_docs: true           # commit .gsd/ artifacts to git
  manage_gitignore: true      # let GSD manage .gitignore
  auto_pr: false              # create PR on milestone completion
  pr_target_branch: develop   # PR target branch
  collapse_cadence: milestone # "milestone" (default) or "slice"
  milestone_resquash: true    # re-squash slice commits at milestone end (cadence=slice)
```

## Collapse Cadence

`git.collapse_cadence` controls **when** work is squash-merged from the milestone branch back to main.

| Value | When main gets updated | Orphan window | Best for |
|-------|------------------------|---------------|----------|
| `milestone` (default) | Once, at milestone completion | Entire milestone | Small milestones, clean PR history |
| `slice` | Each time a slice passes validation | One slice | Large milestones, long-running sessions, parallel work |

### Slice Cadence

When `collapse_cadence: "slice"`, each slice's commits are squash-merged to main as soon as the slice passes validation. The milestone branch is then fast-forwarded to main so the next slice starts from a clean base.

Benefits:
- **Shorter orphan window** — if a session is interrupted, only the active slice's work is at risk, not the whole milestone.
- **Incremental conflicts** — merge conflicts surface per slice rather than all at once at milestone end.
- **Parallel-friendly** — multiple milestones can safely merge their validated slices to main without waiting for the slowest one.

Trade-off: without re-squash, main accumulates N commits per milestone (one per slice) instead of one.

```yaml
git:
  collapse_cadence: slice
```

### Milestone Re-squash

When `collapse_cadence: "slice"` AND `milestone_resquash: true` (the default when cadence is slice), GSD collapses the per-slice commits on main into a single milestone commit at milestone completion. Main history looks identical to `collapse_cadence: "milestone"` — one commit per milestone — but the orphan-window and incremental-conflict benefits of slice cadence are preserved.

Set `milestone_resquash: false` if you want the slice commits preserved in main history (for bisect granularity, per-slice revert, etc.).

```yaml
git:
  collapse_cadence: slice
  milestone_resquash: false   # keep slice commits in main history
```

### Which to use?

- **Default (`milestone`)** is fine for most projects. Each milestone produces one commit on main.
- **`slice`** pays off when milestones have 5+ slices, long wall-clock time, or you've hit orphan issues after interrupted sessions.
- Run `/gsd forensics` after sessions to see orphan detection and merge telemetry — the **Worktree Telemetry** section reports how often work was stranded, which informs whether slice cadence would help.

## Automatic Pull Requests

For teams using Gitflow or branch-based workflows:

```yaml
git:
  auto_push: true
  auto_pr: true
  pr_target_branch: develop
```

When a milestone completes, GSD pushes the branch and creates a PR targeting your specified branch. Requires `gh` CLI installed and authenticated.

## Post-Worktree Hook

Run a script after worktree creation (copy `.env` files, symlink assets, etc.):

```yaml
git:
  worktree_post_create: .gsd/hooks/post-worktree-create
```

Example hook:

```bash
#!/bin/bash
cp "$SOURCE_DIR/.env" "$WORKTREE_DIR/.env"
ln -sf "$SOURCE_DIR/assets" "$WORKTREE_DIR/assets"
```

## Keeping `.gsd/` Local

For teams where only some members use GSD:

```yaml
git:
  commit_docs: false
```

This adds `.gsd/` to `.gitignore` entirely. You get structured planning without affecting teammates who don't use GSD.

## Commit Format

Commits use conventional commit format with GSD metadata:

```
feat: core type definitions

GSD-Task: M001/S01/T01
```

## Manual Worktree Management

Use `/worktree` (or `/wt`) for manual worktree operations:

```
/worktree create
/worktree switch
/worktree merge
/worktree remove
```

## Self-Healing

GSD automatically recovers from common git issues:

- **Detached HEAD** — reattaches to the correct branch
- **Stale lock files** — removes `index.lock` from crashed processes
- **Orphaned worktrees** — detects and cleans up abandoned worktrees

Run `/gsd doctor` to check git health manually.
