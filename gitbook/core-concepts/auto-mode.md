# Auto Mode

Auto mode is GSD's autonomous execution engine. Run `/gsd auto`, walk away, come back to built software with clean git history.

## Starting Auto Mode

```
/gsd auto
```

GSD reads `.gsd/STATE.md`, determines the next unit of work, creates a fresh AI session with all relevant context, and lets the AI execute. When it finishes, GSD reads disk state again and dispatches the next unit. This continues until the milestone is complete.

## The Execution Loop

Each slice flows through phases automatically:

```
Plan → Execute (per task) → Complete → Reassess Roadmap → Next Slice
                                                           ↓ (all done)
                                                   Validate Milestone
```

- **Plan** — scouts the codebase, researches docs, decomposes the slice into tasks
- **Execute** — runs each task in a fresh context window
- **Complete** — writes summary, UAT script, marks roadmap, commits
- **Reassess** — checks if the roadmap still makes sense after what was learned
- **Validate** — after all slices, verifies success criteria were actually met

## Controlling Auto Mode

### Pause

Press **Escape**. The conversation is preserved. You can interact with the agent, inspect state, or resume.

### Resume

```
/gsd auto
```

Auto mode reads disk state and picks up where it left off.

### Stop

```
/gsd stop
```

Stops auto mode gracefully. Can be run from a different terminal.

### Steer

```
/gsd steer
```

Modify plan documents during execution without stopping. Changes are picked up at the next phase boundary.

### Capture Thoughts

```
/gsd capture "add rate limiting to API endpoints"
```

Fire-and-forget thought capture. Captures are triaged automatically between tasks without pausing execution. See [Captures & Triage](../features/captures.md).

## Fresh Session Per Unit

Every task gets a clean AI context window. No accumulated garbage, no quality degradation from context bloat. The dispatch prompt includes everything needed — task plans, prior summaries, decisions, dependency context — so the AI starts oriented.

## Git Isolation

GSD isolates milestone work using one of three modes:

| Mode | How It Works | Best For |
|------|-------------|----------|
| `worktree` (default) | Each milestone gets its own directory and branch | Most projects |
| `branch` | Work happens in the project root on a milestone branch | Submodule-heavy repos |
| `none` | Work happens directly on your current branch | Hot-reload workflows |

In worktree mode, all commits are squash-merged to main as one clean commit when the milestone completes. See [Git & Worktrees](../configuration/git-settings.md).

## Crash Recovery

If a session dies, the next `/gsd auto` reads the surviving session file, synthesizes a recovery briefing from every tool call that made it to disk, and resumes with full context.

In headless mode (`gsd headless auto`), crashes trigger automatic restart with exponential backoff (5s → 10s → 30s, up to 3 attempts). Combined with crash recovery, this enables true overnight "fire and forget" execution.

## Provider Error Recovery

GSD handles provider errors automatically:

| Error Type | Examples | What Happens |
|-----------|----------|-------------|
| Rate limit | 429, "too many requests" | Auto-resumes after cooldown (60s or retry-after header) |
| Server error | 500, 502, 503, "overloaded" | Auto-resumes after 30s |
| Permanent | "unauthorized", "invalid key" | Pauses — requires manual resume |

No manual intervention needed for transient errors.

## Timeout Supervision

Three timeout tiers prevent runaway sessions:

| Timeout | Default | What Happens |
|---------|---------|-------------|
| Soft | 20 min | Warns the AI to wrap up |
| Idle | 10 min | Detects stalls, intervenes |
| Hard | 30 min | Pauses auto mode |

Configure in preferences:

```yaml
auto_supervisor:
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
```

## Verification Gates

Configure shell commands that run automatically after every task:

```yaml
verification_commands:
  - npm run lint
  - npm run test
verification_auto_fix: true    # auto-retry on failure
verification_max_retries: 2    # max retry attempts
```

If verification fails, the AI sees the output and attempts to fix the issues before advancing. This ensures quality gates are enforced mechanically.

## Slice Discussion Gate

For projects requiring human review before each slice:

```yaml
require_slice_discussion: true
```

Auto mode pauses before each slice, showing the plan for your approval before building.

## Stuck Detection

GSD uses sliding-window analysis to detect stuck loops — not just "same unit dispatched twice" but also cycles like A→B→A→B. On detection, GSD retries once with a diagnostic prompt. If it fails again, auto mode stops with details so you can intervene.

## Cost Tracking

Every unit's token usage and cost is captured, broken down by phase, slice, and model. The dashboard shows running totals and projections. Budget ceilings can pause auto mode before overspending. See [Cost Management](../features/cost-management.md).

## Dashboard

`Ctrl+Alt+G` or `/gsd status` shows real-time progress:

- Current milestone, slice, and task
- Auto mode elapsed time and phase
- Per-unit cost and token breakdown
- Cost projections
- Completed and in-progress units
- Pending capture count
- Parallel worker status (when running parallel milestones)

## HTML Reports

After a milestone completes, GSD generates a self-contained HTML report in `.gsd/reports/` with project summary, progress tree, dependency graph, cost metrics, timeline, and changelog. Generate manually with:

```
/gsd export --html
/gsd export --html --all    # all milestones
```

## Diagnostic Tools

If auto mode has issues, GSD provides two diagnostic tools:

- **`/gsd doctor`** — validates `.gsd/` integrity, checks referential consistency, fixes structural issues
- **`/gsd forensics`** — full post-mortem debugger with anomaly detection, unit traces, metrics analysis, worktree lifecycle telemetry, and AI-guided investigation

```
/gsd doctor
/gsd forensics [optional problem description]
```

### Worktree Telemetry in Forensics Reports

`/gsd forensics` includes a **Worktree Telemetry** section that summarizes the auto-mode worktree lifecycle across recorded sessions:

- **Created / Merged / Conflicts** — counts of worktree creation and merge-back events, plus merge-conflict occurrences.
- **Orphans detected** — milestones whose branch or worktree directory was stranded (e.g. after an interrupted session). Broken out by reason (in-progress-unmerged, complete-unmerged).
- **Unmerged exits** — auto-mode sessions that exited (pause, stop, blocked, crash) without merging the active milestone. This is the producer-side signal for orphaned work; a non-zero count here points at sessions that should have merged but didn't.
- **Merge duration p50 / p95** — how long `mergeMilestoneToMain` takes in practice. Useful when evaluating whether `collapse_cadence: "slice"` would help (long milestone merges often indicate large divergence that slice cadence would amortize).
- **Canonical-root redirects** — how often validation correctly routed to a worktree instead of stale project-root state.

Two anomaly types surface from telemetry:
- `worktree-orphan` — one per orphan reason-bucket
- `worktree-unmerged-exit` — aggregate signal across the window

For per-event detail (specific milestone IDs, timestamps, exit reasons) inspect `.gsd/journal/*.jsonl` directly.
