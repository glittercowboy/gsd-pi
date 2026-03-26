# GSD Preferences Reference

Full documentation for `~/.gsd/PREFERENCES.md` (global) and `.gsd/PREFERENCES.md` (project).

---

## Notes

- Keep this skill-first.
- Prefer explicit skill names or absolute paths.
- Use absolute paths for personal/local skills when you want zero ambiguity.
- These preferences guide which skills GSD should load and follow; they do not override higher-priority instructions in the current conversation.
- For Claude marketplace/plugin import behavior, see `~/.gsd/agent/extensions/gsd/docs/claude-marketplace-import.md`.

---

## Semantics

### Empty Arrays vs Omitted Fields

**Empty arrays (`[]`) are equivalent to omitting the field entirely.** During validation, GSD deletes empty arrays from the preferences object (see `validatePreferences()` in `preferences.ts`):

```typescript
for (const key of [
  "always_use_skills",
  "prefer_skills",
  "avoid_skills",
  "custom_instructions",
] as const) {
  if (validated[key] && validated[key]!.length === 0) {
    delete validated[key];
  }
}
```

These are functionally identical:

```yaml
# Explicit empty arrays — will be normalized away
prefer_skills: []
avoid_skills: []
skill_rules: []

# Omitted entirely — same result
# (just don't write these fields)
```

**Recommendation:** Omit fields you don't need. Empty arrays add noise with no effect.

### Global vs Project Preferences

Preferences are loaded from two locations and merged:

1. **Global:** `~/.gsd/PREFERENCES.md` — applies to all projects
2. **Project:** `.gsd/PREFERENCES.md` — applies to the current project only

**Merge behavior** (see `mergePreferences()` in `preferences.ts`):

- **Scalar fields** (`skill_discovery`, `budget_ceiling`, etc.): Project wins if defined, otherwise global. Uses nullish coalescing (`??`).
- **Array fields** (`always_use_skills`, `prefer_skills`, etc.): Concatenated via `mergeStringLists()` (global first, then project).
- **Object fields** (`models`, `git`, `auto_supervisor`): Shallow merge via spread operator `{ ...base, ...override }`.

For `models`, project settings override global at the phase level. If global has `planning: opus` and project has `planning: sonnet`, the project wins. But if project omits `research`, global's `research` setting is preserved.

### Skill Discovery vs Skill Preferences

These are **separate concerns**:

| Field                                                | What it controls                                          | Code reference                                           |
| ---------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| `skill_discovery`                                    | **Whether** GSD looks for relevant skills during research | `resolveSkillDiscoveryMode()` in `preferences.ts`        |
| `always_use_skills`, `prefer_skills`, `avoid_skills` | **Which** skills to use when they're found relevant       | `renderPreferencesForSystemPrompt()` in `preferences.ts` |

Setting `prefer_skills: []` does **not** disable skill discovery — it just means you have no preference overrides. Use `skill_discovery: off` to disable discovery entirely.

---

## Field Guide

- `version`: schema version. Start at `1`.

- `mode`: workflow mode — `"solo"` or `"team"`. Sets sensible defaults for git and project settings based on your workflow. Mode defaults are the lowest priority layer — any explicit preference overrides them. Omit to configure everything manually.

  | Setting                | `solo`       | `team`       |
  | ---------------------- | ------------ | ------------ |
  | `git.auto_push`        | `true`       | `false`      |
  | `git.push_branches`    | `false`      | `true`       |
  | `git.pre_merge_check`  | `false`      | `true`       |
  | `git.merge_strategy`   | `"squash"`   | `"squash"`   |
  | `git.isolation`        | `"worktree"` | `"worktree"` |
  | `unique_milestone_ids` | `false`      | `true`       |

  Quick setup: `/gsd mode` (global) or `/gsd mode project` (project-level).

- `always_use_skills`: skills GSD should use whenever they are relevant.

- `prefer_skills`: soft defaults GSD should prefer when relevant.

- `avoid_skills`: skills GSD should avoid unless clearly needed.

- `skill_rules`: situational rules with a human-readable `when` trigger and one or more of `use`, `prefer`, or `avoid`.

- `custom_instructions`: extra durable instructions related to skill use. For operational project knowledge (recurring rules, gotchas, patterns), use `.gsd/KNOWLEDGE.md` instead — it's injected into every agent prompt automatically and agents can append to it during execution.

