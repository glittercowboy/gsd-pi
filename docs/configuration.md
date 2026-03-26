# Configuration

GSD preferences live in `~/.gsd/PREFERENCES.md` (global) or `.gsd/PREFERENCES.md` (project-local). Manage interactively with `/gsd prefs`.

## `/gsd prefs` Commands

| Command | Description |
|---------|-------------|
| `/gsd prefs` | Open the global preferences wizard (default) |
| `/gsd prefs global` | Interactive wizard for global preferences (`~/.gsd/PREFERENCES.md`) |
| `/gsd prefs project` | Interactive wizard for project preferences (`.gsd/PREFERENCES.md`) |
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
| Global | `~/.gsd/PREFERENCES.md` | All projects |
| Project | `.gsd/PREFERENCES.md` | Current project only |

**Merge behavior:**
- **Scalar fields** (`skill_discovery`, `budget_ceiling`): project wins if defined
- **Array fields** (`always_use_skills`, etc.): concatenated (global first, then project)
- **Object fields** (`models`, `git`, `auto_supervisor`): shallow-merged, project overrides per-key

## Global API Keys (`/gsd config`)

Tool API keys are stored globally in `~/.gsd/agent/auth.json` and apply to all projects automatically. Set them once with `/gsd config` — no need to configure per-project `.env` files.

```bash
/gsd config
```

This opens an interactive wizard showing which keys are configured and which are missing. Select a tool to enter its key.

### Supported keys

