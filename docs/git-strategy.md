# Git Strategy

GSD uses git worktrees for milestone isolation and sequential commits within each milestone. The strategy is fully automated — you don't need to manage branches manually.

## Branching Model

```
main ─────────────────────────────────────────────────────────
  │                                                     ↑
  └── milestone/M001 (worktree) ────────────────────────┘
       commit: feat(S01/T01): core types
       commit: feat(S01/T02): markdown parser
       commit: feat(S01/T03): file writer
       commit: docs(M001/S01): workflow docs
       ...
       → squash-merged to main as single commit
```

### Key Properties

- **One worktree per milestone** — all work happens in `.gsd/worktrees/<MID>/`
- **Sequential commits on one branch** — no per-slice branches, no merge conflicts within a milestone
- **Squash merge to main** — when the milestone completes, all commits are squashed into one clean commit on main
- **Worktree teardown** — after merge, the worktree and branch are cleaned up

### Commit Format

Commits use conventional commit format with scope:

```
feat(S01/T01): core type definitions
feat(S01/T02): markdown parser for plan files
fix(M001/S03): bug fixes and doc corrections
docs(M001/S04): workflow documentation
```

## Worktree Management

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
```

### `commit_docs: false`

When set to `false`, GSD adds `.gsd/` to `.gitignore` and keeps all planning artifacts local-only. Useful for teams where only some members use GSD, or when company policy requires a clean repository.

## Self-Healing

GSD includes automatic recovery for common git issues:

- **Detached HEAD** — automatically reattaches to the correct branch
- **Stale lock files** — removes `index.lock` files from crashed processes
- **Orphaned worktrees** — detects and offers to clean up abandoned worktrees

Run `/gsd doctor` to check git health manually.

## Native Git Operations

Since v2.16, GSD uses libgit2 via native bindings for read-heavy operations in the dispatch hot path. This eliminates ~70 process spawns per dispatch cycle, improving auto-mode throughput.