- `models`: per-stage model selection for auto-mode. Keys: `research`, `planning`, `execution`, `execution_simple`, `completion`, `subagent`. Values can be:
  - Simple string: `"claude-sonnet-4-6"` — single model, no fallbacks
  - Provider-qualified string: `"bedrock/claude-sonnet-4-6"` — targets a specific provider when the same model ID exists across multiple providers
  - Object with fallbacks: `{ model: "claude-opus-4-6", fallbacks: ["glm-5", "minimax-m2.5"] }` — tries fallbacks in order if primary fails
  - Object with provider: `{ model: "claude-opus-4-6", provider: "bedrock" }` — explicit provider targeting in object format
  - Omit a key to use whatever model is currently active. Fallbacks are tried when model switching fails (provider unavailable, rate limited, etc.).

- `skill_staleness_days`: number — skills unused for this many days get deprioritized during discovery. Set to `0` to disable staleness tracking. Default: `60`.

- `skill_discovery`: controls how GSD discovers and applies skills during auto-mode. Valid values:
  - `auto` — skills are found and applied automatically without prompting.
  - `suggest` — (default) skills are identified during research but not installed automatically.
  - `off` — skill discovery is disabled entirely.

- `auto_supervisor`: configures the auto-mode supervisor that monitors agent progress and enforces timeouts. Keys:
  - `model`: model ID to use for the supervisor process (defaults to the currently active model).
  - `soft_timeout_minutes`: minutes before the supervisor issues a soft warning (default: 20).
  - `idle_timeout_minutes`: minutes of inactivity before the supervisor intervenes (default: 10).
  - `hard_timeout_minutes`: minutes before the supervisor forces termination (default: 30).

- `git`: configures GSD's git behavior. All fields are optional — omit any to use defaults. Keys:
  - `auto_push`: boolean — automatically push commits to the remote after committing. Default: `false`.
  - `push_branches`: boolean — push the milestone branch to the remote after commits. Default: `false`.
  - `remote`: string — git remote name to push to. Default: `"origin"`.
  - `snapshots`: boolean — create snapshot commits (WIP saves) during long-running tasks. Default: `false`.
  - `pre_merge_check`: boolean or `"auto"` — run pre-merge checks before merging a worktree back to the integration branch. `true` always runs, `false` never runs, `"auto"` runs when CI is detected. Default: `false`.
  - `commit_type`: string — override the conventional commit type prefix. Must be one of: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `build`, `style`. Default: inferred from diff content.
  - `main_branch`: string — the primary branch name for new git repos (e.g., `"main"`, `"master"`, `"trunk"`). Also used by `getMainBranch()` as the preferred branch when auto-detection is ambiguous. Default: `"main"`.
  - `merge_strategy`: `"squash"` or `"merge"` — controls how worktree branches are merged back. `"squash"` combines all commits into one; `"merge"` preserves individual commits. Default: `"squash"`.
  - `isolation`: `"worktree"`, `"branch"`, or `"none"` — controls auto-mode git isolation strategy. `"worktree"` creates a milestone worktree for isolated work; `"branch"` works directly in the project root but creates a milestone branch (useful for submodule-heavy repos); `"none"` works directly on the current branch with no worktree or milestone branch (ideal for step-mode with hot reloads). Default: `"worktree"`.
  - `manage_gitignore`: boolean — when `false`, GSD will not touch `.gitignore` at all. Useful when your project has a strictly managed `.gitignore` and you don't want GSD adding entries. Default: `true`.
  - `worktree_post_create`: string — script to run after a worktree is created (both auto-mode and manual `/worktree`). Receives `SOURCE_DIR` and `WORKTREE_DIR` as environment variables. Can be absolute or relative to project root. Runs with 30-second timeout. Failure is non-fatal (logged as warning). Default: none.
  - `auto_pr`: boolean — automatically create a GitHub pull request after a milestone branch is merged. Requires `gh` CLI to be installed. Default: `false`.
  - `pr_target_branch`: string — branch to target when `auto_pr` is enabled. Defaults to `main_branch` when omitted.
  - **Deprecated:** `commit_docs` — no longer valid; `.gsd/` is always gitignored. Remove this setting.
  - **Deprecated:** `merge_to_main` — no longer valid; milestone-level merge is always used. Remove this setting.

