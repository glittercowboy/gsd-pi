# Parallel Orchestration

Run multiple milestones simultaneously in isolated git worktrees. Each milestone gets its own worker process, branch, and context window.

{% hint style="info" %}
Parallel mode is off by default. Enable it in preferences to use `/gsd parallel` commands.
{% endhint %}

## Quick Start

1. Enable parallel mode:
   ```yaml
   parallel:
     enabled: true
     max_workers: 2
   ```

2. Start parallel execution:
   ```
   /gsd parallel start
   ```
   GSD scans milestones, checks dependencies and file overlap, shows an eligibility report, and spawns workers.

3. Monitor:
   ```
   /gsd parallel status
   ```

4. Stop:
   ```
   /gsd parallel stop
   ```

## How It Works

Each worker is a separate GSD process with complete isolation:

| Resource | Isolation |
|----------|----------|
| Filesystem | Own git worktree |
| Git branch | `milestone/<MID>` |
| Context window | Separate process |
| Metrics | Own `metrics.json` |
| Crash recovery | Own `auto.lock` |

Workers communicate with the coordinator through file-based IPC — heartbeat files and signal files in `.gsd/parallel/`.

## Eligibility

Before starting, GSD checks which milestones can run concurrently:

1. **Not complete** — finished milestones are skipped
2. **Dependencies satisfied** — all `dependsOn` entries must be complete
3. **File overlap** — milestones touching the same files get a warning (but are still eligible since they run in separate worktrees)

## Configuration

```yaml
parallel:
  enabled: false            # master toggle (default: false)
  max_workers: 2            # concurrent workers (1-4)
  budget_ceiling: 50.00     # aggregate cost limit
  merge_strategy: "per-milestone"  # when to merge back
  auto_merge: "confirm"     # "auto", "confirm", or "manual"
```

## Commands

| Command | Description |
|---------|-------------|
| `/gsd parallel start` | Analyze and start workers |
| `/gsd parallel status` | Show all workers with progress and cost |
| `/gsd parallel stop [MID]` | Stop all or a specific worker |
| `/gsd parallel pause [MID]` | Pause all or a specific worker |
| `/gsd parallel resume [MID]` | Resume paused workers |
| `/gsd parallel merge [MID]` | Merge completed milestones to main |

## Merge Reconciliation

When milestones complete, their changes merge back to main:

- `.gsd/` state files are auto-resolved
- Code conflicts halt the merge — resolve manually and retry with `/gsd parallel merge <MID>`

## Budget Management

When `budget_ceiling` is set, aggregate cost across all workers is tracked. When the ceiling is reached, workers are signaled to stop.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Parallel mode is not enabled" | Set `parallel.enabled: true` |
| "No eligible milestones" | All milestones are complete or blocked; check `/gsd queue` |
| Worker crashed | Run `/gsd doctor --fix`, then `/gsd parallel start` |
| Merge conflicts | Resolve in `.gsd/worktrees/<MID>/`, then `/gsd parallel merge <MID>` |
| Workers seem stuck | Check if budget ceiling was reached via `/gsd parallel status` |
