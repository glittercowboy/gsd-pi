# GSD Preferences Reference

Full documentation for `~/.gsd/preferences.md` (global) and `.gsd/preferences.md` (project).

---

## Notes

- Keep this skill-first.
- Prefer explicit skill names or absolute paths.
- Use absolute paths for personal/local skills when you want zero ambiguity.
- These preferences guide which skills GSD should load and follow; they do not override higher-priority instructions in the current conversation.

---

## Semantics

### Empty Arrays vs Omitted Fields

**Empty arrays (`[]`) are equivalent to omitting the field entirely.** During validation, GSD deletes empty arrays from the preferences object (see `validatePreferences()` in `preferences.ts`):

```typescript
for (const key of ["always_use_skills", "prefer_skills", "avoid_skills", "custom_instructions"] as const) {
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

1. **Global:** `~/.gsd/preferences.md` — applies to all projects
2. **Project:** `.gsd/preferences.md` — applies to the current project only

**Merge behavior** (see `mergePreferences()` in `preferences.ts`):
- **Scalar fields** (`skill_discovery`, `budget_ceiling`, etc.): Project wins if defined, otherwise global. Uses nullish coalescing (`??`).
- **Array fields** (`always_use_skills`, `prefer_skills`, etc.): Concatenated via `mergeStringLists()` (global first, then project).
- **Object fields** (`models`, `git`, `auto_supervisor`): Shallow merge via spread operator `{ ...base, ...override }`.

For `models`, project settings override global at the phase level. If global has `planning: opus` and project has `planning: sonnet`, the project wins. But if project omits `research`, global's `research` setting is preserved.

### Skill Discovery vs Skill Preferences

These are **separate concerns**:

| Field | What it controls | Code reference |
|-------|-----------------|----------------|
| `skill_discovery` | **Whether** GSD looks for relevant skills during research | `resolveSkillDiscoveryMode()` in `preferences.ts` |
| `always_use_skills`, `prefer_skills`, `avoid_skills` | **Which** skills to use when they're found relevant | `renderPreferencesForSystemPrompt()` in `preferences.ts` |

Setting `prefer_skills: []` does **not** disable skill discovery — it just means you have no preference overrides. Use `skill_discovery: off` to disable discovery entirely.

---

## Field Guide

- `version`: schema version. Start at `1`.

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
  - `isolation`: `"worktree"` or `"branch"` — controls auto-mode git isolation strategy. `"worktree"` creates a milestone worktree for isolated work; `"branch"` works directly in the project root (useful for submodule-heavy repos). Default: `"worktree"`.
  - `commit_docs`: boolean — when `false`, prevents GSD from committing `.gsd/` planning artifacts to git. The `.gsd/` folder is added to `.gitignore` and kept local-only. Useful for teams where only some members use GSD, or when company policy requires a clean repository. Default: `true`.

- `unique_milestone_ids`: boolean — when `true`, generates milestone IDs in `M{seq}-{rand6}` format (e.g. `M001-eh88as`) instead of plain sequential `M001`. Prevents ID collisions in team workflows where multiple contributors create milestones concurrently. Both formats coexist — existing `M001`-style milestones remain valid. Default: `false`.

- `budget_ceiling`: number — maximum dollar amount to spend on auto-mode. When reached, behavior is controlled by `budget_enforcement`. Default: no limit.

- `budget_enforcement`: `"warn"`, `"pause"`, or `"halt"` — action taken when `budget_ceiling` is reached.
  - `warn` — log a warning but continue execution.
  - `pause` — pause auto-mode and wait for user confirmation.
  - `halt` — stop auto-mode immediately.
  - Default: `"pause"`.

- `context_pause_threshold`: number (0-100) — context window usage percentage at which auto-mode should pause to suggest checkpointing. Set to `0` to disable. Default: `0` (disabled).

- `token_profile`: `"budget"`, `"balanced"`, or `"quality"` — coordinates model selection, phase skipping, and context compression. `budget` skips research/reassessment and uses cheaper models; `balanced` (default) runs all phases; `quality` prefers higher-quality models. See token-optimization docs.

- `phases`: fine-grained control over which phases run. Usually set by `token_profile`, but can be overridden. Keys:
  - `skip_research`: boolean — skip milestone-level research. Default: `false`.
  - `skip_reassess`: boolean — skip roadmap reassessment after each slice. Default: `false`.
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

---

## Best Practices

- Keep `always_use_skills` short.
- Use `skill_rules` for situational routing, not broad personality preferences.
- Prefer skill names for stable built-in skills.
- Prefer absolute paths for local personal skills.
- **Omit fields you don't need** — empty arrays add noise with no effect.

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
  research: openrouter/deepseek/deepseek-r1  # $0.28/$0.42 per 1M tokens
  planning:
    model: claude-opus-4-6                   # $5/$25 — best for architecture
    fallbacks:
      - openrouter/z-ai/glm-5                # $1/$3.20 — strong alternative
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