- `unique_milestone_ids`: boolean — when `true`, generates milestone IDs in `M{seq}-{rand6}` format (e.g. `M001-eh88as`) instead of plain sequential `M001`. Prevents ID collisions in team workflows where multiple contributors create milestones concurrently. Both formats coexist — existing `M001`-style milestones remain valid. Default: `false`.

- `budget_ceiling`: number — maximum dollar amount to spend on auto-mode. When reached, behavior is controlled by `budget_enforcement`. Default: no limit.

- `budget_enforcement`: `"warn"`, `"pause"`, or `"halt"` — action taken when `budget_ceiling` is reached.
  - `warn` — log a warning but continue execution.
  - `pause` — pause auto-mode and wait for user confirmation.
  - `halt` — stop auto-mode immediately.
  - Default: `"pause"`.

- `context_pause_threshold`: number (0-100) — context window usage percentage at which auto-mode should pause to suggest checkpointing. Set to `0` to disable. Default: `0` (disabled).

- `token_profile`: `"budget"`, `"balanced"`, or `"quality"` — coordinates model selection, phase skipping, and context compression. `budget` skips research/reassessment and uses cheaper models; `balanced` (default) skips research/reassessment to reduce token burn; `quality` prefers higher-quality models. See token-optimization docs.

- `phases`: fine-grained control over which phases run. Usually set by `token_profile`, but can be overridden. Keys:
  - `skip_research`: boolean — skip milestone-level research. Default: `false`.
  - `reassess_after_slice`: boolean — run roadmap reassessment after each completed slice. Default: `false`.
  - `skip_reassess`: boolean — force-disable roadmap reassessment even if `reassess_after_slice` is enabled. Default: `false`.
  - `skip_slice_research`: boolean — skip per-slice research. Default: `false`.

- `remote_questions`: route interactive questions to Slack/Discord for headless auto-mode. Keys:
  - `channel`: `"slack"` or `"discord"` — channel type.
  - `channel_id`: string or number — channel ID.
  - `timeout_minutes`: number — question timeout in minutes (clamped 1-30).
  - `poll_interval_seconds`: number — poll interval in seconds (clamped 2-30).

- `notifications`: configures desktop notification behavior during auto-mode. Keys:
  - `enabled`: boolean — master toggle for all notifications. Default: `true`.
  - `on_complete`: boolean — notify when a unit completes. Default: `true`.
  - `on_error`: boolean — notify on errors. Default: `true`.
  - `on_budget`: boolean — notify when budget thresholds are reached. Default: `true`.
  - `on_milestone`: boolean — notify when a milestone finishes. Default: `true`.
  - `on_attention`: boolean — notify when manual attention is needed. Default: `true`.

- `cmux`: configures cmux terminal integration when GSD is running inside a cmux workspace. Keys:
  - `enabled`: boolean — master toggle for cmux integration. Default: `false`.
  - `notifications`: boolean — route desktop notifications through cmux. Default: `true` when enabled.
  - `sidebar`: boolean — publish status, progress, and log metadata to the cmux sidebar. Default: `true` when enabled.
  - `splits`: boolean — run supported subagent work in visible cmux splits. Default: `false`.
  - `browser`: boolean — reserve the future browser integration flag. Default: `false`.

- `dynamic_routing`: configures the dynamic model router that adjusts model selection based on task complexity. Keys:
  - `enabled`: boolean — enable dynamic routing. Default: `false`.
  - `tier_models`: object — model overrides per complexity tier. Keys: `light`, `standard`, `heavy`. Values are model ID strings.
  - `escalate_on_failure`: boolean — escalate to a higher-tier model when the current one fails. Default: `true`.
  - `budget_pressure`: boolean — downgrade model tier when budget is under pressure. Default: `true`.
  - `cross_provider`: boolean — allow routing across different providers. Default: `true`.
  - `hooks`: boolean — enable routing hooks. Default: `true`.

- `auto_visualize`: boolean — show a visualizer hint after each milestone completion in auto-mode. Default: `false`.

- `auto_report`: boolean — generate an HTML report snapshot after each milestone completion. Default: `true`.

- `search_provider`: `"brave"`, `"tavily"`, `"ollama"`, `"native"`, or `"auto"` — selects the search backend for research phases. `"native"` forces Anthropic's built-in web search only; provider values force that backend and disable native search; `"auto"` uses the default heuristic. Default: `"auto"`.

