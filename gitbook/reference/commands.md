# Commands

## Session Commands

| Command | Description |
|---------|-------------|
| `/gsd` | Step mode — execute one unit at a time |
| `/gsd auto` | Autonomous mode — research, plan, execute, commit, repeat |
| `/gsd quick` | Quick task with GSD guarantees but no full planning |
| `/gsd stop` | Stop auto mode gracefully |
| `/gsd pause` | Pause auto mode (preserves state) |
| `/gsd steer` | Modify plan documents during execution |
| `/gsd discuss` | Discuss architecture and decisions |
| `/gsd status` | Progress dashboard |
| `/gsd widget` | Cycle dashboard widget: full / small / min / off |
| `/gsd queue` | Queue and reorder future milestones |
| `/gsd capture` | Fire-and-forget thought capture |
| `/gsd triage` | Manually trigger capture triage |
| `/gsd debug` | Create and inspect persistent /gsd debug sessions |
| `/gsd debug list` | List persisted debug sessions |
| `/gsd debug status <slug>` | Show status for one debug session slug |
| `/gsd debug continue <slug>` | Resume an existing debug session slug |
| `/gsd debug --diagnose` | Inspect malformed artifacts and session health (`--diagnose [<slug> | <issue text>]`) |
| `/gsd dispatch` | Dispatch a specific phase directly |
| `/gsd history` | View execution history (supports `--cost`, `--phase`, `--model` filters) |
| `/gsd forensics` | Full debugger for auto-mode failures |
| `/gsd cleanup` | Clean up state files and stale worktrees |
| `/gsd visualize` | Open workflow visualizer |
| `/gsd export --html` | Generate HTML report for current milestone |
| `/gsd export --html --all` | Generate reports for all milestones |
| `/gsd update` | Update GSD to the latest version |
| `/gsd knowledge` | Add persistent project knowledge |
| `/gsd fast` | Toggle service tier for supported models |
| `/gsd rate` | Rate last unit's model tier (over/ok/under) |
| `/gsd changelog` | Show release notes |
| `/gsd logs` | Browse activity and debug logs |
| `/gsd remote` | Control remote auto-mode |
| `/gsd help` | Show all available commands |

## Configuration & Diagnostics

| Command | Description |
|---------|-------------|
| `/gsd prefs` | Preferences wizard |
| `/gsd mode` | Switch workflow mode (solo/team) |
| `/gsd config` | Re-run provider setup wizard |
| `/gsd keys` | API key manager |
| `/gsd doctor` | Runtime health checks with auto-fix |
| `/gsd inspect` | Show database diagnostics |
| `/gsd init` | Project init wizard |
| `/gsd setup` | Global setup status |
| `/gsd skill-health` | Skill lifecycle dashboard |
| `/gsd hooks` | Show configured hooks |
| `/gsd migrate` | Migrate v1 `.planning` to `.gsd` format |

## Milestone Management

| Command | Description |
|---------|-------------|
| `/gsd new-milestone` | Create a new milestone |
| `/gsd skip` | Prevent a unit from auto-mode dispatch |
| `/gsd undo` | Revert last completed unit |
| `/gsd undo-task` | Reset a specific task's completion state |
| `/gsd reset-slice` | Reset a slice and all its tasks |
| `/gsd park` | Park a milestone (skip without deleting) |
| `/gsd unpark` | Reactivate a parked milestone |

## Parallel Orchestration

| Command | Description |
|---------|-------------|
| `/gsd parallel start` | Analyze and start parallel workers |
| `/gsd parallel status` | Show worker state and progress |
| `/gsd parallel stop [MID]` | Stop workers |
| `/gsd parallel pause [MID]` | Pause workers |
| `/gsd parallel resume [MID]` | Resume workers |
| `/gsd parallel merge [MID]` | Merge completed milestones |

## Workflow Templates

| Command | Description |
|---------|-------------|
| `/gsd start` | Start a workflow template |
| `/gsd start resume` | Resume an in-progress workflow |
| `/gsd templates` | List available templates |
| `/gsd templates info <name>` | Show template details |

## Custom Workflows

| Command | Description |
|---------|-------------|
| `/gsd workflow new` | Create a workflow definition |
| `/gsd workflow run <name>` | Start a workflow run |
| `/gsd workflow list` | List workflow runs |
| `/gsd workflow validate <name>` | Validate a workflow YAML |
| `/gsd workflow pause` | Pause workflow auto-mode |
| `/gsd workflow resume` | Resume paused workflow |

## Extensions

| Command | Description |
|---------|-------------|
| `/gsd extensions list` | List all extensions |
| `/gsd extensions enable <id>` | Enable an extension |
| `/gsd extensions disable <id>` | Disable an extension |
| `/gsd extensions info <id>` | Show extension details |

## GitHub Sync

| Command | Description |
|---------|-------------|
| `/github-sync bootstrap` | Initial GitHub sync setup |
| `/github-sync status` | Show sync mapping counts |

## Session Management

| Command | Description |
|---------|-------------|
| `/clear` | Start a new session |
| `/exit` | Graceful shutdown |
| `/model` | Switch the active model |
| `/login` | Log in to an LLM provider |
| `/thinking` | Toggle thinking level |
| `/voice` | Toggle speech-to-text |
| `/worktree` (`/wt`) | Git worktree management |

## In-Session Update

```
/gsd update
```

Checks npm for a newer version and installs it without leaving the session.
