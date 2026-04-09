# Parallel Milestone Orchestration

Run multiple milestones simultaneously in isolated git worktrees. Each milestone gets its own worker process, its own branch, and its own context window — while a coordinator tracks progress, enforces budgets, and keeps everything in sync.

> **Status:** Behind `parallel.enabled: false` by default. Opt-in only — zero impact to existing users.

## Quick Start

1. Enable parallel mode in your preferences:

```yaml
---
parallel:
  enabled: true
  max_workers: 2
---
```

2. Start parallel execution:

```
/gsd parallel start
```

GSD scans your milestones, checks dependencies and file overlap, shows an eligibility report, and spawns workers for eligible milestones.

3. Monitor progress:

```
/gsd parallel status
```

4. Stop when done:

```
/gsd parallel stop
```

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Coordinator (your GSD session)                         │
│                                                         │
│  Responsibilities:                                      │
│  - Eligibility analysis (deps + file overlap)           │
│  - Worker spawning and lifecycle                        │
│  - Budget tracking across all workers                   │
│  - Signal dispatch (pause/resume/stop)                  │
│  - Session status monitoring                            │
│  - Merge reconciliation                                 │
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

### Worker Isolation

Each worker is a separate `gsd` process with complete isolation:

| Resource | Isolation Method |
|----------|-----------------|
| **Filesystem** | Git worktree — each worker has its own checkout |
| **Git branch** | `milestone/<MID>` — one branch per milestone |
| **State derivation** | `GSD_MILESTONE_LOCK` env var — `deriveState()` only sees the assigned milestone |
| **Context window** | Separate process — each worker has its own agent sessions |
| **Metrics** | Each worktree has its own `.gsd/metrics.json` |
| **Crash recovery** | Each worktree has its own `.gsd/auto.lock` |

### Coordination

Workers and the coordinator communicate through file-based IPC:

- **Session status files** (`.gsd/parallel/<MID>.status.json`) — workers write heartbeats, the coordinator reads them
- **Signal files** (`.gsd/parallel/<MID>.signal.json`) — coordinator writes signals, workers consume them
- **Atomic writes** — write-to-temp + rename prevents partial reads

## Eligibility Analysis

Before starting parallel execution, GSD checks which milestones can safely run concurrently.

### Rules

1. **Not complete** — Finished milestones are skipped
2. **Dependencies satisfied** — All `dependsOn` entries must have status `complete`
3. **File overlap check** — Milestones touching the same files get a warning (but are still eligible)

### Example Report

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

File overlaps are warnings, not blockers. Both milestones work in separate worktrees, so they won't interfere at the filesystem level. Conflicts are detected and resolved during merge.

## Configuration

Add to `~/.gsd/PREFERENCES.md` or `.gsd/PREFERENCES.md`:

```yaml
---
parallel:
  enabled: false            # Master toggle (default: false)
  max_workers: 2            # Concurrent workers (1-4, default: 2)
  budget_ceiling: 50.00     # Aggregate cost limit in dollars (optional)
  merge_strategy: "per-milestone"  # When to merge: "per-slice" or "per-milestone"
  auto_merge: "confirm"            # "auto", "confirm", or "manual"
---
```

### Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Master toggle. Must be `true` for `/gsd parallel` commands to work. |
| `max_workers` | number (1-4) | `2` | Maximum concurrent worker processes. Higher values use more memory and API budget. |
| `budget_ceiling` | number | none | Aggregate cost ceiling in USD across all workers. When reached, no new units are dispatched. |
| `merge_strategy` | `"per-slice"` or `"per-milestone"` | `"per-milestone"` | When worktree changes merge back to main. Per-milestone waits for the full milestone to complete. |
| `auto_merge` | `"auto"`, `"confirm"`, `"manual"` | `"confirm"` | How merge-back is handled. `confirm` prompts before merging. `manual` requires explicit `/gsd parallel merge`. |

## Commands

| Command | Description |
|---------|-------------|
| `/gsd parallel start` | Analyze eligibility, confirm, and start workers |
| `/gsd parallel status` | Show all workers with state, units completed, and cost |
| `/gsd parallel stop` | Stop all workers (sends SIGTERM) |
| `/gsd parallel stop M002` | Stop a specific milestone's worker |
| `/gsd parallel pause` | Pause all workers (finish current unit, then wait) |
| `/gsd parallel pause M002` | Pause a specific worker |
| `/gsd parallel resume` | Resume all paused workers |
| `/gsd parallel resume M002` | Resume a specific worker |
| `/gsd parallel merge` | Merge all completed milestones back to main |
| `/gsd parallel merge M002` | Merge a specific milestone back to main |

## Signal Lifecycle

The coordinator communicates with workers through signals:

```
Coordinator                    Worker
    │                            │
    ├── sendSignal("pause") ──→  │
    │                            ├── consumeSignal()
    │                            ├── pauseAuto()
    │                            │   (finish current unit, wait)
    │                            │
    ├── sendSignal("resume") ─→  │
    │                            ├── consumeSignal()
    │                            ├── resume dispatch loop
    │                            │
    ├── sendSignal("stop") ───→  │
    │   + SIGTERM ────────────→  │
    │                            ├── consumeSignal() or SIGTERM handler
    │                            ├── stopAuto()
    │                            └── process exits
```

Workers check for signals between units (in `handleAgentEnd`). The coordinator also sends `SIGTERM` for immediate response on stop.

## Merge Reconciliation

When milestones complete, their worktree changes need to merge back to main.

### Merge Order

- **Sequential** (default): Milestones merge in ID order (M001 before M002)
- **By-completion**: Milestones merge in the order they finish

### Conflict Handling

1. `.gsd/` state files (STATE.md, metrics.json, etc.) — **auto-resolved** by accepting the milestone branch version
2. Code conflicts — **stop and report**. The merge halts, showing which files conflict. Resolve manually and retry with `/gsd parallel merge <MID>`.

### Example

```
/gsd parallel merge

# Merge Results

- **M002** — merged successfully (pushed)
- **M003** — CONFLICT (2 file(s)):
  - `src/types.ts`
  - `src/middleware.ts`
  Resolve conflicts manually and run `/gsd parallel merge M003` to retry.
```

## Budget Management

When `budget_ceiling` is set, the coordinator tracks aggregate cost across all workers:

- Cost is summed from each worker's session status
- When the ceiling is reached, the coordinator signals workers to stop
- Each worker also respects the project-level `budget_ceiling` preference independently

## Health Monitoring

### Doctor Integration

`/gsd doctor` detects parallel session issues:

- **Stale parallel sessions** — Worker process died without cleanup. Doctor finds `.gsd/parallel/*.status.json` files with dead PIDs or expired heartbeats and removes them.

Run `/gsd doctor --fix` to clean up automatically.

### Stale Detection

Sessions are considered stale when:
- The worker PID is no longer running (checked via `process.kill(pid, 0)`)
- The last heartbeat is older than 30 seconds

The coordinator runs stale detection during `refreshWorkerStatuses()` and automatically removes dead sessions.

## Safety Model

| Safety Layer | Protection |
|-------------|------------|
| **Feature flag** | `parallel.enabled: false` by default — existing users unaffected |
| **Eligibility analysis** | Dependency and file overlap checks before starting |
| **Worker isolation** | Separate processes, worktrees, branches, context windows |
| **`GSD_MILESTONE_LOCK`** | Each worker only sees its milestone in state derivation |
| **`GSD_PARALLEL_WORKER`** | Workers cannot spawn nested parallel sessions |
| **Budget ceiling** | Aggregate cost enforcement across all workers |
| **Signal-based shutdown** | Graceful stop via file signals + SIGTERM |
| **Doctor integration** | Detects and cleans up orphaned sessions |
| **Conflict-aware merge** | Stops on code conflicts, auto-resolves `.gsd/` state conflicts |

## File Layout

```
.gsd/
├── parallel/                    # Coordinator ↔ worker IPC
│   ├── M002.status.json         # Worker heartbeat + progress
│   ├── M002.signal.json         # Coordinator → worker signals
│   ├── M003.status.json
│   └── M003.signal.json
├── worktrees/                   # Git worktrees (one per milestone)
│   ├── M002/                    # M002's isolated checkout
│   │   ├── .gsd/                # M002's own state files
│   │   │   ├── auto.lock
│   │   │   ├── metrics.json
│   │   │   └── milestones/
│   │   └── src/                 # M002's working copy
│   └── M003/
│       └── ...
└── ...
```

Both `.gsd/parallel/` and `.gsd/worktrees/` are gitignored — they're runtime-only coordination files that never get committed.

## Troubleshooting

### "Parallel mode is not enabled"

Set `parallel.enabled: true` in your preferences file.

### "No milestones are eligible for parallel execution"

All milestones are either complete or blocked by dependencies. Check `/gsd queue` to see milestone status and dependency chains.

### Worker crashed — how to recover

Workers now persist their state to disk automatically. If a worker process dies, the coordinator detects the dead PID via heartbeat expiry and marks the worker as crashed. On restart, the worker picks up from disk state — crash recovery, worktree re-entry, and completed-unit tracking carry over from the crashed session.

1. Run `/gsd doctor --fix` to clean up stale sessions
2. Run `/gsd parallel status` to see current state
3. Re-run `/gsd parallel start` to spawn new workers for remaining milestones

### Merge conflicts after parallel completion

1. Run `/gsd parallel merge` to see which milestones have conflicts
2. Resolve conflicts in the worktree at `.gsd/worktrees/<MID>/`
3. Retry with `/gsd parallel merge <MID>`

### Workers seem stuck

Check if budget ceiling was reached: `/gsd parallel status` shows per-worker costs. Increase `parallel.budget_ceiling` or remove it to continue.