- `context_selection`: `"full"` or `"smart"` — controls how files are inlined into context. `"full"` inlines entire files; `"smart"` uses semantic chunking to include only the most relevant sections. Default is derived from `token_profile`.

- `parallel`: configures parallel orchestration for running multiple slices concurrently. Keys:
  - `enabled`: boolean — enable parallel execution. Default: `false`.
  - `max_workers`: number — maximum concurrent workers (1-4). Default: `2`.
  - `budget_ceiling`: number — optional per-parallel-run budget ceiling.
  - `merge_strategy`: `"per-slice"` or `"per-milestone"` — when to merge worktree results back. Default: `"per-milestone"`.
  - `auto_merge`: `"auto"`, `"confirm"`, or `"manual"` — merge behavior after completion. `"auto"` merges immediately; `"confirm"` asks first; `"manual"` leaves branches for you. Default: `"confirm"`.

- `verification_commands`: string[] — shell commands to run as verification after task execution (e.g., `["npm test", "npm run lint"]`). Commands run in order; if any fails, the task is marked as needing fixes.

- `verification_auto_fix`: boolean — when `true`, automatically attempt to fix verification failures instead of just reporting them. Default: `false`.

- `verification_max_retries`: number — maximum number of fix-and-retry cycles for verification failures. Default: `0` (no retries).

- `uat_dispatch`: boolean — when `true`, enables UAT (User Acceptance Testing) dispatch mode. Default: `false`.

- `post_unit_hooks`: array — hooks that fire after a unit completes. Each entry has:
  - `name`: string — unique hook identifier.
  - `after`: string[] — unit types that trigger this hook (e.g., `["execute-task"]`).
  - `prompt`: string — prompt sent to the LLM. Supports `{milestoneId}`, `{sliceId}`, `{taskId}` substitutions.
  - `max_cycles`: number — max times this hook fires per trigger (default: 1, max: 10).
  - `model`: string — optional model override.
  - `artifact`: string — expected output file name (relative to task/slice dir). Hook is skipped if file already exists (idempotent).
  - `retry_on`: string — if this file is produced instead of the artifact, re-run the trigger unit then re-run hooks.
  - `agent`: string — agent definition file to use for hook execution.
  - `enabled`: boolean — toggle without removing (default: `true`).

- `pre_dispatch_hooks`: array — hooks that fire before a unit is dispatched. Each entry has:
  - `name`: string — unique hook identifier.
  - `before`: string[] — unit types to intercept.
  - `action`: `"modify"`, `"skip"`, or `"replace"` — what to do with the unit.
  - `prepend`: string — text prepended to unit prompt (for `"modify"` action).
  - `append`: string — text appended to unit prompt (for `"modify"` action).
  - `prompt`: string — replacement prompt (for `"replace"` action; required when action is `"replace"`).
  - `unit_type`: string — override unit type label (for `"replace"` action).
  - `skip_if`: string — for `"skip"` action: only skip if this file exists (relative to unit dir).
  - `model`: string — optional model override when this hook fires.
  - `enabled`: boolean — toggle without removing (default: `true`).

  **Action validation:**
  - `"modify"` requires at least one of `prepend` or `append`.
  - `"replace"` requires `prompt`.
  - `"skip"` is valid with no additional fields.

  **Known unit types for `before`/`after`:** `research-milestone`, `plan-milestone`, `research-slice`, `plan-slice`, `execute-task`, `complete-slice`, `replan-slice`, `reassess-roadmap`, `run-uat`.

- `experimental`: opt-in experimental features. All features here are **off by default** — you must explicitly set each one to `true` to enable it. Features in this block may change or be removed without a deprecation cycle while in experimental status. Keys:
  - `rtk`: boolean — enable RTK (Real-Time Kompression) shell-command compression. When enabled, GSD wraps shell commands through the RTK binary to reduce token usage during command execution. RTK is downloaded automatically on first use if not already installed. **Default: `false`** (opt-in required). Set `GSD_RTK_DISABLED=1` in the environment to force-disable regardless of this preference.

---

## Best Practices

- Keep `always_use_skills` short.
- Use `skill_rules` for situational routing, not broad personality preferences.
- Prefer skill names for stable built-in skills.
- Prefer absolute paths for local personal skills.
- **Omit fields you don't need** — empty arrays add noise with no effect.

