# GSD2 Preferences Guide

GSD2 preferences control how the agent behaves — which models it uses, how aggressively it runs, git behavior, budget limits, and more. Settings can be global (all projects) or per-project.

---

## Quick Start

```
/gsd prefs          # open the interactive wizard (global)
/gsd prefs project  # open the wizard for this project only
/gsd prefs status   # see your current settings at a glance
```

---

## Where Settings Are Stored

| Scope | File | Use for |
|-------|------|---------|
| **Global** | `~/.gsd/preferences.md` | Your personal defaults across all projects |
| **Project** | `.gsd/preferences.md` | Overrides for this specific project |

Project settings win over global settings when both exist. Most people set global defaults once and only override at the project level when needed.

---

## The `/gsd prefs` Command

```
/gsd prefs                    # wizard (global)
/gsd prefs project            # wizard (project)
/gsd prefs global             # wizard (global, explicit)
/gsd prefs status             # show effective settings summary
/gsd prefs wizard             # same as /gsd prefs
/gsd prefs import-claude      # import from Claude Code config (global)
/gsd prefs import-claude project  # import from Claude Code config (project)
```

The wizard is a menu-driven TUI. Pick a category, adjust settings, then choose **Save & Exit**. Changes take effect immediately.

---

## Wizard Categories

### Workflow Mode

The fastest way to configure GSD2 for your situation. Choosing a mode sets sensible defaults for git behavior, commit style, and milestone IDs.

```
/gsd mode          # set mode interactively
/gsd mode global   # set for all projects
/gsd mode project  # set for this project
```

| Mode | Best for | What it sets |
|------|---------|-------------|
| `solo` | Personal projects, solo dev | auto-push on, branch pushing off, simple milestone IDs |
| `team` | Shared repos, multiple devs | auto-push off, branch pushing on, pre-merge checks on, unique milestone IDs |

You can always override individual settings after setting a mode.

---

### Models

Set which AI model GSD2 uses for each phase of work. Each phase can have a different model — use a powerful model for planning and a faster one for execution.

**Phases:**

| Phase | What happens here |
|-------|------------------|
| `research` | Domain research, library investigation |
| `planning` | Slice and task decomposition |
| `execution` | Writing code and running tasks |
| `completion` | Summaries, verification, milestone wrap-up |

**In the wizard:** Pick provider → pick model, or type a model ID manually. You can also set fallback models per phase (in the preferences file directly) for resilience against rate limits.

**Example preferences file:**
```yaml
models:
  research: claude-opus-4-6
  planning: claude-sonnet-4-6
  execution: claude-sonnet-4-6
  completion: claude-haiku-4-5
```

**With fallbacks:**
```yaml
models:
  execution:
    model: claude-opus-4-6
    fallbacks:
      - claude-sonnet-4-6
      - claude-haiku-4-5
```

---

### Timeouts

Controls how long GSD2 waits before taking action on a stalled session.

| Setting | Default | What it does |
|---------|---------|-------------|
| `soft_timeout_minutes` | 20 | Warn and checkpoint if a unit takes this long |
| `idle_timeout_minutes` | 10 | Pause if no progress for this long |
| `hard_timeout_minutes` | 30 | Force-stop if a unit exceeds this |

```yaml
auto_supervisor:
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
```

Set higher values for complex tasks that legitimately take a long time.

---

### Git

Controls how GSD2 interacts with git.

| Setting | Default | Options | What it does |
|---------|---------|---------|-------------|
| `main_branch` | `main` | any branch name | Your primary branch |
| `auto_push` | `false` | `true` / `false` | Push commits automatically after each task |
| `push_branches` | `false` | `true` / `false` | Push milestone branches to remote |
| `snapshots` | `false` | `true` / `false` | Create WIP snapshot commits during long tasks |
| `remote` | `origin` | any remote name | Which remote to push to |
| `pre_merge_check` | `false` | `true` / `false` / `auto` | Run checks before merging slices |
| `commit_type` | inferred | `feat`, `fix`, `refactor`, etc. | Default conventional commit type |
| `merge_strategy` | `squash` | `squash` / `merge` | How slice branches merge back to main |
| `isolation` | `worktree` | `worktree` / `branch` / `none` | How milestones are isolated |

```yaml
git:
  main_branch: main
  auto_push: true
  merge_strategy: squash
  isolation: worktree
```

---

### Skills

Controls how GSD2 discovers and uses skills (specialized agent behaviors).

| Setting | Default | Options | What it does |
|---------|---------|---------|-------------|
| `skill_discovery` | `auto` | `auto` / `suggest` / `off` | How aggressively GSD2 looks for skills to use |
| `uat_dispatch` | `false` | `true` / `false` | Automatically dispatch UAT after slice completion |
| `skill_staleness_days` | `60` | any number, `0` = disabled | Deprioritize skills unused for N days |

You can also control skills directly:

