# GSD Command Reference & How-To Guide

A complete reference for all `/gsd` subcommands available inside a GSD session.

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Workflow Execution](#workflow-execution)
3. [Workflow Templates](#workflow-templates)
4. [Visibility & Dashboards](#visibility--dashboards)
5. [Course Correction](#course-correction)
6. [Project Knowledge](#project-knowledge)
7. [Quick Tasks](#quick-tasks)
8. [Setup & Configuration](#setup--configuration)
9. [Maintenance & Diagnostics](#maintenance--diagnostics)
10. [Remote & Integration](#remote--integration)
11. [Advanced](#advanced)
12. [Parallel Orchestration](#parallel-orchestration)
13. [Help](#help)
14. [Common Workflows](#common-workflows)

---

## Core Concepts

GSD organizes work into a three-level hierarchy stored in `.gsd/`:

```
Milestone (M001, M002…)  →  a shippable version (4–10 slices, 1–4 weeks)
  Slice   (S01, S02…)    →  one demoable vertical capability (1–7 tasks, 1–3 days)
    Task  (T01, T02…)    →  one context-window-sized unit of work
```

**Unit ID format:** `M001/S01/T01`

**Key files:**

| File | Purpose |
|------|---------|
| `.gsd/STATE.md` | Quick-glance status dashboard (runtime, gitignored) |
| `.gsd/DECISIONS.md` | Append-only architectural decisions register |
| `.gsd/OVERRIDES.md` | Hard-steer overrides applied during execution |
| `.gsd/KNOWLEDGE.md` | Persistent rules, patterns, and lessons |
| `.gsd/CAPTURES.md` | Pending thought captures (awaiting triage) |
| `.gsd/milestones/M###/M###-ROADMAP.md` | Milestone plan with slices |
| `.gsd/milestones/M###/slices/S##/S##-PLAN.md` | Task list for a slice |

**Workflow phases:**
```
pre-planning → needs-discussion → discussing → researching → planning →
executing → verifying → summarizing → advancing → validating-milestone →
completing-milestone → complete
```
Special phases: `paused`, `blocked`, `replanning-slice`

---

## Workflow Execution

### `/gsd` or `/gsd next`

Step mode — execute one unit of work, then pause.

**Usage:**
```
/gsd
/gsd next
/gsd next --dry-run
/gsd next --verbose
/gsd next --debug
```

**What it does:**
- No `.gsd/` directory → starts a discussion flow to capture your project vision
- Milestone exists, no roadmap → discuss or research the milestone
- Roadmap exists, slices pending → plan the next slice or execute a task
- Mid-task → resume where you left off

**Flags:**

| Flag | Effect |
|------|--------|
| `--dry-run` | Show what would run without actually executing |
| `--verbose` | Show tool calls in progress output |
| `--debug` | Enable structured JSONL diagnostic logging |

---

### `/gsd auto`

Autonomous mode — research, plan, execute, commit, and repeat continuously until the milestone is complete.

**Usage:**
```
/gsd auto
/gsd auto --verbose
/gsd auto --debug
```

Walk away and let GSD handle everything. Pauses only when it needs a decision from you (blockers, ambiguous choices).

**Flags:**

| Flag | Effect |
|------|--------|
| `--verbose` | Show tool calls in progress output |
| `--debug` | Enable structured JSONL diagnostic logging |

> **Two-terminal workflow:** Run `/gsd auto` in terminal 1, then open terminal 2 to run `/gsd steer`, `/gsd status`, or `/gsd capture` while auto-mode builds.

---

### `/gsd stop`

Stop auto-mode gracefully.

**Usage:**
```
/gsd stop
```

Finishes the current unit then exits. Works on both local sessions and remote auto-mode sessions.

---

### `/gsd pause`

Pause auto-mode, preserving state for resumption.

**Usage:**
```
/gsd pause
```

You can also press `Escape` to pause from the keyboard. Resume by running `/gsd auto` again.

---

## Workflow Templates

### `/gsd start`

Start a workflow template for common task types.

**Usage:**
```
/gsd start bugfix
/gsd start small-feature
/gsd start spike
/gsd start hotfix
/gsd start refactor
/gsd start security-audit
/gsd start dep-upgrade
/gsd start full-project
/gsd start resume
/gsd start --list
/gsd start --dry-run bugfix
```

**Available templates:**

| Template | Use for |
|----------|---------|
| `bugfix` | Investigate → fix → verify a specific bug |
| `small-feature` | Plan and implement a focused feature |
| `spike` | Time-boxed research or proof-of-concept |
| `hotfix` | Emergency fix with minimal process overhead |
| `refactor` | Planned refactoring with safety gates |
| `security-audit` | Audit codebase for vulnerabilities |
| `dep-upgrade` | Upgrade dependencies with compatibility checks |
| `full-project` | Full new project from scratch |
| `resume` | Resume interrupted work from context |

**Flags:**

| Flag | Effect |
|------|--------|
| `--list` | Show all available templates |
| `--dry-run` | Preview the template steps without starting |

---

### `/gsd templates`

List and inspect available workflow templates.

**Usage:**
```
/gsd templates
/gsd templates info bugfix
/gsd templates info hotfix
```

- No args → lists all templates with brief descriptions
- `info <name>` → shows full detail for that template (phases, steps, decision points)

---

## Visibility & Dashboards

### `/gsd status`

Show the progress dashboard.

**Usage:**
```
/gsd status
```

**Keyboard shortcut:** `Ctrl+Alt+G` toggles the dashboard overlay without leaving the prompt.

Displays: active milestone, current slice/task, phase, progress counters, cost so far, and blockers.

---

### `/gsd widget`

Control the dashboard widget visibility mode.

**Usage:**
```
/gsd widget           # cycle through modes
/gsd widget full
/gsd widget small
/gsd widget min
/gsd widget off
```

| Mode | Display |
|------|---------|
| `full` | Full dashboard with all metrics |
| `small` | Compact one-line status bar |
| `min` | Minimal indicator only |
| `off` | Hidden |

---

### `/gsd visualize`

Open the interactive 10-tab TUI visualizer.

**Usage:**
```
/gsd visualize
```

**Tabs:**

| Tab | Content |
|-----|---------|
| Progress | Phase/slice/task completion rates |
| Timeline | Estimated vs actual schedule |
| Dependencies | Cross-slice dependency graph |
| Metrics | Token usage, cost, model distribution |
| Health | `.gsd/` state health checks |
| Agent | Active agent statuses |
| Changes | Git diff summary by phase |
| Knowledge | KNOWLEDGE.md entries |
| Captures | Pending CAPTURES.md items |
| Export | Generate HTML report |

---

### `/gsd queue`

Show queued/dispatched units and their execution order.

**Usage:**
```
/gsd queue
```

Displays upcoming slices and tasks. Safe to run during auto-mode — shows what's coming without interrupting.

---

### `/gsd history`

View execution history.

**Usage:**
```
/gsd history
/gsd history 20
/gsd history --cost
/gsd history --phase
/gsd history --model
```

**Arguments:**

| Arg | Effect |
|-----|--------|
| `N` | Show last N entries (default: 10) |
| `--cost` | Include per-unit token cost breakdown |
| `--phase` | Group by workflow phase |
| `--model` | Show which model was used per unit |

---

### `/gsd changelog`

Show categorized release notes for GSD itself.

**Usage:**
```
/gsd changelog
/gsd changelog v2.36.0
```

No arg → latest release notes. With version → notes for that specific release.

---

### `/gsd discuss`

Start a guided milestone discussion (architecture decisions, scope, etc.).

**Usage:**
```
/gsd discuss
```

Opens the guided flow for discussing the active milestone — goals, scope, tech decisions. Safe to run from a second terminal while auto-mode runs in the first.

---

## Course Correction

### `/gsd steer`

Apply a hard override to active planning or execution documents.

**Usage:**
```
/gsd steer Use Postgres instead of SQLite
/gsd steer Remove the caching layer — not needed for MVP
/gsd steer Auth should use JWT, not sessions
```

Writes the override to `.gsd/OVERRIDES.md`. GSD picks it up at the next phase boundary and adjusts plan documents accordingly.

---

### `/gsd capture`

Fire-and-forget thought capture. Works during auto-mode without interrupting it.

**Usage:**
```
/gsd capture "Fix the loading spinner on mobile"
/gsd capture "Consider Redis for session storage"
/gsd capture "The auth token is being dropped after logout"
```

Appends to `.gsd/CAPTURES.md`. Use `/gsd triage` to classify and route pending captures.

---

### `/gsd triage`

Classify and route pending captures from CAPTURES.md.

**Usage:**
```
/gsd triage
```

Presents each pending capture and lets you: promote to a task, add to KNOWLEDGE.md, convert to a steer, or dismiss.

---

### `/gsd skip`

Prevent a specific unit from being dispatched in auto-mode.

**Usage:**
```
/gsd skip M001/S01/T03
/gsd skip S01/T03
/gsd skip T03
```

Marks the unit as skipped — auto-mode will advance past it without executing.

---

### `/gsd undo`

Revert the last completed unit.

**Usage:**
```
/gsd undo
/gsd undo --force
```

Reverts the git commits from the unit, removes its summary artifact, and unchecks the task in the PLAN. `--force` skips the confirmation prompt.

---

### `/gsd park`

Park a milestone — skip it without deleting it.

**Usage:**
```
/gsd park
/gsd park M002
/gsd park M002 "waiting for design review"
```

Parked milestones are excluded from auto-mode dispatch. Reactivate with `/gsd unpark`.

---

### `/gsd unpark`

Reactivate a parked milestone.

**Usage:**
```
/gsd unpark
/gsd unpark M002
```

No arg → lists all parked milestones to choose from.

---

## Project Knowledge

### `/gsd knowledge`

Add a persistent rule, pattern, or lesson to `.gsd/KNOWLEDGE.md`.

**Usage:**
```
/gsd knowledge rule Use real DB for integration tests — no mocks
/gsd knowledge pattern All API errors return {error, code, message}
/gsd knowledge lesson Caching broke prod deploy in v1.2 — test it separately
```

**Types:**

| Type | Use for |
|------|---------|
| `rule` | Hard constraints that must always be followed |
| `pattern` | Recurring solutions or conventions in this codebase |
| `lesson` | Post-incident or post-UAT learnings |

Knowledge entries are injected into agent prompts for all future work on this project.

---

## Quick Tasks

### `/gsd quick`

Execute a lightweight task without full milestone ceremony.

**Usage:**
```
/gsd quick Fix the broken redirect after login
```

Creates a `.gsd/quick/N-slug/` directory and a dedicated git branch (`gsd/quick/N-slug`). Updates STATE.md on completion. Lighter-weight than a full milestone slice but still tracked.

---

## Setup & Configuration

### `/gsd init`

Project initialization wizard — detect stack, configure preferences, bootstrap `.gsd/`.

**Usage:**
```
/gsd init
```

Run once in a new project directory. Detects your tech stack, asks about workflow preferences, and creates the `.gsd/` directory structure.

---

### `/gsd setup`

Show global setup status and configure integrations.

**Usage:**
```
/gsd setup
/gsd setup llm
/gsd setup search
/gsd setup remote
/gsd setup keys
/gsd setup prefs
```

| Subcommand | Configures |
|-----------|-----------|
| `llm` | LLM provider and API key |
| `search` | Web search API key (Brave, Jina) |
| `remote` | Remote auto-mode (Slack/Discord) |
| `keys` | All API keys overview |
| `prefs` | Workflow preferences |

---

### `/gsd mode`

Switch workflow mode between solo and team.

**Usage:**
```
/gsd mode
/gsd mode global
/gsd mode project
```

- `global` — sets mode in `~/.gsd/preferences.json` (applies to all projects)
- `project` — sets mode in `.gsd/preferences.json` (this project only)

**Modes:**

| Mode | Behavior |
|------|----------|
| `solo` | Single committer, direct-to-main style |
| `team` | Branch-per-milestone, PR workflow, coordinated IDs |

---

### `/gsd prefs`

Manage workflow preferences — model selection, timeouts, budget ceiling.

**Usage:**
```
/gsd prefs
/gsd prefs global
/gsd prefs project
/gsd prefs status
/gsd prefs wizard
/gsd prefs setup
/gsd prefs import-claude
```

| Subcommand | Effect |
|-----------|--------|
| `global` | Edit `~/.gsd/preferences.json` directly |
| `project` | Edit `.gsd/preferences.json` directly |
| `status` | Show effective preferences (merged global + project) |
| `wizard` | Interactive guided preferences setup |
| `setup` | Alias for wizard |
| `import-claude` | Import settings from an existing Claude Code config |

---

### `/gsd cmux`

Manage the cmux terminal multiplexer integration.

**Usage:**
```
/gsd cmux status
/gsd cmux on
/gsd cmux off
/gsd cmux notifications on
/gsd cmux notifications off
/gsd cmux sidebar on
/gsd cmux sidebar off
/gsd cmux splits on
/gsd cmux splits off
/gsd cmux browser on
/gsd cmux browser off
```

| Subcommand | Effect |
|-----------|--------|
| `status` | Show current cmux integration state |
| `on` / `off` | Enable or disable cmux integration globally |
| `notifications on\|off` | Toggle desktop notifications for unit completion |
| `sidebar on\|off` | Toggle sidebar status panel |
| `splits on\|off` | Toggle auto terminal splitting |
| `browser on\|off` | Toggle browser preview pane |

---

### `/gsd config`

Re-run the provider setup wizard — set or update API keys for LLM providers and tools.

**Usage:**
```
/gsd config
```

Keys are saved to `~/.gsd/agent/auth.json` and apply to all projects.

---

### `/gsd keys`

API key manager.

**Usage:**
```
/gsd keys list
/gsd keys add GITHUB_TOKEN
/gsd keys remove GITHUB_TOKEN
/gsd keys test GITHUB_TOKEN
/gsd keys rotate GITHUB_TOKEN
/gsd keys doctor
```

| Subcommand | Effect |
|-----------|--------|
| `list` | Show all configured API keys (masked) |
| `add <key>` | Add or update a key interactively |
| `remove <key>` | Delete a key |
| `test <key>` | Verify a key is valid by making a test call |
| `rotate <key>` | Replace a key with a new value |
| `doctor` | Check all keys for validity and expiration |

---

### `/gsd hooks`

Show configured post-unit and pre-dispatch hooks.

**Usage:**
```
/gsd hooks
```

Displays all hooks registered in `.gsd/hooks.json` with their trigger conditions and scripts.

---

### `/gsd run-hook`

Manually trigger a specific post-unit hook.

**Usage:**
```
/gsd run-hook code-review execute-task M001/S01/T01
/gsd run-hook notify complete-slice M001/S01
/gsd run-hook deploy complete-milestone M001
```

**Arguments:** `<hook-name> <unit-type> <unit-id>`

**Unit types:** `execute-task`, `plan-slice`, `research-milestone`, `complete-slice`, `complete-milestone`

---

### `/gsd extensions`

Manage GSD extensions.

**Usage:**
```
/gsd extensions list
/gsd extensions enable my-extension
/gsd extensions disable my-extension
/gsd extensions info my-extension
```

| Subcommand | Effect |
|-----------|--------|
| `list` | Show all installed extensions with enabled/disabled status |
| `enable <name>` | Activate an extension |
| `disable <name>` | Deactivate an extension (without uninstalling) |
| `info <name>` | Show extension metadata, version, and capabilities |

---

## Maintenance & Diagnostics

### `/gsd doctor`

Diagnose and repair `.gsd/` state. Runs 7 health checks and offers fixes.

**Usage:**
```
/gsd doctor
/gsd doctor audit
/gsd doctor fix
/gsd doctor fix M001
/gsd doctor heal
/gsd doctor heal M001/S01
```

**Modes:**

| Mode | Effect |
|------|--------|
| *(none)* | Interactive: run checks, show issues, prompt for action |
| `audit` | Read-only report — no changes made |
| `fix [scope]` | Auto-fix common issues (git refs, state files, registry) |
| `heal [scope]` | AI-driven repair — spawns an agent to diagnose and fix complex issues |

**Scope:** Omit for active milestone (blocking issues first). Pass `M001`, `M001/S01`, or `global` to target specifically.

---

### `/gsd skill-health`

Skill lifecycle dashboard — usage stats, success rates, token trends, staleness warnings.

**Usage:**
```
/gsd skill-health
/gsd skill-health my-skill-name
/gsd skill-health --stale 7
/gsd skill-health --declining
```

| Arg/Flag | Effect |
|---------|--------|
| `<name>` | Detailed view for a specific skill |
| `--stale N` | Show only skills unused for N+ days |
| `--declining` | Show only skills with declining performance metrics |

---

### `/gsd logs`

Browse activity and debug logs.

**Usage:**
```
/gsd logs
/gsd logs debug
/gsd logs debug 5
/gsd logs tail
/gsd logs tail 20
/gsd logs clear
/gsd logs 3
```

| Subcommand | Effect |
|-----------|--------|
| *(none)* | Show recent activity log |
| `debug [N]` | Show debug log (last N entries) |
| `tail [N]` | Show last N lines of live log |
| `clear` | Clear all logs |
| `<N>` | Show activity log entry number N |

---

### `/gsd forensics`

Post-mortem investigation of auto-mode failures — structured root-cause analysis with log inspection.

**Usage:**
```
/gsd forensics
```

Examines execution logs, crash records, and state snapshots to produce a structured failure report. Use when auto-mode crashed unexpectedly or produced bad output.

---

### `/gsd export`

Generate reports of milestone work.

**Usage:**
```
/gsd export --html
/gsd export --html --all
/gsd export --json
/gsd export --markdown
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--html` | Self-contained HTML report for the active milestone |
| `--html --all` | Retrospective HTML reports for every milestone |
| `--json` | Machine-readable JSON export |
| `--markdown` | Markdown summary |

Reports are saved to `.gsd/reports/` with a browseable `index.html`.

---

### `/gsd cleanup`

Remove merged branches or stale snapshots.

**Usage:**
```
/gsd cleanup
/gsd cleanup branches
/gsd cleanup snapshots
```

| Subcommand | Effect |
|-----------|--------|
| *(none)* | Interactive: choose what to clean up |
| `branches` | Delete local branches that have been merged to main |
| `snapshots` | Remove old state snapshots from `.gsd/snapshots/` |

---

### `/gsd migrate`

Migrate a v1 `.planning/` directory to the v2 `.gsd/` format.

**Usage:**
```
/gsd migrate
```

Run once in a project that was using GSD v1. Converts the directory structure and state files to the v2 schema. Non-destructive — backs up `.planning/` before migrating.

---

### `/gsd inspect`

Show SQLite database diagnostics — schema, row counts, and recent entries.

**Usage:**
```
/gsd inspect
```

Useful for debugging state corruption issues. Shows the raw DB state including task records, event log, and registry entries.

---

### `/gsd update`

Update GSD to the latest version without leaving the session.

**Usage:**
```
/gsd update
```

Checks npm for a newer version of `gsd-pi` and installs it in-session. Reports the version change. Restart GSD after updating to load the new version.

---

## Remote & Integration

### `/gsd remote`

Control remote auto-mode — run GSD as a background worker triggered by Slack or Discord.

**Usage:**
```
/gsd remote status
/gsd remote slack
/gsd remote discord
/gsd remote disconnect
```

| Subcommand | Effect |
|-----------|--------|
| `status` | Show active remote session (if any) |
| `slack` | Configure Slack as the remote control channel |
| `discord` | Configure Discord as the remote control channel |
| `disconnect` | Stop the remote session |

Once configured, send `/gsd auto` or `/gsd stop` from Slack/Discord to control the agent remotely.

---

## Advanced

### `/gsd dispatch`

Force-dispatch to a specific workflow phase, bypassing the normal state machine.

**Usage:**
```
/gsd dispatch research
/gsd dispatch plan
/gsd dispatch execute
/gsd dispatch uat
/gsd dispatch complete
/gsd dispatch reassess
/gsd dispatch replan
```

**Phases:**

| Phase | Jumps to |
|-------|---------|
| `research` | Domain/tech research for active milestone |
| `plan` | Slice planning |
| `execute` | Task execution |
| `uat` | User acceptance testing |
| `complete` | Milestone completion flow |
| `reassess` | Re-examine scope and slice plan |
| `replan` | Replan a specific slice |

> Use this when the state machine is stuck or you want to re-run a phase manually.

---

### `/gsd rate`

Rate the last unit's model tier to improve adaptive model routing.

**Usage:**
```
/gsd rate over
/gsd rate ok
/gsd rate under
```

| Value | Meaning |
|-------|---------|
| `over` | Model was more powerful than needed — could use a cheaper one |
| `ok` | Model choice was appropriate |
| `under` | Model struggled — this task needs a more capable model |

GSD uses these ratings to refine automatic model selection for similar tasks.

---

## Parallel Orchestration

### `/gsd parallel`

Orchestrate multiple milestones running simultaneously in isolated worktrees.

**Usage:**
```
/gsd parallel start
/gsd parallel status
/gsd parallel stop
/gsd parallel stop M002
/gsd parallel pause
/gsd parallel pause M002
/gsd parallel resume
/gsd parallel resume M002
/gsd parallel merge
/gsd parallel merge M002
```

| Subcommand | Effect |
|-----------|--------|
| `start` | Analyze milestone eligibility, confirm, and start workers |
| `status` | Show all workers with state, progress, and cost |
| `stop [MID]` | Stop all workers, or a specific milestone's worker |
| `pause [MID]` | Pause all workers, or a specific one |
| `resume [MID]` | Resume paused workers |
| `merge [MID]` | Merge completed milestone back to main |

Each worker gets its own isolated git worktree. Workers that share code dependencies are sequenced; independent milestones run truly in parallel.

---

## Help

### `/gsd help`

Show categorized command reference.

**Usage:**
```
/gsd help
/gsd h
/gsd ?
```

---

## Common Workflows

### Start a new project from scratch

```
gsd                    # launch GSD in project directory
/gsd init              # set up .gsd/ structure
/gsd                   # step through discussion → research → plan → execute
```

### Auto-pilot a milestone

```
/gsd auto              # hands-off from current state through completion
```

### Two-terminal steering

```
# Terminal 1 — let it build
/gsd auto

# Terminal 2 — steer while it works
/gsd status            # check progress
/gsd steer "Use Redis instead of in-memory cache"
/gsd capture "Found a bug in the session handler"
/gsd discuss           # talk through architecture
```

### Fix a bug fast

```
/gsd start bugfix
# or
/gsd quick Fix the broken pagination on the users list
```

### Recover from a bad state

```
/gsd doctor            # diagnose issues
/gsd doctor fix        # auto-fix common problems
/gsd doctor heal       # AI-driven fix for complex issues
/gsd undo              # revert last unit if needed
```

### Queue the next milestone while current one runs

```
/gsd queue             # inspect the queue
/gsd discuss           # queue up next milestone from a second terminal
```

### Review execution after completion

```
/gsd history --cost    # see what ran and what it cost
/gsd export --html     # generate shareable HTML report
```

### Parallel development across milestones

```
/gsd parallel start    # start eligible milestones in parallel worktrees
/gsd parallel status   # monitor all workers
/gsd parallel merge M001   # merge completed work back to main
```

### Run GSD headlessly (CI/scripts)

```bash
# Run one unit and exit
gsd headless next

# Run fully autonomous (default)
gsd headless

# With timeout for CI
gsd headless --timeout 600000 auto

# Instant JSON snapshot — no LLM
gsd headless query

# Force a specific phase
gsd headless dispatch plan

# Create milestone from file and run
gsd headless new-milestone --context brief.md --auto
```