---

## Workflow Mode Examples

**Solo developer — auto-push, simple IDs:**

```yaml
---
version: 1
mode: solo
---
```

Equivalent to setting `git.auto_push: true`, `git.push_branches: false`, `git.pre_merge_check: false`, `git.merge_strategy: squash`, `git.isolation: worktree`, `unique_milestone_ids: false`.

**Team — unique IDs, push branches, pre-merge checks:**

```yaml
---
version: 1
mode: team
---
```

Equivalent to setting `git.auto_push: false`, `git.push_branches: true`, `git.pre_merge_check: true`, `git.merge_strategy: squash`, `git.isolation: worktree`, `unique_milestone_ids: true`.

**Mode with overrides — team mode but with auto-push:**

```yaml
---
version: 1
mode: team
git:
  auto_push: true
---
```

Gets all team defaults except `auto_push`, which is explicitly overridden to `true`. Any explicit setting always wins over the mode default.

---

## Minimal Example

The cleanest preferences file only specifies what you actually want:

```yaml
---
version: 1
always_use_skills:
  - debug-like-expert
skill_discovery: suggest
models:
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
---
```

Everything else uses defaults. No `prefer_skills: []`, no `avoid_skills: []`, no `auto_supervisor: {}` — those are just noise.

---

## Models Example

```yaml
---
version: 1
models:
  research: claude-sonnet-4-6
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
---
```

Opus for planning (where architectural decisions matter most), Sonnet for everything else (faster, cheaper). Omit any key to use the currently selected model.

## Models with Fallbacks Example

```yaml
---
version: 1
models:
  research:
    model: openrouter/deepseek/deepseek-r1
    fallbacks:
      - openrouter/minimax/minimax-m2.5
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
      - openrouter/moonshotai/kimi-k2.5
  execution:
    model: openrouter/z-ai/glm-5
    fallbacks:
      - openrouter/minimax/minimax-m2.5
  completion: openrouter/minimax/minimax-m2.5
---
```

When a model fails to switch (provider unavailable, rate limited, credits exhausted), GSD automatically tries the next model in the `fallbacks` list. This ensures auto-mode continues even when your preferred provider hits limits.

## Provider Targeting

When the same model ID exists across multiple providers (e.g., `claude-sonnet-4-6` on both Anthropic and Bedrock), use the `provider/model` format or the `provider` field to target a specific one:

```yaml
---
version: 1
models:
  # String format: provider/model
  research: bedrock/claude-sonnet-4-6
  planning: anthropic/claude-opus-4-6

  # Object format: explicit provider field
  execution:
    model: claude-sonnet-4-6
    provider: bedrock
    fallbacks:
      - anthropic/claude-sonnet-4-6
---
```

If you use a bare model ID (no provider prefix) and it exists in multiple providers, GSD will warn you and resolve to the first available match. Use `provider/model` format to avoid ambiguity.

**Cost-optimized example** — use cheap models with expensive ones as fallback for critical phases:

```yaml
---
version: 1
models:
  research: openrouter/deepseek/deepseek-r1 # $0.28/$0.42 per 1M tokens
  planning:
    model: claude-opus-4-6 # $5/$25 — best for architecture
    fallbacks:
      - openrouter/z-ai/glm-5 # $1/$3.20 — strong alternative
  execution: openrouter/minimax/minimax-m2.5 # $0.30/$1.20 — cheapest quality
  completion: openrouter/minimax/minimax-m2.5
---
```

---

## Example Variations

**Minimal — always load a UAT skill and route Clerk tasks:**

```yaml
---
version: 1
always_use_skills:
  - /Users/you/.claude/skills/verify-uat
skill_rules:
  - when: finishing implementation and human judgment matters
    use:
      - /Users/you/.claude/skills/verify-uat
---
```

**Richer routing — prefer cleanup and authentication skills:**

```yaml
---
version: 1
prefer_skills:
  - commit-ignore
skill_rules:
  - when: task involves Clerk authentication
    use:
      - clerk
      - clerk-setup
  - when: the user is looking for installable capability rather than implementation
    prefer:
      - find-skills
---
```

---

## Git Preferences Example