```yaml
always_use_skills:
  - my-custom-skill       # always inject this skill

prefer_skills:
  - code-review           # use when relevant

avoid_skills:
  - legacy-skill          # never use this

skill_rules:
  - when: "executing a database migration"
    use:
      - migration-safety-checklist
```

---

### Budget

Set a spending ceiling and decide what happens when GSD2 approaches or hits it.

| Setting | Default | What it does |
|---------|---------|-------------|
| `budget_ceiling` | none | Maximum USD spend per session |
| `budget_enforcement` | `pause` | What to do when ceiling is hit |
| `context_pause_threshold` | `0` (disabled) | Pause when context window reaches this % full |

**Enforcement modes:**

| Mode | Behavior |
|------|---------|
| `warn` | Notify but keep going |
| `pause` | Stop and wait for you to decide |
| `halt` | Stop immediately, no prompt |

```yaml
budget_ceiling: 5.00
budget_enforcement: pause
context_pause_threshold: 80
```

---

### Notifications

Controls desktop notifications during auto-mode.

| Setting | Default | What triggers it |
|---------|---------|-----------------|
| `enabled` | `true` | Master toggle — turns all notifications on/off |
| `on_complete` | `true` | A task or slice finishes |
| `on_error` | `true` | An error occurs |
| `on_budget` | `true` | Budget threshold hit |
| `on_milestone` | `true` | A milestone completes |
| `on_attention` | `true` | GSD2 needs you to make a decision |

```yaml
notifications:
  enabled: true
  on_complete: false   # too noisy for individual tasks
  on_milestone: true
  on_attention: true
  on_error: true
```

---

### Advanced

| Setting | Default | Options | What it does |
|---------|---------|---------|-------------|
| `unique_milestone_ids` | `false` (solo) / `true` (team) | `true` / `false` | Use globally unique IDs (e.g. M007) vs sequential per-project (M001) |
| `auto_visualize` | `false` | `true` / `false` | Open visualizer automatically when auto-mode starts |
| `auto_report` | `true` | `true` / `false` | Generate HTML report after each milestone completes |
| `widget_mode` | `full` | `full` / `small` / `min` / `off` | Default dashboard widget size |
| `token_profile` | `balanced` | `budget` / `balanced` / `quality` | Overall token usage strategy |
| `search_provider` | `auto` | `auto` / `native` / `brave` / `tavily` / `ollama` | Which search backend to use |
| `context_selection` | derived | `full` / `smart` | How GSD2 inlines file content into prompts |
| `service_tier` | — | `priority` / `flex` | OpenAI service tier (gpt-5.4 only) |
| `custom_instructions` | — | list of strings | Extra instructions injected into every agent prompt |

```yaml
unique_milestone_ids: true
widget_mode: small
token_profile: balanced
custom_instructions:
  - Always add JSDoc comments to public functions
  - Prefer functional style over class-based
```

---

## Verification Settings

Control how GSD2 verifies work after execution.

```yaml
verification_commands:
  - npm test
  - npm run lint

verification_auto_fix: true      # auto-fix failures and retry
verification_max_retries: 2      # max fix attempts before surfacing to you
```

---

## Parallel Execution Settings

Configure behavior when running multiple milestones in parallel.

```yaml
parallel:
  max_workers: 3          # max simultaneous milestone workers
  auto_merge: false       # merge completed milestones automatically
```

---

## Full Example Preferences File

A complete `~/.gsd/preferences.md` or `.gsd/preferences.md`:

```yaml
---
version: 1
mode: solo

models:
  research: claude-opus-4-6
  planning: claude-sonnet-4-6
  execution: claude-sonnet-4-6
  completion: claude-haiku-4-5

auto_supervisor:
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 45

git:
  main_branch: main
  auto_push: true
  merge_strategy: squash
  isolation: worktree

budget_ceiling: 10.00
budget_enforcement: pause
context_pause_threshold: 85

notifications:
  enabled: true
  on_complete: false
  on_milestone: true
  on_attention: true
  on_error: true

widget_mode: small
token_profile: balanced

custom_instructions:
  - Always write tests alongside implementation
  - Use TypeScript strict mode

verification_commands:
  - npm run build
  - npm test
verification_auto_fix: true
verification_max_retries: 2
---
# GSD2 Skill Preferences
```

---

## Common Scenarios

### First-time setup
```
/gsd config        # set your API keys
/gsd prefs         # configure defaults
```

### Switch to team mode for a shared repo
```
/gsd mode project
# choose "team"
```

### Set a budget limit before a long auto-mode run
```
/gsd prefs project
# → Budget → set ceiling to $5.00, enforcement: pause
```

### Use a cheaper model for execution to save cost
```
/gsd prefs
# → Models → execution → pick a faster/cheaper model
```

### Make GSD2 always follow a coding standard
```
/gsd prefs project
# → Advanced → custom_instructions → add your rule
```

### Check what settings are active right now
```
/gsd prefs status
```
