# Parallel Milestone Orchestration

Run multiple milestones simultaneously in isolated git worktrees. Each milestone gets its own worker process, its own branch, and its own context window, while the shared GSD database tracks worker liveness, milestone ownership, dispatch status, retry windows, and control commands.

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

Workers and the coordinator communicate through DB-backed coordination tables in `.gsd/gsd.db`:

- **`workers`** — registry of active auto-mode workers with heartbeat TTL and shutdown/crash status
- **`milestone_leases`** — one-worker-at-a-time milestone ownership with fencing tokens for safe takeover after expiry or release
- **`unit_dispatches`** — dispatch ledger that records claim, running, completed, failed, stuck, canceled, and retry timing state per unit
- **`command_queue`** — targeted or broadcast control commands claimed atomically by workers

If a worker stops heartbeating, its lease can expire and another worker can safely take over the milestone. Retry-aware stuck detection also consults the dispatch ledger so a unit waiting for `next_run_at` is not misclassified as stuck.

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

Workers poll the command queue between units and the coordinator also sends `SIGTERM` for immediate response on stop. Heartbeats and lease refreshes happen continuously during the loop, so `parallel status` reflects DB state rather than sidecar JSON files.

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

- **Stale workers or leases** — Worker process died without cleanup. Doctor inspects worker heartbeats and expired milestone leases in the database, then clears the stale coordination state.

Run `/gsd doctor --fix` to clean up automatically.

### Stale Detection

Sessions are considered stale when:
- The worker PID is no longer running
- The last heartbeat is older than the worker TTL
- A milestone lease is released or expires without a matching active heartbeat

The coordinator runs stale detection during status refresh and either marks the worker crashed or allows the lease to be taken over on the next claim.

## Safety Model

| Safety Layer | Protection |
|-------------|------------|
| **Feature flag** | `parallel.enabled: false` by default — existing users unaffected |
| **Eligibility analysis** | Dependency and file overlap checks before starting |
| **Worker isolation** | Separate processes, worktrees, branches, context windows |
| **`GSD_MILESTONE_LOCK`** | Each worker only sees its milestone in state derivation |
| **`GSD_PARALLEL_WORKER`** | Workers cannot spawn nested parallel sessions |
| **Budget ceiling** | Aggregate cost enforcement across all workers |
| **Command queue + SIGTERM** | Graceful stop/pause/resume via DB-backed commands plus process signals |
| **Doctor integration** | Detects and cleans up orphaned sessions |
| **Conflict-aware merge** | Stops on code conflicts, auto-resolves `.gsd/` state conflicts |

## File Layout

```
.gsd/
├── gsd.db                       # Shared runtime database
├── gsd.db-wal / gsd.db-shm      # SQLite WAL sidecars while workers are active
├── parallel/                    # Per-milestone runtime lock / isolation dirs
│   ├── M002/
│   └── M003/
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

`.gsd/gsd.db*`, `.gsd/parallel/`, and `.gsd/worktrees/` are all local runtime artifacts and should remain gitignored.

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