```yaml
---
version: 1
git:
  auto_push: true
  push_branches: true
  remote: origin
  snapshots: true
  pre_merge_check: auto
  commit_type: feat
---
```

All git fields are optional. Omit any field to use the default behavior. Project-level preferences override global preferences on a per-field basis.

---

## Budget & Cost Control Example

```yaml
---
version: 1
budget_ceiling: 10.00
budget_enforcement: pause
context_pause_threshold: 80
---
```

Sets a $10 budget ceiling. Auto-mode pauses when the ceiling is reached. Context window pauses at 80% usage for checkpointing.

---

## Notifications Example

```yaml
---
version: 1
notifications:
  enabled: true
  on_complete: false
  on_error: true
  on_budget: true
  on_milestone: true
  on_attention: true
---
```

Disables per-unit completion notifications (noisy in long runs) while keeping error, budget, milestone, and attention notifications enabled.

---

## cmux Example

```yaml
---
version: 1
cmux:
  enabled: true
  notifications: true
  sidebar: true
  splits: true
  browser: false
---
```

Enables cmux-aware notifications, sidebar metadata, and visible subagent splits when GSD is running inside a cmux terminal.

---

## Post-Unit Hooks Example

```yaml
---
version: 1
post_unit_hooks:
  - name: code-review
    after:
      - execute-task
    prompt: "Review the code changes in {sliceId}/{taskId} for quality, security, and test coverage."
    max_cycles: 1
    artifact: REVIEW.md
---
```

Runs an automated code review after each task execution. Skips if `REVIEW.md` already exists (idempotent).

---

## Pre-Dispatch Hooks Examples

**Modify — inject instructions before every task:**

```yaml
---
version: 1
pre_dispatch_hooks:
  - name: enforce-standards
    before:
      - execute-task
    action: modify
    prepend: "Follow our TypeScript coding standards and always run linting."
---
```

**Skip — skip per-slice research when a research file already exists:**

```yaml
---
version: 1
pre_dispatch_hooks:
  - name: skip-existing-research
    before:
      - research-slice
    action: skip
    skip_if: RESEARCH.md
---
```

**Replace — substitute a custom prompt for task execution:**

```yaml
---
version: 1
pre_dispatch_hooks:
  - name: tdd-execute
    before:
      - execute-task
    action: replace
    prompt: "Implement the task using strict TDD. Write failing tests first, then implement, then refactor."
    model: claude-opus-4-6
---
```

---

## Token Profile & Phases Example

```yaml
---
version: 1
token_profile: budget
phases:
  skip_research: true
  skip_reassess: true
  skip_slice_research: false
---
```

Uses the `budget` profile to minimize token usage, with explicit override to keep slice-level research enabled.

---

## Remote Questions Example

```yaml
---
version: 1
remote_questions:
  channel: slack
  channel_id: "C0123456789"
  timeout_minutes: 15
  poll_interval_seconds: 10
---
```

Routes interactive questions to a Slack channel for headless auto-mode sessions. Questions time out after 15 minutes if unanswered.

---

## Dynamic Routing Example

```yaml
---
version: 1
dynamic_routing:
  enabled: true
  tier_models:
    light: openrouter/minimax/minimax-m2.5
    standard: claude-sonnet-4-6
    heavy: claude-opus-4-6
  escalate_on_failure: true
  budget_pressure: true
---
```

Automatically selects model tier based on task complexity. Simple tasks use the `light` model, complex tasks escalate to `heavy`. Under budget pressure, tasks are routed to cheaper tiers.

---

## Parallel Execution Example

```yaml
---
version: 1
parallel:
  enabled: true
  max_workers: 3
  merge_strategy: per-milestone
  auto_merge: confirm
---
```

Runs up to 3 slices concurrently in separate worktrees. Results are merged per-milestone with user confirmation.

---

## Verification Example

```yaml
---
version: 1
verification_commands:
  - npm test
  - npm run lint
  - npm run typecheck
verification_auto_fix: true
verification_max_retries: 2
---
```

Runs test, lint, and typecheck after each task. On failure, auto-fix is attempted up to 2 times before reporting the issue.

## Experimental Features Example

```yaml
---
version: 1
experimental:
  rtk: true
---
```

Opts in to RTK shell-command compression. RTK is downloaded automatically on first use. Set `GSD_RTK_DISABLED=1` to force-disable at the environment level regardless of this setting.
