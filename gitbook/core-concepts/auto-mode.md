# Auto Mode

Auto mode is GSD's autonomous execution engine. Run `/gsd auto`, walk away, come back to built software with clean git history.

## Starting Auto Mode

```
/gsd auto
```

GSD derives the next unit of work from the authoritative SQLite database at the project root, creates a fresh AI session with all relevant context, and lets the AI execute. When it finishes, GSD persists the result to the database, refreshes markdown projections such as `STATE.md`, and dispatches the next unit. This continues until the milestone is complete.

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

## State Authority

The GSD database is the runtime source of truth for milestones, slices, tasks, requirements, decisions, summaries, and completion status. Markdown files in `.gsd/` are rendered projections for review, prompts, and git-friendly history; editing a projection does not override the database unless a GSD command imports or saves the change.

In worktree mode, the project-root database and project-root `.gsd/` state remain authoritative. Worktree markdown projections are diagnostics, not state to sync back. Runtime state derivation does not silently rebuild from markdown when the database is unavailable. The legacy markdown fallback is only enabled with `GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK=1` for tests and explicit recovery work.

## Deep Planning Mode

Enable project-level deep planning with `/gsd new-project --deep`, `/gsd new-milestone --deep`, or this project preference:

```yaml
planning_depth: deep
```

Deep mode runs one-time discovery gates before normal milestone planning:

```text
Workflow Preferences -> Project Context -> Requirements -> Research Decision -> Optional Project Research -> Milestone Context/Roadmap
```

| Artifact | Stage | Purpose |
|----------|-------|---------|
| `.gsd/PREFERENCES.md` | `--deep` / `workflow-preferences` | Holds `planning_depth: deep` and captured workflow settings |
| `.gsd/PROJECT.md` | `discuss-project` | Project vision, users, anti-goals, constraints, milestone sequence |
| `.gsd/REQUIREMENTS.md` | `discuss-requirements` | Capability contract with Active, Validated, Deferred, and Out of Scope requirements |
| `.gsd/runtime/research-decision.json` | `research-decision` | Records whether to run project research or skip it |
| `.gsd/research/STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, `PITFALLS.md` | `research-project` | Optional four-way project research when the decision is `research` |

The research-decision unit only records the choice. If the decision is `research`, the next gate fans out four project research passes. Those outputs inform planning and requirement review; they do not silently create binding requirements.

## Controlling Auto Mode

### Pause

Press **Escape**. The conversation is preserved. You can interact with the agent, inspect state, or resume.

### Resume

```
/gsd auto
```

Auto mode derives the latest database state and picks up where it left off.

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

## Context Mode

Context Mode is enabled by default for auto-mode runs. Each unit receives manifest-driven guidance to preserve the conversation window: use `gsd_exec` for noisy codebase scans, builds, tests, and diagnostics; use `gsd_exec_search` before repeating a prior sandboxed run; and use `gsd_resume` after compaction or session resume to read `.gsd/last-snapshot.md`.

`gsd_exec` writes full stdout/stderr and metadata under `.gsd/exec/`, then returns only a short digest to the agent. This keeps large command output out of the LLM context while preserving exact evidence on disk. Opt out with:

```yaml
context_mode:
  enabled: false
```

You can also tune sandbox behavior with `context_mode.exec_timeout_ms`, `context_mode.exec_stdout_cap_bytes`, and `context_mode.exec_digest_chars`.

## Runtime Tool Policy

Every auto-mode unit declares a `ToolsPolicy` in its `UnitContextManifest`, and GSD enforces it before tool calls run. Execution units use `all` mode and can edit project files, run shell commands, and dispatch subagents. Most planning and discussion units use `planning` mode: read tools are allowed, writes are limited to `.gsd/`, bash must be read-only, and subagent dispatch is blocked. Selected planning and closeout units use `planning-dispatch` mode, which keeps the same source-write and bash restrictions but allows `subagent` dispatch for isolated recon, planning, or review work. Documentation units use `docs` mode, which also allows writes to the manifest's documentation globs such as `docs/**`, top-level `README*.md`, `CHANGELOG.md`, and top-level `*.md`.

Policy violations return a hard block, so unsafe writes, unsafe bash, and subagent dispatch from non-dispatch planning units are stopped at runtime rather than handled as model instructions. In `planning-dispatch` units, prompts steer the parent agent toward read-only specialists such as `scout`, `planner`, `researcher`, `reviewer`, `security`, or `tester`; implementation-tier agents still belong in `execute-task`.

## Reactive Task Execution

Reactive task execution is enabled by default. During task execution, GSD derives a dependency graph from task-plan IO annotations. With default settings, it only attempts a reactive batch when at least three ready tasks are available and the graph is non-ambiguous. Non-conflicting tasks are dispatched in parallel via subagents; dependent tasks wait for their predecessors.

```yaml
reactive_execution:
  enabled: false    # opt out; omit this block to keep default-on behavior
```

Set `reactive_execution.enabled: true` explicitly to use the earlier opt-in threshold of two ready tasks. Optional tuning includes `max_parallel` (default `2`, range `1`-`8`), `isolation_mode: same-tree`, and `subagent_model`.

## Git Isolation

GSD isolates milestone work using one of three modes:

| Mode | How It Works | Best For |
|------|-------------|----------|
| `none` (default) | Work happens directly on your current branch | Most projects |
| `worktree` | Each milestone gets its own directory and branch | Projects that need file isolation |
| `branch` | Work happens in the project root on a milestone branch | Submodule-heavy repos |

In worktree mode, all commits are squash-merged to main as one clean commit when the milestone completes. Worktree mode requires at least one commit; zero-commit repos temporarily run as `none` until `HEAD` exists. See [Git & Worktrees](../configuration/git-settings.md).

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
