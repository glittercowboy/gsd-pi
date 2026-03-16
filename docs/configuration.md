# Configuration

GSD preferences live in `~/.gsd/preferences.md` (global) or `.gsd/preferences.md` (project-local). Manage interactively with `/gsd prefs`.

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

### `token_profile`

Coordinates model selection, phase skipping, and context compression. See [Token Optimization](./token-optimization.md).

Values: `budget`, `balanced` (default), `quality`

### `phases`

Fine-grained control over which phases run in auto mode:

```yaml
phases:
  skip_research: false        # skip milestone-level research
  skip_reassess: false        # skip roadmap reassessment after each slice
  skip_slice_research: true   # skip per-slice research
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
  soft_timeout_minutes: 20    # warn LLM to wrap up
  idle_timeout_minutes: 10    # detect stalls
  hard_timeout_minutes: 30    # pause auto mode
```

### `budget_ceiling`

USD ceiling. Auto mode pauses when reached.

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
  commit_docs: true           # commit .gsd/ artifacts to git (set false to keep local)
```

### `notifications`

Control what notifications GSD sends (for remote question integrations):

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

Route interactive questions to Slack or Discord for headless auto-mode:

```yaml
remote_questions:
  channel: slack              # or discord
  channel_id: "C1234567890"
  timeout_minutes: 15
  poll_interval_seconds: 10
```

### `post_unit_hooks`

Custom hooks that fire after specific unit types complete:

```yaml
post_unit_hooks:
  - name: code-review
    after: [execute-task]
    prompt: "Review the code changes for quality and security issues."
    model: claude-opus-4-6
    max_cycles: 1
```

### `pre_dispatch_hooks`

Hooks that intercept units before dispatch:

```yaml
pre_dispatch_hooks:
  - name: add-context
    before: [execute-task]
    action: modify
    prepend: "Remember to follow our coding standards document."
```

### `always_use_skills` / `prefer_skills` / `avoid_skills`

Skill routing preferences:

```yaml
always_use_skills:
  - debug-like-expert
prefer_skills:
  - frontend-design
avoid_skills: []
```

### `skill_rules`

Situational skill routing:

```yaml
skill_rules:
  - when: task involves authentication
    use: [clerk]
  - when: frontend styling work
    prefer: [frontend-design]
```

### `custom_instructions`

Durable instructions appended to every session:

```yaml
custom_instructions:
  - "Always use TypeScript strict mode"
  - "Prefer functional patterns over classes"
```
