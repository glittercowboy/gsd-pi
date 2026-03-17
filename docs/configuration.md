# Configuration

GSD preferences live in `~/.gsd/preferences.md` (global) or `.gsd/preferences.md` (project-local). Manage interactively with `/gsd prefs`.

## `/gsd prefs` Commands

| Command | Description |
|---------|-------------|
| `/gsd prefs` | Open the global preferences wizard (default) |
| `/gsd prefs global` | Interactive wizard for global preferences (`~/.gsd/preferences.md`) |
| `/gsd prefs project` | Interactive wizard for project preferences (`.gsd/preferences.md`) |
| `/gsd prefs status` | Show current preference files, merged values, and skill resolution status |
| `/gsd prefs wizard` | Alias for `/gsd prefs global` |
| `/gsd prefs setup` | Alias for `/gsd prefs wizard` — creates preferences file if missing |
| `/gsd prefs import-claude` | Import Claude marketplace plugins and skills as namespaced GSD components |
| `/gsd prefs import-claude global` | Import to global scope |
| `/gsd prefs import-claude project` | Import to project scope |

## Preferences File Format

Preferences use YAML frontmatter in a markdown file:

```yaml
---
version: 1
models:
  research: claude-sonnet-4-6
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
skill_discovery: suggest
auto_supervisor:
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
budget_ceiling: 50.00
token_profile: balanced
---
```

## Global vs Project Preferences

| Scope | Path | Applies to |
|-------|------|-----------|
| Global | `~/.gsd/preferences.md` | All projects |
| Project | `.gsd/preferences.md` | Current project only |

**Merge behavior:**
- **Scalar fields** (`skill_discovery`, `budget_ceiling`): project wins if defined
- **Array fields** (`always_use_skills`, etc.): concatenated (global first, then project)
- **Object fields** (`models`, `git`, `auto_supervisor`): shallow-merged, project overrides per-key

## All Settings

### `models`

Per-phase model selection. Each key accepts a model string or an object with fallbacks.

```yaml
models:
  research: claude-sonnet-4-6
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
  execution: claude-sonnet-4-6
  execution_simple: claude-haiku-4-5-20250414
  completion: claude-sonnet-4-6
  subagent: claude-sonnet-4-6
```

**Phases:** `research`, `planning`, `execution`, `execution_simple`, `completion`, `subagent`