| Tool | Environment Variable | Purpose | Get a key |
|------|---------------------|---------|-----------|
| Tavily Search | `TAVILY_API_KEY` | Web search for non-Anthropic models | [tavily.com/app/api-keys](https://tavily.com/app/api-keys) |
| Brave Search | `BRAVE_API_KEY` | Web search for non-Anthropic models | [brave.com/search/api](https://brave.com/search/api) |
| Context7 Docs | `CONTEXT7_API_KEY` | Library documentation lookup | [context7.com/dashboard](https://context7.com/dashboard) |

### How it works

1. `/gsd config` saves keys to `~/.gsd/agent/auth.json`
2. On every session start, `loadToolApiKeys()` reads the file and sets environment variables
3. Keys apply to all projects — no per-project setup required
4. Environment variables (`export BRAVE_API_KEY=...`) take precedence over saved keys
5. Anthropic models don't need Brave/Tavily — they have built-in web search

## MCP Servers

GSD can connect to external MCP servers configured in project files. This is useful for local tools, internal APIs, self-hosted services, or integrations that aren't built in as native GSD extensions.

### Config file locations

GSD reads MCP client configuration from these project-local paths:

- `.mcp.json`
- `.gsd/mcp.json`

If both files exist, server names are merged and the first definition found wins. Use:

- `.mcp.json` for repo-shared MCP configuration you may want to commit
- `.gsd/mcp.json` for local-only MCP configuration you do **not** want to share

### Supported transports

| Transport | Config shape | Use when |
|-----------|--------------|----------|
| `stdio` | `command` + optional `args`, `env`, `cwd` | Launching a local MCP server process |
| `http` | `url` | Connecting to an already-running MCP server over HTTP |

### Example: stdio server

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "/absolute/path/to/python3",
      "args": ["/absolute/path/to/server.py"],
      "env": {
        "API_URL": "http://localhost:8000"
      }
    }
  }
}
```

### Example: HTTP server

```json
{
  "mcpServers": {
    "my-http-server": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

### Verifying a server

After adding config, verify it from a GSD session:

```text
mcp_servers
mcp_discover(server="my-server")
mcp_call(server="my-server", tool="<tool_name>", args={...})
```

Recommended verification order:

1. `mcp_servers` — confirms GSD can see the config file and parse the server entry
2. `mcp_discover` — confirms the server process starts and responds to `tools/list`
3. `mcp_call` — confirms at least one real tool invocation works

### Notes

- Use absolute paths for local executables and scripts when possible.
- For `stdio` servers, prefer setting required environment variables directly in the MCP config instead of relying on an interactive shell profile.
- If a server is team-shared and safe to commit, `.mcp.json` is usually the better home.
- If a server depends on machine-local paths, personal services, or local-only secrets, prefer `.gsd/mcp.json`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GSD_HOME` | `~/.gsd` | Global GSD directory. All paths derive from this unless individually overridden. Affects preferences, skills, sessions, and per-project state. (v2.39) |
| `GSD_PROJECT_ID` | (auto-hash) | Override the automatic project identity hash. Per-project state goes to `$GSD_HOME/projects/<GSD_PROJECT_ID>/` instead of the computed hash. Useful for CI/CD or sharing state across clones of the same repo. (v2.39) |
| `GSD_STATE_DIR` | `$GSD_HOME` | Per-project state root. Controls where `projects/<repo-hash>/` directories are created. Takes precedence over `GSD_HOME` for project state. |
| `GSD_CODING_AGENT_DIR` | `$GSD_HOME/agent` | Agent directory containing managed resources, extensions, and auth. Takes precedence over `GSD_HOME` for agent paths. |

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

Define custom models and providers in `~/.gsd/agent/models.json`. This lets you add models not included in the default registry — useful for self-hosted endpoints (Ollama, vLLM, LM Studio), fine-tuned models, proxies, or new provider releases.

GSD resolves models.json with fallback logic:
1. `~/.gsd/agent/models.json` — primary (GSD)
2. `~/.pi/agent/models.json` — fallback (Pi)
3. If neither exists, creates `~/.gsd/agent/models.json`

**Quick example for local models (Ollama):**

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

The file reloads each time you open `/model` — no restart needed.

For full documentation including provider configuration, model overrides, OpenAI compatibility settings, and advanced examples, see the [Custom Models Guide](./custom-models.md).

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

### Community Provider Extensions

For providers not built into GSD, community extensions can add full provider support with proper model definitions, thinking format configuration, and interactive API key setup.

| Extension | Provider | Models | Install |
|-----------|----------|--------|---------|
| [`pi-dashscope`](https://www.npmjs.com/package/pi-dashscope) | Alibaba DashScope (ModelStudio) | Qwen3, GLM-5, MiniMax M2.5, Kimi K2.5 | `gsd install npm:pi-dashscope` |

Community extensions are recommended over the built-in `alibaba-coding-plan` provider for DashScope models — they use the correct OpenAI-compatible endpoint and include per-model compatibility flags for thinking mode.

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
  reassess_after_slice: true  # enable roadmap reassessment after each slice (required for reassessment)
  require_slice_discussion: false  # pause auto-mode before each slice for discussion
```

These are usually set automatically by `token_profile`, but can be overridden explicitly.

> **Note:** Roadmap reassessment requires `reassess_after_slice: true` to be set explicitly. Without it, reassessment is skipped regardless of `skip_reassess`.

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

### Verification (v2.26)

Configure shell commands that run automatically after every task execution. Failures trigger auto-fix retries before advancing.

```yaml
verification_commands:
  - npm run lint
  - npm run test
verification_auto_fix: true       # auto-retry on failure (default: true)
verification_max_retries: 2       # max retry attempts (default: 2)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `verification_commands` | string[] | `[]` | Shell commands to run after task execution |
| `verification_auto_fix` | boolean | `true` | Auto-retry when verification fails |
| `verification_max_retries` | number | `2` | Maximum auto-fix retry attempts |

### `auto_report` (v2.26)

Auto-generate HTML reports after milestone completion:

```yaml
auto_report: true    # default: true
```

Reports are written to `.gsd/reports/` as self-contained HTML files with embedded CSS/JS.

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
  manage_gitignore: true      # set false to prevent GSD from modifying .gitignore
  worktree_post_create: .gsd/hooks/post-worktree-create  # script to run after worktree creation
  auto_pr: false              # create a PR on milestone completion (requires push_branches)
  pr_target_branch: develop   # target branch for auto-created PRs (default: main branch)
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
| `manage_gitignore` | boolean | `true` | When `false`, GSD will not modify `.gitignore` at all — no baseline patterns, no self-healing. Use if you manage your own `.gitignore` |
| `worktree_post_create` | string | (none) | Script to run after worktree creation. Receives `SOURCE_DIR` and `WORKTREE_DIR` env vars |
| `auto_pr` | boolean | `false` | Automatically create a pull request when a milestone completes. Requires `auto_push: true` and `gh` CLI installed and authenticated |
| `pr_target_branch` | string | (main branch) | Target branch for auto-created PRs (e.g. `develop`, `qa`). Defaults to `main_branch` if not set |

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

#### `git.auto_pr`

Automatically create a pull request when a milestone completes. Designed for teams using Gitflow or branch-based workflows where work should go through PR review before merging to a target branch.

```yaml
git:
  auto_push: true
  auto_pr: true
  pr_target_branch: develop  # or qa, staging, etc.
```

**Requirements:**
- `auto_push: true` — the milestone branch must be pushed before a PR can be created
- [`gh` CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)

**How it works:**
1. Milestone completes → GSD squash-merges the worktree to the main branch
2. Pushes the main branch to remote (if `auto_push: true`)
3. Pushes the milestone branch to remote
4. Creates a PR from the milestone branch to `pr_target_branch` via `gh pr create`

If `pr_target_branch` is not set, the PR targets the `main_branch` (or auto-detected main branch). PR creation failure is non-fatal — GSD logs and continues.

### `github` (v2.39)

GitHub sync configuration. When enabled, GSD auto-syncs milestones, slices, and tasks to GitHub Issues, PRs, and Milestones.

```yaml
github:
  enabled: true
  repo: "owner/repo"              # auto-detected from git remote if omitted
  labels: [gsd, auto-generated]   # labels applied to created issues/PRs
  project: "Project ID"           # optional GitHub Project board
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable GitHub sync |
| `repo` | string | (auto-detected) | GitHub repository in `owner/repo` format |
| `labels` | string[] | `[]` | Labels to apply to created issues and PRs |
| `project` | string | (none) | GitHub Project ID for project board integration |

**Requirements:**
- `gh` CLI installed and authenticated (`gh auth login`)
- Sync mapping is persisted in `.gsd/.github-sync.json`
- Rate-limit aware — skips sync when GitHub API rate limit is low

**Commands:**
- `/github-sync bootstrap` — initial setup and sync
- `/github-sync status` — show sync mapping counts

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

**macOS delivery:** GSD uses [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) when available, falling back to `osascript`. We recommend installing `terminal-notifier` for reliable notification delivery:

```bash
brew install terminal-notifier
```

Why: `osascript display notification` is attributed to your terminal app (Ghostty, iTerm2, etc.), which may not have notification permissions in System Settings → Notifications. `terminal-notifier` registers as its own app and prompts for permission on first use. See [Troubleshooting: Notifications not appearing on macOS](troubleshooting.md#notifications-not-appearing-on-macos) if notifications aren't working.

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

Skills can be bare names (looked up in `~/.agents/skills/` and `.agents/skills/`) or absolute paths.

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

### `RUNTIME.md` — Runtime Context (v2.39)

Declare project-level runtime context in `.gsd/RUNTIME.md`. This file is inlined into task execution prompts, giving the agent accurate information about your runtime environment without relying on hallucinated paths or URLs.

**Location:** `.gsd/RUNTIME.md`

**Example:**

```markdown
# Runtime Context

## API Endpoints
- Main API: https://api.example.com
- Cache: redis://localhost:6379

## Environment Variables
- DEPLOYMENT_ENV: staging
- DB_POOL_SIZE: 20

## Local Services
- PostgreSQL: localhost:5432
- Redis: localhost:6379
```

Use this for information that the agent needs during execution but that doesn't belong in `DECISIONS.md` (architectural) or `KNOWLEDGE.md` (patterns/rules). Common examples: API base URLs, service ports, deployment targets, and environment-specific configuration.

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

### `service_tier` (v2.42)

OpenAI service tier preference for supported models. Toggle with `/gsd fast`.

| Value | Behavior |
|-------|----------|
| `"priority"` | Priority tier — 2x cost, faster responses |
| `"flex"` | Flex tier — 0.5x cost, slower responses |
| (unset) | Default tier |

```yaml
service_tier: priority
```

### `forensics_dedup` (v2.43)

Opt-in: search existing issues and PRs before filing from `/gsd forensics`. Uses additional AI tokens.

```yaml
forensics_dedup: true    # default: false
```

### `show_token_cost` (v2.44)

Opt-in: show per-prompt and cumulative session token cost in the footer.

```yaml
show_token_cost: true    # default: false
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

# Service tier
service_tier: priority         # "priority" or "flex" (for /gsd fast)

# Diagnostics
forensics_dedup: true          # deduplicate before filing forensics issues
show_token_cost: true          # show per-prompt cost in footer

# Hooks
post_unit_hooks:
  - name: code-review
    after: [execute-task]
    prompt: "Review {sliceId}/{taskId} for quality and security."
    artifact: REVIEW.md
---
```