- `execution_simple` — used for tasks classified as "simple" by the [complexity router](./token-optimization.md#complexity-based-task-routing)
- `subagent` — model for delegated subagent tasks (scout, researcher, worker)
- Provider targeting: use `provider/model` format (e.g., `bedrock/claude-sonnet-4-6`) or the `provider` field in object format
- Omit a key to use whatever model is currently active

### Custom Model Definitions (`models.json`)

Define custom models in `~/.gsd/agent/models.json`. This lets you add models not included in the default registry — useful for self-hosted endpoints, fine-tuned models, or new releases.

GSD resolves models.json with fallback logic:
1. `~/.gsd/agent/models.json` — primary (GSD)
2. `~/.pi/agent/models.json` — fallback (Pi)
3. If neither exists, creates `~/.gsd/agent/models.json`

**With fallbacks:**

```yaml
models:
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
      - openrouter/moonshotai/kimi-k2.5
    provider: bedrock    # optional: target a specific provider
```

When a model fails to switch (provider unavailable, rate limited, credits exhausted), GSD automatically tries the next model in the `fallbacks` list.

### `token_profile`

Coordinates model selection, phase skipping, and context compression. See [Token Optimization](./token-optimization.md).

Values: `budget`, `balanced` (default), `quality`

| Profile | Behavior |
|---------|----------|
| `budget` | Skips research + reassessment phases, uses cheaper models |
| `balanced` | Default behavior — all phases run, standard model selection |
| `quality` | All phases run, prefers higher-quality models |

### `phases`

Fine-grained control over which phases run in auto mode:

```yaml
phases:
  skip_research: false        # skip milestone-level research
  skip_reassess: false        # skip roadmap reassessment after each slice
  skip_slice_research: true   # skip per-slice research
  require_slice_discussion: false  # pause auto-mode before each slice for discussion
```

These are usually set automatically by `token_profile`, but can be overridden explicitly.

### `skill_discovery`

Controls how GSD finds and applies skills during auto mode.

| Value | Behavior |
|-------|----------|
| `auto` | Skills found and applied automatically |
| `suggest` | Skills identified during research but not auto-installed (default) |
| `off` | Skill discovery disabled |

### `auto_supervisor`

Timeout thresholds for auto mode supervision:

```yaml
auto_supervisor:
  model: claude-sonnet-4-6    # optional: model for supervisor (defaults to active model)
  soft_timeout_minutes: 20    # warn LLM to wrap up
  idle_timeout_minutes: 10    # detect stalls
  hard_timeout_minutes: 30    # pause auto mode
```

### `budget_ceiling`

Maximum USD to spend during auto mode. No `$` sign — just the number.

```yaml
budget_ceiling: 50.00
```

### `budget_enforcement`

How the budget ceiling is enforced:

| Value | Behavior |
|-------|----------|
| `warn` | Log a warning but continue |
| `pause` | Pause auto mode (default when ceiling is set) |
| `halt` | Stop auto mode entirely |

### `context_pause_threshold`

Context window usage percentage (0-100) at which auto mode pauses for checkpointing. Set to `0` to disable.

```yaml
context_pause_threshold: 80   # pause at 80% context usage
```

Default: `0` (disabled)

### `uat_dispatch`

Enable automatic UAT (User Acceptance Test) runs after slice completion:

```yaml
uat_dispatch: true
```

### `unique_milestone_ids`

Generate milestone IDs with a random suffix to avoid collisions in team workflows:

```yaml
unique_milestone_ids: true
# Produces: M001-eh88as instead of M001
```

### `git`

Git behavior configuration. All fields optional:

```yaml
git:
  auto_push: false            # push commits to remote after committing
  push_branches: false        # push milestone branch to remote
  remote: origin              # git remote name
  snapshots: false            # WIP snapshot commits during long tasks
  pre_merge_check: false      # run checks before worktree merge (true/false/"auto")
  commit_type: feat           # override conventional commit prefix
  main_branch: main           # primary branch name
  merge_strategy: squash      # how worktree branches merge: "squash" or "merge"
  isolation: worktree         # git isolation: "worktree", "branch", or "none"
  commit_docs: true           # commit .gsd/ artifacts to git (set false to keep local)
  worktree_post_create: .gsd/hooks/post-worktree-create  # script to run after worktree creation
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auto_push` | boolean | `false` | Push commits to remote after committing |
| `push_branches` | boolean | `false` | Push milestone branch to remote |
| `remote` | string | `"origin"` | Git remote name |
| `snapshots` | boolean | `false` | WIP snapshot commits during long tasks |
| `pre_merge_check` | bool/string | `false` | Run checks before merge (`true`/`false`/`"auto"`) |
| `commit_type` | string | (inferred) | Override conventional commit prefix (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `build`, `style`) |
| `main_branch` | string | `"main"` | Primary branch name |
| `merge_strategy` | string | `"squash"` | How worktree branches merge: `"squash"` (combine all commits) or `"merge"` (preserve individual commits) |
| `isolation` | string | `"worktree"` | Auto-mode isolation: `"worktree"` (separate directory), `"branch"` (work in project root — useful for submodule-heavy repos), or `"none"` (no isolation — commits on current branch, no worktree or milestone branch) |
| `commit_docs` | boolean | `true` | Commit `.gsd/` planning artifacts to git. Set `false` to keep local-only |
| `worktree_post_create` | string | (none) | Script to run after worktree creation. Receives `SOURCE_DIR` and `WORKTREE_DIR` env vars |

#### `git.worktree_post_create`

Script to run after a worktree is created (both auto-mode and manual `/worktree`). Useful for copying `.env` files, symlinking asset directories, or running setup commands that worktrees don't inherit from the main tree.

```yaml
git:
  worktree_post_create: .gsd/hooks/post-worktree-create
```

The script receives two environment variables:
- `SOURCE_DIR` — the original project root
- `WORKTREE_DIR` — the newly created worktree path

Example hook script (`.gsd/hooks/post-worktree-create`):

```bash
#!/bin/bash
# Copy environment files and symlink assets into the new worktree
cp "$SOURCE_DIR/.env" "$WORKTREE_DIR/.env"
cp "$SOURCE_DIR/.env.local" "$WORKTREE_DIR/.env.local" 2>/dev/null || true
ln -sf "$SOURCE_DIR/assets" "$WORKTREE_DIR/assets"
```

The path can be absolute or relative to the project root. The script runs with a 30-second timeout. Failure is non-fatal — GSD logs a warning and continues.

### `notifications`

Control what notifications GSD sends during auto mode:

```yaml
notifications:
  enabled: true
  on_complete: true           # notify on unit completion
  on_error: true              # notify on errors
  on_budget: true             # notify on budget thresholds
  on_milestone: true          # notify when milestone finishes
  on_attention: true          # notify when manual attention needed
```

### `remote_questions`

Route interactive questions to Slack or Discord for headless auto mode:

```yaml
remote_questions:
  channel: slack              # or discord
  channel_id: "C1234567890"
  timeout_minutes: 15         # question timeout (1-30 minutes)
  poll_interval_seconds: 10   # poll interval (2-30 seconds)
```

### `post_unit_hooks`

Custom hooks that fire after specific unit types complete:

```yaml
post_unit_hooks:
  - name: code-review
    after: [execute-task]
    prompt: "Review the code changes for quality and security issues."
    model: claude-opus-4-6          # optional: model override
    max_cycles: 1                   # max fires per trigger (1-10, default: 1)
    artifact: REVIEW.md             # optional: skip if this file exists
    retry_on: NEEDS-REWORK.md       # optional: re-run trigger unit if this file appears
    agent: review-agent             # optional: agent definition to use
    enabled: true                   # optional: disable without removing
```

**Known unit types for `after`:** `research-milestone`, `plan-milestone`, `research-slice`, `plan-slice`, `execute-task`, `complete-slice`, `replan-slice`, `reassess-roadmap`, `run-uat`

**Prompt substitutions:** `{milestoneId}`, `{sliceId}`, `{taskId}` are replaced with current context values.

### `pre_dispatch_hooks`

Hooks that intercept units before dispatch. Three actions available:

**Modify** — prepend/append text to the unit prompt:

```yaml
pre_dispatch_hooks:
  - name: add-standards
    before: [execute-task]
    action: modify
    prepend: "Follow our coding standards document."
    append: "Run linting after changes."
```

**Skip** — skip the unit entirely:

```yaml
pre_dispatch_hooks:
  - name: skip-research
    before: [research-slice]
    action: skip
    skip_if: RESEARCH.md            # optional: only skip if this file exists
```

**Replace** — replace the unit prompt entirely:

```yaml
pre_dispatch_hooks:
  - name: custom-execute
    before: [execute-task]
    action: replace
    prompt: "Execute the task using TDD methodology."
    unit_type: execute-task-tdd     # optional: override unit type label
    model: claude-opus-4-6          # optional: model override
```

All pre-dispatch hooks support `enabled: true/false` to toggle without removing.

### `always_use_skills` / `prefer_skills` / `avoid_skills`

Skill routing preferences:

```yaml
always_use_skills:
  - debug-like-expert
prefer_skills:
  - frontend-design
avoid_skills: []
```

Skills can be bare names (looked up in `~/.gsd/agent/skills/`) or absolute paths.

### `skill_rules`

Situational skill routing with human-readable triggers:

```yaml
skill_rules:
  - when: task involves authentication
    use: [clerk]
  - when: frontend styling work
    prefer: [frontend-design]
  - when: working with legacy code
    avoid: [aggressive-refactor]
```

### `custom_instructions`

Durable instructions appended to every session:

```yaml
custom_instructions:
  - "Always use TypeScript strict mode"
  - "Prefer functional patterns over classes"
```

For project-specific knowledge (patterns, gotchas, lessons learned), use `.gsd/KNOWLEDGE.md` instead — it's injected into every agent prompt automatically. Add entries with `/gsd knowledge rule|pattern|lesson <description>`.

### `dynamic_routing`

Complexity-based model routing. See [Dynamic Model Routing](./dynamic-model-routing.md).

```yaml
dynamic_routing:
  enabled: true
  tier_models:
    light: claude-haiku-4-5
    standard: claude-sonnet-4-6
    heavy: claude-opus-4-6
  escalate_on_failure: true
  budget_pressure: true
  cross_provider: true
```

### `auto_visualize`

Show the workflow visualizer automatically after milestone completion:

```yaml
auto_visualize: true
```

See [Workflow Visualizer](./visualizer.md).

### `parallel`

Run multiple milestones simultaneously. Disabled by default.

```yaml
parallel:
  enabled: false            # Master toggle
  max_workers: 2            # Concurrent workers (1-4)
  budget_ceiling: 50.00     # Aggregate cost limit in USD
  merge_strategy: "per-milestone"  # "per-slice" or "per-milestone"
  auto_merge: "confirm"            # "auto", "confirm", or "manual"
```

See [Parallel Orchestration](./parallel-orchestration.md) for full documentation.

## Full Example

```yaml
---
version: 1

# Model selection
models:
  research: openrouter/deepseek/deepseek-r1
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
  execution: claude-sonnet-4-6
  execution_simple: claude-haiku-4-5-20250414
  completion: claude-sonnet-4-6

# Token optimization
token_profile: balanced

# Dynamic model routing
dynamic_routing:
  enabled: true
  escalate_on_failure: true
  budget_pressure: true

# Budget
budget_ceiling: 25.00
budget_enforcement: pause
context_pause_threshold: 80

# Supervision
auto_supervisor:
  soft_timeout_minutes: 15
  hard_timeout_minutes: 25

# Git
git:
  auto_push: true
  merge_strategy: squash
  isolation: worktree         # "worktree", "branch", or "none"
  commit_docs: true

# Skills
skill_discovery: suggest
skill_staleness_days: 60     # Skills unused for N days get deprioritized (0 = disabled)
always_use_skills:
  - debug-like-expert
skill_rules:
  - when: task involves authentication
    use: [clerk]

# Notifications
notifications:
  on_complete: false
  on_milestone: true
  on_attention: true

# Visualizer
auto_visualize: true

# Hooks
post_unit_hooks:
  - name: code-review
    after: [execute-task]
    prompt: "Review {sliceId}/{taskId} for quality and security."
    artifact: REVIEW.md
---
```
