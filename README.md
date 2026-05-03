<div align="center">

# GSD 2

**The evolution of [Get Shit Done](https://github.com/gsd-build/get-shit-done) — now a real coding agent.**

[![npm version](https://img.shields.io/npm/v/gsd-pi?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/gsd-pi)
[![npm downloads](https://img.shields.io/npm/dm/gsd-pi?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/gsd-pi)
[![GitHub stars](https://img.shields.io/github/stars/gsd-build/GSD-2?style=for-the-badge&logo=github&color=181717)](https://github.com/gsd-build/GSD-2)
[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.com/invite/nKXTsAcmbT)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![$GSD Token](https://img.shields.io/badge/$GSD-Dexscreener-1C1C1C?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgZmlsbD0iIzAwRkYwMCIvPjwvc3ZnPg==&logoColor=00FF00)](https://dexscreener.com/solana/dwudwjvan7bzkw9zwlbyv6kspdlvhwzrqy6ebk8xzxkv)

The original GSD went viral as a prompt framework for Claude Code. It worked, but it was fighting the tool — injecting prompts through slash commands, hoping the LLM would follow instructions, with no actual control over context windows, sessions, or execution.

This version is different. GSD is now a standalone CLI built on the [Pi SDK](https://github.com/badlogic/pi-mono), which gives it direct TypeScript access to the agent harness itself. That means GSD can actually _do_ what v1 could only _ask_ the LLM to do: clear context between tasks, inject exactly the right files at dispatch time, manage git branches, track cost and tokens, detect stuck loops, recover from crashes, and auto-advance through an entire milestone without human intervention.

One command. Walk away. Come back to a built project with clean git history.

<pre><code>npm install -g gsd-pi@latest</code></pre>

> GSD now provisions a managed [RTK](https://github.com/rtk-ai/rtk) binary on supported macOS, Linux, and Windows installs to compress shell-command output in `bash`, `async_bash`, `bg_shell`, and verification flows. GSD forces `RTK_TELEMETRY_DISABLED=1` for all managed invocations. Set `GSD_RTK_DISABLED=1` to disable the integration.

> **📋 NOTICE: New to Node on Mac?** If you installed Node.js via Homebrew, you may be running a development release instead of LTS. **[Read this guide](./docs/user-docs/node-lts-macos.md)** to pin Node 24 LTS and avoid compatibility issues.

</div>

---

## What's New in v2.79

### DB-Authoritative Runtime State

- **Auto-mode coordination tables (#5247)** — workers, leases, dispatches, and a command queue are now first-class DB rows, replacing ad-hoc files for cross-process auto coordination.
- **`auto.lock` + `paused-session.json` → DB (#5250)** — phase C pt 2 of the runtime-state migration. The on-disk lockfile and paused-session JSON are gone; lock acquisition, stale-lock detection, and pause state all live in `gsd.db`.
- **Stuck-state migration (#5249)** — `copyPlanningArtifacts` / `reconcile` deleted; auto-mode writers canonicalize through the DB instead of mirroring artifacts to disk.
- **`gsd headless recover`** — non-TTY DB recovery command for unattended environments where the interactive recover flow can't run.
- **Doctor surfaces DB locks** — `gsd doctor` reports DB-backed stale locks and flags exhausted `run-uat` retry counters so wedged runs are visible without log archaeology.

### Workspace & Worktree Isolation

- **`GsdWorkspace` + `MilestoneScope` handle types** — workspace identity is now an explicit handle threaded through writers, metrics, and the DB connection instead of a module singleton.
- **Symlink-safe canonicalization** — `deriveState` read root and cache key are canonicalized; path normalization unified on `realpathSync.native`; `gsdRootCache` keys normalized and decoupled from per-turn cache clears; `git-root` anchor guarded against `~/.gsd` resolution.
- **Worktree-scoped DB + metrics** — `gsd-db` connections and metrics ledgers are scoped by workspace identity, so concurrent milestones in separate worktrees can't cross-contaminate state.
- **Worktree cwd anchoring** — subagent dispatch anchors to the canonical worktree path, `mergeAndExit` anchors cwd at project root (closes [#5079](https://github.com/gsd-build/GSD-2/issues/5079)), MCP cwd is hardened against drift, and dispatch stops on cwd anchor failures.
- **Slice isolation through resolver (#5246)** — slice merge isolation routed through the worktree resolver; `originalBase` checks use `isSamePath` instead of string equality; `auto-worktree` validates `milestoneId` match in `ByScope` wrappers.
- **Worktree CLI commands** — `gsd worktree {list, merge, clean, remove}` exposed in the TUI dispatcher.

### Deep Planning Mode (Phase 11)

- **`/gsd new-project --deep`** — opt-in deep mode for new projects, with `research-decision` and `research-project` dispatch units, deep-mode artifact validators, and gated approval flows that pause the milestone instead of aborting on grounding/discovery questions.
- **EVAL-REVIEW system** — `/gsd eval-review` command, frontmatter schema, pre-ship soft warning when EVAL-REVIEW status is incomplete, and registration in the catalog + ops dispatcher.
- **Project-shape-aware discuss depth** — discuss-phase questioning depth scales via the project-shape classifier; tiny apps cap research and auto-skip stale research blockers; deep research is opt-in and blocked while a marker is in flight.
- **Approval-gate hardening** — deep approval gates verified, opening interview question protected from approval abort, plain-text setup approvals gated, deep setup state guarded against phantom transitions.

### Auto Pipeline & Dispatch

- **Delegation-policy verdicts** — dispatch actions are annotated with a per-tool background-safety policy verdict; the policy itself is codified instead of inferred per call.
- **Reactive-execute default** — auto-dispatch defaults to reactive-execute when ≥3 ready tasks are queued, replacing the always-sequential fallback.
- **Proactive rate limiting (#2996)** — `min_request_interval_ms` preference paces auto-mode requests; the interval is stamped at dispatch.
- **Manifest-driven skill surfacing** — `auto-prompts` surfaces manifest skills via recommendations + auto-match; planning-dispatch mode added to the unit manifest for slice plan/complete; runtime tools-policy enforced for planning units (#4934).
- **Subagent telemetry** — dispatch telemetry, stronger prompt guidelines, and model-override threading (`??` consistently used for `modelOverride`).

### MCP, Models & Cross-Platform

- **Global MCP config** — `mcp-client` reads `~/.gsd/mcp.json` for user-level MCP server config.
- **`ask_user_questions` over MCP** — host elicitation tried before remote channel; multi-select array shape preserved; explicit cancellation handled; remote answers normalized into `structuredContent`.
- **Model routing overhaul** — cross-provider tier resolution, provider-agnostic profile-tier defaults, disabled-provider routing denylist, resolved tier model IDs normalized, and `findModelForTier` with behavioral tests.
- **Ollama** — configurable probe/request timeouts via env vars (clamped); cloud / long-variant context windows reported correctly.
- **Windows fixes** — home directory resolved correctly (#5015), `Path` env lookup repaired, Windows-safe env CLI shims, DEP0190 avoided in Claude CLI binary probes, tool-bootstrap skipped when tools are on PATH.
- **Anthropic prompt-cache preserved (#5019)** — `pi-coding-agent` and `gsd` no longer thrash the cache on dispatch.

### Git, GitHub Sync & Reliability

- **Integration-branch self-merge guard (#5024)** — milestone refuses to self-merge when the integration branch equals the milestone branch; self-merge ref guard normalized.
- **Slice-cadence safety** — integration branch used for slice cadence, dirty worktree state preserved on merge, checked-out slice worktrees advance safely, slice PRs deferred until completion, slice-PR sync stays retryable on failure.
- **Milestone-ID reservation** — DB rows included in reservation; ghost IDs reused in `nextMilestoneId` to close gaps; `ensurePreconditions` guarded against phantom IDs (#4996); orphan milestone-dir doctor check (#4996); milestone-dir creation deferred until first artifact write.
- **Auto-commit hygiene** — task commits scoped to reported files, generated commit subjects sanitized, user hooks run on automated commits, milestone-tagged commits bound when `.gsd/` is gitignored (#5033), startup blocked on `git index.lock`.
- **GitHub sync** — issues no longer closed before delivery, failed task closure / slice PR sync stay retryable, config cache scoped by project, safe git environment used.

### Safety, Recovery & Hardening

- **Policy-block pause through dispatch errors** — pause state is preserved when dispatch errors out mid-policy-block.
- **Skip-validation persistence** — skip-validation state persists and gate rows are cleared on recover.
- **Cancelled-gate hard block** — redirected to `ask_user_questions`; false plain-text claim dropped from the message.
- **Write-gate basePath required** — `process.cwd()` defaults removed; basePath threaded through pre-existing tests.
- **Atomic metrics writes** — parallel-mode `metrics.json` writes merge atomically; ledger cache invalidated after prune; `saveLedger` aborts when lock not acquired; stale-lock detection adds PID stamp + async yield.
- **Auto-worktree teardown** — `activeWorkspace` guaranteed cleared on teardown failure; teardown try/finally broadened to cover `chdir`; cleanup steps mirrored on the abort path; warning emitted on resume when persisted worktree is missing.
- **Empty-turn nudge** — no longer auto-replies to user questions; deferred on mid-line approval prompts.
- **Refuses project writes from `$HOME`** — and surfaces real SQL errors from `capture_thought` instead of swallowing them.

### VS Code & TUI

- **Checkpoint tree view** — registered in the VS Code extension; checkpoint file existence restored; RPC file-mutation events tracked; agent diff scoped to tracked files.
- **TUI image paste** — pasted images preserved on regular submit.
- **Bundled `/gsd` slash command protected** — core handler refuses to overwrite the bundled command.

See the full [Changelog](./CHANGELOG.md) for the complete v2.79 entry and prior releases.

<details>
<summary>v2.78 highlights</summary>

- **Slice-cadence worktree collapse (#4765)** — `git.collapse_cadence: "milestone" | "slice"` shrinks the orphan window per-slice; pair with `git.milestone_resquash: true` to collapse to one milestone commit
- **Worktree telemetry (#4764)** — journal events + `summarizeWorktreeTelemetry`; `/gsd forensics` worktree section with `worktree-orphan` and `worktree-unmerged-exit` anomalies
- **Worktree-aware canonical milestone root (#4761)** — `resolveCanonicalMilestoneRoot` routes validators through the live worktree
- **Bootstrap orphan audit (#4762)** — in-progress milestones with commits ahead of main are no longer skipped
- **Unified component system** — skills, agents, pipelines, and marketplace as one component model wired through runtime, dispatch, and telemetry
- **UnitContextManifest v2 (#4924, #4934)** — typed manifest with declarative tools-policy and typed computed artifacts; CI-guarded
- **Composer migration phase 3 (#4782)** — `complete-slice`, `research-milestone`, `run-uat`, `reassess-roadmap` build context through the manifest composer
- **Milestone scope classifier + pipeline variants (#4781)** — auto picks a pipeline variant from milestone shape
- **Per-unit-type skill manifest resolver (#4779)** — skills wire into specific unit types instead of being globally on
- **Single-writer-v3 control plane** — durable-state writer gaps closed
- **Extensions framework** — `gsd extensions install / update / uninstall / list / info / validate`; topological load order; cmux↔gsd decoupling via `cmux-events`; extracted `@gsd-extensions/google-search`
- **GPT-5.5 Codex support** + `xhigh` thinking level; auth mode in `/model`; permission granularity picker; headless auto default → `bypassPermissions` (#4657)
- **Major git-safety pass** — TOCTOU ancestry guard, atomic sync-lock with PID-verified stale override, `.git/index.lock` 5-min gate, env overlay strip, rebase/cherry-pick/revert detection, working-tree stash before `reset --hard`, unborn-branch worktree guard, user hooks + `commit.gpgsign` on auto-commits
- **Atomic `.gsd/` state writes**; **compaction correctness fix (#4665)**; **write-gate hardening (#4950)**; **auto state-machine** non-retriable policy errors (#4973), baseline restoration (#4961, #4966); slice + crash recovery; empty-turn recovery shape canonicalized

</details>

<details>
<summary>v2.77 highlights</summary>

- **Context Mode** — dispatch builds task-ready context automatically (artifacts, prior session, milestone/slice signals, execution metadata); enabled by default for new projects
- **Sandboxed execution tools** — `gsd_exec_search`, `gsd_resume`, and sandboxed tool-output paths for context-mode flows
- **Memory architecture (ADR-013)** — `memories` table is now authoritative; `structured_fields` adds typed metadata; dual-write migration landed with decisions backfill
- **Skill coverage** — 9 gap-closing skills landed plus 6 planning/design skills surfaced
- **Hook stack** — Layer 0 shell hooks and additional Layer 2 lifecycle events
- **TUI polish** — dedicated chat-frame style for skill invocations; active-row overflow fixes
- **Worktree + dispatch resilience** — crash-recovery dispatch hardened, safer path derivation, improved worktree context fallback
- **DB/schema guardrails** — migration/index ordering and schema version stamping tightened
- **Preflight hardening** — milestone completion enforces stricter clean-root checks with auto-stash

</details>

<details>
<summary>v2.75 highlights</summary>

- **Knowledge graph system** — structured knowledge graph built from project artifacts
- **`/gsd extract-learnings`** — extracts decisions, lessons, patterns, and surprises into `LEARNINGS.md`
- **Unified Orchestration Kernel (UOK)** — now the default execution path with plan-v2 compile gates and reactive/parallel scheduling
- **GSD Extension API** — third-party extensions loadable from `.gsd/extensions/` (#3338)
- **v1 command parity** — 12 missing commands added, closing the migration gap
- **Chat frame redesign** — unified styling for compaction notices, tool cards, and chat frame with timestamps and model headers
- **Single-writer DB invariant** — engine database enforces single-writer to prevent corruption
- **MCP worktree routing** — tool writes routed to active worktree; worktree paths accepted in project root guard
- **Alibaba DashScope** — added as a standalone provider (#3891)
- **Persistent language preference** — `/gsd language`

</details>

<details>
<summary>v2.74 highlights</summary>

- **DB-authoritative milestone completeness** — milestone completion state is derived from the database, not file markers (#4179)
- **Flat-rate provider detection** — extended to custom and externalCli providers
- **Thinking level as effort** — Claude Code passes thinking level as an effort parameter
- **False milestone merge prevention** — auto-mode no longer falsely merges after a `complete-milestone` failure (#4175)
- **Premature auto-stop fix** — prevents auto-mode from stopping early on blocked phase + missing reassessment
- **Inline tool call rendering** — assistant tool calls render inline with text instead of grouped at the end
- **Custom model preservation** — custom model selection preserved on `/gsd auto` bootstrap (#4122)

</details>

<details>
<summary>v2.73 highlights</summary>

- **Alibaba DashScope provider** — added as a standalone provider (#3891)
- **Layered depth enforcement** — discuss phase enforces depth gates for thorough requirements gathering (#4079)
- **Memory pressure watchdog** — stuck detection state persisted across sessions (#3708)
- **Ollama cloud auth** — cloud auth support and real context window resolution via `/api/show` (#4017)
- **DB corruption prevention** — direct writes to `gsd.db` blocked via hooks (#3674)
- **Circular dependency cleanup** — 3 circular dependencies broken in extension modules (#3730)
- **Subagent permissions** — GSD subagents default to `bypassPermissions` with safe built-ins pre-authorized
- **Security hardening** — auth middleware activated, shutdown/update routes hardened (#4023)
- **Stale slice reconciliation** — stale slice rows reconciled and STATE.md rebuilt before DB close (#3658)
- **Subagent model preference** — `subagent_model` preference wired through to dispatch prompt builders
- **Pipeline integrity** — 5 pipeline issues addressed from release audit, package-lock.json regenerated during bumps

</details>

<details>
<summary>v2.72 highlights</summary>

- **8 specialist subagents** — new specialist subagents and slim pro agents with GSD phase guard to prevent conflicts
- **Model selection hardening** — unconfigured models blocked from selection, provider readiness required, session override honored
- **Auto-mode resilience** — credential cooldown recovery with bounded retry budget, fire-and-forget auto start, scoped forensics
- **TUI overhaul** — overlays, keyboard shortcuts, and notification flows redesigned for consistency
- **Capability-aware routing (ADR-004)** — full implementation of capability scoring, `before_model_select` hook, and task metadata extraction
- **Multi-model provider strategy (ADR-005)** — infrastructure for multi-provider model selection wired into live paths
- **Anti-fabrication guardrails** — discuss prompts enforce turn-taking to prevent fabricated user responses
- **Windows portability** — hardened cross-platform portability across runtime, tooling, and CI
- **MCP reliability** — every registered tool exposed, SDK subpath resolution fixed, abort signals threaded through
- **Tool cache control** — `cache_control` breakpoints added to tool definitions for improved prompt caching

</details>

<details>
<summary>v2.71 highlights</summary>

- **Secure credential collection over MCP** — `secure_env_collect` tool uses MCP form elicitation to collect secrets without exposing values in tool output
- **MCP stream ordering** — tool output renders in correct order, fixing interleaved output in Claude Code and other MCP clients
- **isError flag propagation** — workflow tool execution failures correctly return `isError: true`
- **Multi-round discuss questions** — new-project discuss phase supports multi-round questioning with structured question gates
- **TOCTOU file locking** — race conditions in event log and custom workflow graph file locking fixed with atomic lock acquisition
- **State derive refactor** — `deriveStateFromDb` god function extracted into composable, testable helpers
- **Pinned output fixes** — restored above editor during tool execution, cleared on turn completion

</details>

<details>
<summary>v2.70 and earlier</summary>

- **Full workflow over MCP (v2.68)** — slice replanning, milestone management, slice completion, task completion, and core planning tools exposed over MCP
- **Transport-gated MCP (v2.68)** — workflow tool availability adapts to provider transport capabilities automatically
- **Contextual tips system (v2.68)** — TUI and web terminal surface contextual tips based on workflow state
- **Ask user questions over MCP (v2.70)** — interactive questions exposed via elicitation for external integrations
- **Tiered Context Injection (M005)** — relevance-scoped context with 65%+ token reduction
- **5-wave state machine hardening** — critical data integrity fixes across atomic writes, event log reconciliation, session recovery
- **Slice-level parallelism** — dependency-aware parallel dispatch within a milestone
- **MCP server** — 6 read-only project state tools for external integrations, auto-wrapup guard, and question dedup
- **Ollama extension** — first-class local LLM support via Ollama, with dynamic routing enabled by default
- **VS Code sidebar redesign** — SCM provider, checkpoints, diagnostics panel, activity feed, workflow controls, session forking
- **Skills overhaul** — 30+ skill packs covering major frameworks, databases, and cloud platforms
- **Single-writer state engine** — disciplined state transitions with machine guards and TOCTOU hardening
- **DB-backed planning tools** — atomic SQLite tool calls for state transitions
- **Declarative workflow engine** — YAML workflows through auto-loop
- **Doctor: worktree lifecycle checks** — validates worktree health, detects orphans, consolidates cleanup

</details>

---

## Documentation

Full documentation is in the [`docs/`](./docs/) directory:

### User Guides

- **[Getting Started](./docs/user-docs/getting-started.md)** — install, first run, basic usage
- **[Auto Mode](./docs/user-docs/auto-mode.md)** — autonomous execution deep-dive
- **[Configuration](./docs/user-docs/configuration.md)** — all preferences, models, git, and hooks
- **[Custom Models](./docs/user-docs/custom-models.md)** — add custom providers (Ollama, vLLM, LM Studio, proxies)
- **[Token Optimization](./docs/user-docs/token-optimization.md)** — profiles, context compression, complexity routing
- **[Cost Management](./docs/user-docs/cost-management.md)** — budgets, tracking, projections
- **[Git Strategy](./docs/user-docs/git-strategy.md)** — worktree isolation, branching, merge behavior
- **[Parallel Orchestration](./docs/user-docs/parallel-orchestration.md)** — run multiple milestones simultaneously
- **[Working in Teams](./docs/user-docs/working-in-teams.md)** — unique IDs, shared artifacts
- **[Skills](./docs/user-docs/skills.md)** — bundled skills, discovery, custom authoring
- **[Commands Reference](./docs/user-docs/commands.md)** — all commands and keyboard shortcuts
- **[Troubleshooting](./docs/user-docs/troubleshooting.md)** — common issues, doctor, forensics, recovery
- **[Visualizer](./docs/user-docs/visualizer.md)** — workflow visualizer with stats and discussion status
- **[Remote Questions](./docs/user-docs/remote-questions.md)** — route decisions to Slack or Discord when human input is needed
- **[Dynamic Model Routing](./docs/user-docs/dynamic-model-routing.md)** — complexity-based model selection and budget pressure
- **[Web Interface](./docs/user-docs/web-interface.md)** — browser-based project management and real-time progress
- **[Migration from v1](./docs/user-docs/migration.md)** — `.planning` → `.gsd` migration
- **[Docker Sandbox](./docker/README.md)** — run GSD auto mode in an isolated Docker container

### Developer Docs

- **[Architecture](./docs/dev/architecture.md)** — system design and dispatch pipeline
- **[CI/CD Pipeline](./docs/dev/ci-cd-pipeline.md)** — three-stage promotion pipeline (Dev → Test → Prod)
- **[Pipeline Simplification (ADR-003)](./docs/dev/ADR-003-pipeline-simplification.md)** — merged research into planning, mechanical completion
- **[VS Code Extension](./vscode-extension/README.md)** — chat participant, sidebar dashboard, RPC integration

---

## What Changed From v1

The original GSD was a collection of markdown prompts installed into `~/.claude/commands/`. It relied entirely on the LLM reading those prompts and doing the right thing. That worked surprisingly well — but it had hard limits:

- **No context control.** The LLM accumulated garbage over a long session. Quality degraded.
- **No real automation.** "Auto mode" was the LLM calling itself in a loop, burning context on orchestration overhead.
- **No crash recovery.** If the session died mid-task, you started over.
- **No observability.** No cost tracking, no progress dashboard, no stuck detection.

GSD v2 solves all of these because it's not a prompt framework anymore — it's a TypeScript application that _controls_ the agent session.

|                      | v1 (Prompt Framework)        | v2 (Agent Application)                                  |
| -------------------- | ---------------------------- | ------------------------------------------------------- |
| Runtime              | Claude Code slash commands   | Standalone CLI via Pi SDK                               |
| Context management   | Hope the LLM doesn't fill up | Fresh session per task, programmatic                    |
| Auto mode            | LLM self-loop                | State machine reading `.gsd/` files                     |
| Crash recovery       | None                         | Lock files + session forensics                          |
| Git strategy         | LLM writes git commands      | Worktree isolation, sequential commits, squash merge    |
| Cost tracking        | None                         | Per-unit token/cost ledger with dashboard               |
| Stuck detection      | None                         | Retry once, then stop with diagnostics                  |
| Timeout supervision  | None                         | Soft/idle/hard timeouts with recovery steering          |
| Context injection    | "Read this file"             | Pre-inlined into dispatch prompt                        |
| Roadmap reassessment | Manual                       | Automatic after each slice completes                    |
| Skill discovery      | None                         | Auto-detect and install relevant skills during research |
| Verification         | Manual                       | Automated verification commands with auto-fix retries   |
| Reporting            | None                         | Self-contained HTML reports with metrics and dep graphs |
| Parallel execution   | None                         | Multi-worker parallel milestone orchestration           |

### Migrating from v1

> **Note:** Migration works best with a `ROADMAP.md` file for milestone structure. Without one, milestones are inferred from the `phases/` directory.

If you have projects with `.planning` directories from the original Get Shit Done, you can migrate them to GSD-2's `.gsd` format:

```bash
# From within the project directory
/gsd migrate

# Or specify a path
/gsd migrate ~/projects/my-old-project
```

The migration tool:

- Parses your old `PROJECT.md`, `ROADMAP.md`, `REQUIREMENTS.md`, phase directories, plans, summaries, and research
- Maps phases → slices, plans → tasks, milestones → milestones
- Preserves completion state (`[x]` phases stay done, summaries carry over)
- Consolidates research files into the new structure
- Shows a preview before writing anything
- Optionally runs an agent-driven review of the output for quality assurance

Supports format variations including milestone-sectioned roadmaps with `<details>` blocks, bold phase entries, bullet-format requirements, decimal phase numbering, and duplicate phase numbers across milestones.

---

## How It Works

GSD structures work into a hierarchy:

```
Milestone  →  a shippable version (4-10 slices)
  Slice    →  one demoable vertical capability (1-7 tasks)
    Task   →  one context-window-sized unit of work
```

The iron rule: **a task must fit in one context window.** If it can't, it's two tasks.

### The Loop

Each slice flows through phases automatically:

```
Plan (with integrated research) → Execute (per task) → Complete → Reassess Roadmap → Next Slice
                                                                                      ↓ (all slices done)
                                                                              Validate Milestone → Complete Milestone
```

**Plan** scouts the codebase, researches relevant docs, and decomposes the slice into tasks with must-haves (mechanically verifiable outcomes). **Execute** runs each task in a fresh context window with only the relevant files pre-loaded — then runs configured verification commands (lint, test, etc.) with auto-fix retries. **Complete** writes the summary, UAT script, marks the roadmap, and commits with meaningful messages derived from task summaries. **Reassess** checks if the roadmap still makes sense given what was learned. **Validate Milestone** runs a reconciliation gate after all slices complete — comparing roadmap success criteria against actual results before sealing the milestone.

### `/gsd auto` — The Main Event

This is what makes GSD different. Run it, walk away, come back to built software.

```
/gsd auto
```

Auto mode is a state machine driven by the GSD database at the project root. It derives the next unit of work from authoritative SQLite state, creates a fresh agent session, injects a focused prompt with all relevant context pre-inlined, and lets the LLM execute. When the LLM finishes, auto mode persists the result to the database, refreshes markdown projections such as `STATE.md`, and dispatches the next unit.

The database is authoritative for milestones, slices, tasks, requirements, decisions, summaries, and completion status. Markdown under `.gsd/` is a rendered projection for review, prompts, and git-friendly history; it is not a runtime fallback unless you explicitly run a recovery/import command. In worktree mode, project-root DB state remains authoritative and worktree markdown projections are not synced back as state.

**What happens under the hood:**

1. **Fresh session per unit** — Every task, every research phase, every planning step gets a clean 200k-token context window. No accumulated garbage. No "I'll be more concise now."

2. **Context pre-loading** — The dispatch prompt includes inlined task plans, slice plans, prior task summaries, dependency summaries, roadmap excerpts, and decisions register. The LLM starts with everything it needs instead of spending tool calls reading files.

3. **Context Mode** — Context Mode is enabled by default and gives every auto-mode unit guidance for preserving context. Agents are steered toward `gsd_exec` for noisy scans, builds, tests, and diagnostics; full stdout/stderr is saved under `.gsd/exec/` while only a short digest enters the conversation. `gsd_exec_search` lets agents reuse prior runs instead of repeating expensive checks, and `gsd_resume` reads `.gsd/last-snapshot.md` after compaction or resume. Opt out with `context_mode.enabled: false`; tune sandbox timeout/output caps with `context_mode.exec_timeout_ms`, `context_mode.exec_stdout_cap_bytes`, and `context_mode.exec_digest_chars`.

4. **Git isolation** — When `git.isolation` is set to `worktree` or `branch`, each milestone runs on its own `milestone/<MID>` branch (in a worktree or in-place). All slice work commits sequentially — no branch switching, no merge conflicts. When the milestone completes, it's squash-merged to main as one clean commit. The default is `none` (work on the current branch), configurable via preferences. If `worktree` is configured in a repo with no committed `HEAD`, GSD temporarily behaves as `none` until the first commit exists because git worktrees need a committed start point.

5. **Crash recovery** — Auto mode persists worker state, unit-dispatch state, and paused-session metadata in the project-root SQLite database. If the session dies, the next `/gsd auto` reconstructs the interrupted unit from DB-backed runtime state, reads the surviving session file, synthesizes a recovery briefing from every tool call that made it to disk, and resumes with full context. Parallel orchestrator IPC still lives under `.gsd/parallel/`, so multi-worker sessions survive crashes too. In headless mode, crashes trigger automatic restart with exponential backoff (default 3 attempts).

6. **Provider error recovery** — Transient provider errors (rate limits, 500/503 server errors, overloaded) auto-resume after a delay. Permanent errors (auth, billing) pause for manual review. The model fallback chain retries transient network errors before switching models.

7. **Stuck and artifact detection** — A sliding-window detector identifies repeated dispatch patterns (including multi-unit cycles). Missing expected artifacts use a separate bounded path: GSD retries artifact verification up to 3 times with failure context, then pauses auto mode with the missing artifact error instead of looping indefinitely.

8. **Timeout supervision** — Soft timeout warns the LLM to wrap up. Idle watchdog detects stalls. Hard timeout pauses auto mode. Recovery steering nudges the LLM to finish durable output before giving up.

9. **Cost tracking** — Every unit's token usage and cost is captured, broken down by phase, slice, and model. The dashboard shows running totals and projections. Budget ceilings can pause auto mode before overspending.

10. **Adaptive replanning** — After each slice completes, the roadmap is reassessed. If the work revealed new information that changes the plan, slices are reordered, added, or removed before continuing.

11. **Verification enforcement** — Configure shell commands (`npm run lint`, `npm run test`, etc.) that run automatically after task execution. Failures trigger auto-fix retries before advancing. Auto-discovered checks from `package.json` run in advisory mode — they log warnings but don't block on pre-existing errors. Configurable via `verification_commands`, `verification_auto_fix`, and `verification_max_retries` preferences.

12. **Milestone validation** — After all slices complete, a `validate-milestone` gate compares roadmap success criteria against actual results before sealing the milestone.

13. **Escape hatch** — Press Escape to pause. The conversation is preserved. Interact with the agent, inspect what happened, or just `/gsd auto` to resume from disk state.

### `/gsd` and `/gsd next` — Step Mode

By default, `/gsd` runs in **step mode**: the same state machine as auto mode, but it pauses between units with a wizard showing what completed and what's next. You advance one step at a time, review the output, and continue when ready.

- **No `.gsd/` directory** → Start a new project. Discussion flow captures your vision, constraints, and preferences.
- **Milestone exists, no roadmap** → Discuss or research the milestone.
- **Roadmap exists, slices pending** → Plan the next slice, execute one task, or switch to auto.
- **Mid-task** → Resume from where you left off.

`/gsd next` is an explicit alias for step mode. You can switch from step → auto mid-session via the wizard.

Step mode is the on-ramp. Auto mode is the highway.

---

## Getting Started

### Install

```bash
npm install -g gsd-pi
```

### Log in to a provider

First, choose your LLM provider:

```bash
gsd
/login
```

Select from 20+ providers — Anthropic, OpenAI, Google, OpenRouter, GitHub Copilot, and more. If you have a Claude Max or Copilot subscription, the OAuth flow handles everything. Otherwise, paste your API key when prompted.

GSD auto-selects a default model after login. To switch models later:

```bash
/model
```

### Use it

Open a terminal in your project and run:

```bash
gsd
```

GSD opens an interactive agent session. From there, you have two ways to work:

**`/gsd` — step mode.** Type `/gsd` and GSD executes one unit of work at a time, pausing between each with a wizard showing what completed and what's next. Same state machine as auto mode, but you stay in the loop. No project yet? It starts the discussion flow. Roadmap exists? It plans or executes the next step.

**`/gsd auto` — autonomous mode.** Type `/gsd auto` and walk away. GSD researches, plans, executes, verifies, commits, and advances through every slice until the milestone is complete. Fresh context window per task. No babysitting.

### Two terminals, one project

The real workflow: run auto mode in one terminal, steer from another.

**Terminal 1 — let it build**

```bash
gsd
/gsd auto
```

**Terminal 2 — steer while it works**

```bash
gsd
/gsd discuss    # talk through architecture decisions
/gsd status     # check progress
/gsd queue      # queue the next milestone
```

Both terminals coordinate through the same project-root GSD runtime on local disk. The SQLite database is authoritative, `.gsd/` markdown is refreshed from it, and your decisions in terminal 2 are picked up at the next phase boundary without stopping auto mode.

### Headless mode — CI and scripts

`gsd headless` runs any `/gsd` command without a TUI. Designed for CI pipelines, cron jobs, and scripted automation.

```bash
# Run auto mode in CI
gsd headless --timeout 600000

# Create and execute a milestone end-to-end
gsd headless new-milestone --context spec.md --auto

# One unit at a time (cron-friendly)
gsd headless next

# Instant JSON snapshot (no LLM, ~50ms)
gsd headless query

# Force a specific pipeline phase
gsd headless dispatch plan
```

Headless auto-responds to interactive prompts, detects completion, and exits with structured codes: `0` complete, `1` error/timeout, `2` blocked. Auto-restarts on crash with exponential backoff. Use `gsd headless query` for instant, machine-readable state inspection — returns phase, next dispatch preview, and parallel worker costs as a single JSON object without spawning an LLM session. Pair with [remote questions](./docs/user-docs/remote-questions.md) to route decisions to Slack or Discord when human input is needed.

**Multi-session orchestration** — headless mode supports DB-backed coordination across multiple GSD workers on the same machine. Worker registration, milestone leases, unit dispatch tracking, and command delivery live in `.gsd/gsd.db`, while `.gsd/parallel/` remains a local runtime area for per-milestone locks and isolation artifacts.

### First launch

On first run, GSD launches a branded setup wizard that walks you through LLM provider selection (OAuth or API key), then optional tool API keys (Brave Search, Context7, Jina, Slack, Discord). Every step is skippable — press Enter to skip any. If you have an existing Pi installation, your provider credentials (LLM and tool keys) are imported automatically. Run `gsd config` anytime to re-run the wizard.

### Commands

| Command                 | What it does                                                                  |
| ----------------------- | ----------------------------------------------------------------------------- |
| `/gsd`                  | Step mode — executes one unit at a time, pauses between each                  |
| `/gsd next`             | Explicit step mode (same as bare `/gsd`)                                      |
| `/gsd auto`             | Autonomous mode — researches, plans, executes, commits, repeats               |
| `/gsd new-project [--deep]` | Bootstrap a project with staged project-level discovery                  |
| `/gsd quick`            | Execute a quick task with GSD guarantees, skip planning overhead              |
| `/gsd stop`             | Stop auto mode gracefully                                                     |
| `/gsd steer`            | Hard-steer plan documents during execution                                    |
| `/gsd discuss`          | Discuss architecture and decisions (works alongside auto mode)                |
| `/gsd rethink`          | Conversational project reorganization                                         |
| `/gsd mcp`              | MCP server status and connectivity                                            |
| `/gsd status`           | Progress dashboard                                                            |
| `/gsd queue`            | Queue future milestones (safe during auto mode)                               |
| `/gsd prefs`            | Model selection, timeouts, budget ceiling                                     |
| `/gsd migrate`          | Migrate a v1 `.planning` directory to `.gsd` format                           |
| `/gsd help`             | Categorized command reference for all GSD subcommands                         |
| `/gsd mode`             | Switch workflow mode (solo/team) with coordinated defaults                    |
| `/gsd workflow`         | Unified workflow plugins — list, run `<name>`, install, info, validate        |
| `/gsd start <template>` | Launch a bundled or custom workflow template (bugfix, release, etc.)          |
| `/gsd forensics`        | Full-access GSD debugger for auto-mode failure investigation                  |
| `/gsd cleanup`          | Archive phase directories from completed milestones                           |
| `/gsd doctor`           | Runtime health checks — issues surface across widget, visualizer, and reports |
| `/gsd keys`             | API key manager — list, add, remove, test, rotate, doctor                     |
| `/gsd logs`             | Browse activity, debug, and metrics logs                                      |
| `/gsd export --html`    | Generate HTML report for current or completed milestone                       |
| `/worktree` (`/wt`)     | Git worktree lifecycle — create, switch, merge, remove                        |
| `/gsd worktree` (`/gsd wt`) | TUI worktree management — list, merge, clean, remove with safety checks   |
| `/voice`                | Toggle real-time speech-to-text (macOS, Linux)                                |
| `/exit`                 | Graceful shutdown — saves session state before exiting                        |
| `/kill`                 | Kill GSD process immediately                                                  |
| `/clear`                | Start a new session (alias for `/new`)                                        |
| `Ctrl+Alt+G`            | Toggle dashboard overlay                                                      |
| `Ctrl+Alt+V`            | Toggle voice transcription                                                    |
| `Ctrl+Alt+B`            | Show background shell processes                                               |
| `Alt+V`                 | Paste clipboard image (macOS)                                                 |
| `gsd config`            | Re-run the setup wizard (LLM provider + tool keys)                            |
| `gsd update`            | Update GSD to the latest version                                              |
| `gsd headless [cmd]`    | Run `/gsd` commands without TUI (CI, cron, scripts)                           |
| `gsd headless query`    | Instant JSON snapshot — state, next dispatch, costs (no LLM)                  |
| `gsd --continue` (`-c`) | Resume the most recent session for the current directory                      |
| `gsd --worktree` (`-w`) | Launch an isolated worktree session for the active milestone                  |
| `gsd sessions`          | Interactive session picker — browse and resume any saved session              |

---

## What GSD Manages For You

### Context Engineering

Every dispatch is carefully constructed. The LLM never wastes tool calls on orientation.

| Artifact           | Purpose                                                         |
| ------------------ | --------------------------------------------------------------- |
| `gsd.db`           | Authoritative runtime state for hierarchy and completion        |
| `PROJECT.md`       | Living doc — what the project is right now                      |
| `REQUIREMENTS.md`  | Project-level capability contract and out-of-scope list         |
| `DECISIONS.md`     | Append-only register of architectural decisions                 |
| `KNOWLEDGE.md`     | Cross-session rules, patterns, and lessons learned              |
| `RUNTIME.md`       | Runtime context — API endpoints, env vars, services (v2.39)     |
| `runtime/research-decision.json` | Deep-mode marker for project research vs skip       |
| `research/*.md`    | Optional deep-mode project research: stack, features, architecture, pitfalls |
| `STATE.md`         | Quick-glance dashboard rendered from the database                |
| `M001-ROADMAP.md`  | Milestone plan with slice checkboxes, risk levels, dependencies |
| `M001-CONTEXT.md`  | User decisions from the discuss phase                           |
| `M001-RESEARCH.md` | Codebase and ecosystem research                                 |
| `S01-PLAN.md`      | Slice task decomposition with must-haves                        |
| `T01-PLAN.md`      | Individual task plan with verification criteria                 |
| `T01-SUMMARY.md`   | What happened — YAML frontmatter + narrative                    |
| `S01-UAT.md`       | Human test script derived from slice outcomes                   |

### Git Strategy

Branch-per-slice with squash merge. Fully automated.

```
main:
  docs(M001/S04): workflow documentation and examples
  fix(M001/S03): bug fixes and doc corrections
  feat(M001/S02): API endpoints and middleware
  feat(M001/S01): data model and type system

gsd/M001/S01 (deleted after merge):
  feat(S01/T03): file writer with round-trip fidelity
  feat(S01/T02): markdown parser for plan files
  feat(S01/T01): core types and interfaces
```

One squash commit per milestone on main (or whichever branch you started from). The worktree is torn down after merge. Git bisect works. Individual milestones are revertable. Commit messages are generated from task summaries — no more generic "complete task" messages.

### Verification

Every task has must-haves — mechanically checkable outcomes:

- **Truths** — Observable behaviors ("User can sign up with email")
- **Artifacts** — Files that must exist with real implementation, not stubs
- **Key Links** — Imports and wiring between artifacts

The verification ladder: static checks → command execution → behavioral testing → human review (only when the agent genuinely can't verify itself).

### Dashboard

`Ctrl+Alt+G` or `/gsd status` opens a real-time overlay showing:

- Current milestone, slice, and task progress
- Auto mode elapsed time and phase
- Per-unit cost and token breakdown by phase, slice, and model
- Cost projections based on completed work
- Completed and in-progress units

### HTML Reports

After a milestone completes, GSD auto-generates a self-contained HTML report in `.gsd/reports/`. Each report includes project summary, progress tree, slice dependency graph (SVG DAG), cost/token metrics with bar charts, execution timeline, changelog, and knowledge base sections. No external dependencies — all CSS and JS are inlined, printable to PDF from any browser.

An auto-generated `index.html` shows all reports with progression metrics across milestones.

- **Automatic** — generated after milestone completion (configurable via `auto_report` preference)
- **Manual** — run `/gsd export --html` anytime

---

## Configuration

### Preferences

GSD preferences live in `~/.gsd/PREFERENCES.md` (global) or `.gsd/PREFERENCES.md` (project). Manage with `/gsd prefs`.

```yaml
---
version: 1
models:
  research: claude-sonnet-4-6
  planning:
    model: claude-opus-4-7
    fallbacks:
      - openrouter/z-ai/glm-5
      - openrouter/minimax/minimax-m2.5
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
skill_discovery: suggest
auto_supervisor:
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
budget_ceiling: 50.00
unique_milestone_ids: true
verification_commands:
  - npm run lint
  - npm run test
auto_report: true
---
```

**Key settings:**

| Setting                           | What it controls                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `models.*`                        | Per-phase model selection — string for a single model, or `{model, fallbacks}` for automatic failover |
| `planning_depth`                  | `light` / `deep` — opt into staged project discovery before milestone planning                         |
| `skill_discovery`                 | `auto` / `suggest` / `off` — how GSD finds and applies skills                                         |
| `auto_supervisor.*`               | Timeout thresholds for auto mode supervision                                                          |
| `budget_ceiling`                  | USD ceiling — auto mode pauses when reached                                                           |
| `uat_dispatch`                    | Enable automatic UAT runs after slice completion                                                      |
| `always_use_skills`               | Skills to always load when relevant                                                                   |
| `skill_rules`                     | Situational rules for skill routing                                                                   |
| `skill_staleness_days`            | Skills unused for N days get deprioritized (default: 60, 0 = disabled)                                |
| `unique_milestone_ids`            | Uses unique milestone names to avoid clashes when working in teams of people                          |
| `git.isolation`                   | `none` (default), `worktree`, or `branch` — enable worktree or branch isolation for milestone work. `worktree` requires a committed `HEAD`; zero-commit repos temporarily run as `none`    |
| `git.manage_gitignore`            | Set `false` to prevent GSD from modifying `.gitignore`                                                |
| `context_mode.enabled`            | Context Mode is default-on; set `false` to disable `gsd_exec`, exec history guidance, and resume snapshots |
| `context_mode.exec_timeout_ms`    | Timeout for sandboxed `gsd_exec` runs (default: 30000)                                                |
| `context_mode.exec_stdout_cap_bytes` | Persisted stdout cap for `gsd_exec` output (default: 1048576)                                      |
| `context_mode.exec_digest_chars`  | Trailing stdout characters returned to the agent context (default: 300)                              |
| `verification_commands`           | Array of shell commands to run after task execution (e.g., `["npm run lint", "npm run test"]`)        |
| `verification_auto_fix`           | Auto-retry on verification failures (default: true)                                                   |
| `verification_max_retries`        | Max retries for verification failures (default: 2)                                                    |
| `phases.require_slice_discussion` | Pause auto-mode before each slice for human discussion review                                         |
| `auto_report`                     | Auto-generate HTML reports after milestone completion (default: true)                                 |

### Agent Instructions

Place an `AGENTS.md` file in any directory to provide persistent behavioral guidance for that scope. Pi core loads `AGENTS.md` automatically (with `CLAUDE.md` as a fallback) at both user and project levels. Use these files for coding standards, architectural decisions, domain terminology, or workflow preferences.

> **Note:** The legacy `agent-instructions.md` format (`~/.gsd/agent-instructions.md` and `.gsd/agent-instructions.md`) is deprecated and no longer loaded. Migrate any existing instructions to `AGENTS.md` or `CLAUDE.md`.

### Debug Mode

Start GSD with `gsd --debug` to enable structured JSONL diagnostic logging. Debug logs capture dispatch decisions, state transitions, and timing data for troubleshooting auto-mode issues.

### Token Optimization

GSD includes a coordinated token optimization system that reduces usage by 40-60% on cost-sensitive workloads. Set a single preference to coordinate model tier selection, phase skipping, and context compression:

```yaml
token_profile: budget # or balanced (default), quality
```

| Profile    | Savings | What It Does                                                                     |
| ---------- | ------- | -------------------------------------------------------------------------------- |
| `budget`   | 40-60%  | Light/standard tier defaults, skip research/reassess, minimal context inlining   |
| `balanced` | 10-20%  | Standard tier for core work, light tier for simple work, standard context        |
| `quality`  | 0%      | Heavy tier for planning, standard tier for core work, full context               |

**Complexity-based routing** automatically classifies tasks as simple/standard/complex and routes to appropriate available models. Token profiles define provider-agnostic tier intentions, so simple docs tasks use a light-tier configured model and complex architectural work can use a heavy-tier configured model. The classification is heuristic (sub-millisecond, no LLM calls) and learns from outcomes via a persistent routing history.

**Budget pressure** graduates model downgrading as you approach your budget ceiling — 50%, 75%, and 90% thresholds progressively shift work to cheaper tiers.

See the full [Token Optimization Guide](./docs/user-docs/token-optimization.md) for details.

### Bundled Tools

GSD ships with 24 extensions, all loaded automatically:

| Extension              | What it provides                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GSD**                | Core workflow engine, auto mode, commands, dashboard                                                                                                                                                                                                                                 |
| **Browser Tools**      | Playwright-based browser with form intelligence, intent-ranked element finding, semantic actions, PDF export, session state persistence, network mocking, device emulation, structured extraction, visual diffing, region zoom, test code generation, and prompt injection detection |
| **Search the Web**     | Brave Search, Tavily, or Jina page extraction                                                                                                                                                                                                                                        |
| **Google Search**      | Gemini-powered web search with AI-synthesized answers                                                                                                                                                                                                                                |
| **Context7**           | Up-to-date library/framework documentation                                                                                                                                                                                                                                           |
| **Background Shell**   | Long-running process management with readiness detection                                                                                                                                                                                                                             |
| **Async Jobs**         | Background bash commands with job tracking and cancellation                                                                                                                                                                                                                          |
| **Subagent**           | Delegated tasks with isolated context windows                                                                                                                                                                                                                                        |
| **GitHub**             | Full-suite GitHub issues and PR management via `/gh` command                                                                                                                                                                                                                         |
| **Mac Tools**          | macOS native app automation via Accessibility APIs                                                                                                                                                                                                                                   |
| **MCP Client**         | Native MCP server integration via @modelcontextprotocol/sdk                                                                                                                                                                                                                          |
| **Voice**              | Real-time speech-to-text transcription (macOS, Linux — Ubuntu 22.04+)                                                                                                                                                                                                                |
| **Slash Commands**     | Custom command creation                                                                                                                                                                                                                                                              |
| **Ask User Questions** | Structured user input with single/multi-select                                                                                                                                                                                                                                       |
| **Secure Env Collect** | Masked secret collection without manual .env editing                                                                                                                                                                                                                                 |
| **Remote Questions**   | Route decisions to Slack/Discord when human input is needed in headless/CI mode                                                                                                                                                                                                      |
| **Universal Config**   | Discover and import MCP servers and rules from other AI coding tools                                                                                                                                                                                                                 |
| **AWS Auth**           | Automatic Bedrock credential refresh for AWS-hosted models                                                                                                                                                                                                                           |
| **Ollama**             | First-class local LLM support via Ollama                                                                                                                                                                                                                                             |
| **Claude Code CLI**    | External provider extension for Claude Code CLI                                                                                                                                                                                                                                      |
| **cmux**               | Claude multiplexer integration — desktop notifications, sidebar metadata, visual subagent splits                                                                                                                                                                                     |
| **GitHub Sync**        | Auto-sync milestones to GitHub Issues, PRs, and Milestones                                                                                                                                                                                                                           |
| **LSP**                | Language Server Protocol — diagnostics, definitions, references, hover, rename                                                                                                                                                                                                       |
| **TTSR**               | Tool-triggered system rules — conditional context injection based on tool usage                                                                                                                                                                                                      |

### Bundled Agents

Five specialized subagents for delegated work:

| Agent              | Role                                                         |
| ------------------ | ------------------------------------------------------------ |
| **Scout**          | Fast codebase recon — returns compressed context for handoff |
| **Researcher**     | Web research — finds and synthesizes current information     |
| **Worker**         | General-purpose execution in an isolated context window      |
| **JavaScript Pro** | JavaScript-specialized execution and debugging               |
| **TypeScript Pro** | TypeScript-specialized execution and debugging               |

---

## Working in teams

The best practice for working in teams is to ensure unique milestone names across all branches (by using `unique_milestone_ids`) and checking in the right `.gsd/` artifacts to share valuable context between teammates.

### Suggested .gitignore setup

```bash
# ── GSD: Runtime / Ephemeral (per-developer, per-session) ──────────────────
# Auto-mode dispatch tracker — prevents re-running completed units (includes archived per-milestone files)
.gsd/completed-units*.json
# State manifest — workflow state for recovery
.gsd/state-manifest.json
# Derived state projection — regenerated from the authoritative database
.gsd/STATE.md
# Per-developer token/cost accumulator
.gsd/metrics.json
# Raw JSONL session dumps — crash recovery forensics, auto-pruned
.gsd/activity/
# Unit execution records — dispatch phase, timeouts, and recovery tracking
.gsd/runtime/
# Git worktree working copies
.gsd/worktrees/
# Parallel runtime locks and per-milestone isolation artifacts
.gsd/parallel/
# SQLite database and WAL sidecars — authoritative runtime state, local only
.gsd/gsd.db*
# Daily-rotated event journal — structured event log for forensics
.gsd/journal/
# Doctor run history — diagnostic check results
.gsd/doctor-history.jsonl
# Workflow event log — structured event stream
.gsd/event-log.jsonl
# Generated HTML reports (regenerable via /gsd export --html)
.gsd/reports/
# Session-specific interrupted-work markers
.gsd/milestones/**/continue.md
.gsd/milestones/**/*-CONTINUE.md
```

### Unique Milestone Names

Create or amend your `.gsd/PREFERENCES.md` file within the repo to include `unique_milestone_ids: true` e.g.

```markdown
---
version: 1
unique_milestone_ids: true
---
```

With the above `.gitignore` set up, the `.gsd/PREFERENCES.md` file is checked into the repo ensuring all teammates use unique milestone names to avoid collisions.

Milestone names will now be generated with a 6 char random string appended e.g. instead of `M001` you'll get something like `M001-ush8s3`

### Migrating an existing git ignored `.gsd/` folder

1. Ensure you are not in the middle of any milestones (clean state)
2. Update the `.gsd/` related entries in your `.gitignore` to follow the `Suggested .gitignore setup` section under `Working in teams` (ensure you are no longer blanket ignoring the whole `.gsd/` directory)
3. Update your `.gsd/PREFERENCES.md` file within the repo as per section `Unique Milestone Names`
4. If you want to update all your existing milestones use this prompt in GSD: `I have turned on unique milestone ids, please update all old milestone ids to use this new format e.g. M001-abc123 where abc123 is a random 6 char lowercase alpha numeric string. Update all references in all .gsd file contents, file names and directory names. Validate your work once done to ensure referential integrity.`
5. Commit to git

---

## Architecture

GSD is a TypeScript application that embeds the Pi coding agent SDK.

```
gsd (CLI binary)
  └─ loader.ts          Sets PI_PACKAGE_DIR, GSD env vars, dynamic-imports cli.ts
      └─ cli.ts         Wires SDK managers, loads extensions, starts InteractiveMode
          ├─ headless.ts     Headless orchestrator (spawns RPC child, auto-responds, detects completion)
          ├─ onboarding.ts   First-run setup wizard (LLM provider + tool keys)
          ├─ wizard.ts       Env hydration from stored auth.json credentials
          ├─ app-paths.ts    ~/.gsd/agent/, ~/.gsd/sessions/, auth.json
          ├─ resource-loader.ts  Syncs bundled extensions + agents to ~/.gsd/agent/
          └─ src/resources/
              ├─ extensions/gsd/    Core GSD extension (auto, state, commands, ...)
              ├─ extensions/...     21 supporting extensions
              ├─ agents/            scout, researcher, worker, javascript-pro, typescript-pro
              └─ GSD-WORKFLOW.md    Manual bootstrap protocol
```

**Key design decisions:**

- **`pkg/` shim directory** — `PI_PACKAGE_DIR` points here (not project root) to avoid Pi's theme resolution collision with our `src/` directory. Contains only `piConfig` and theme assets.
- **Two-file loader pattern** — `loader.ts` sets all env vars with zero SDK imports, then dynamic-imports `cli.ts` which does static SDK imports. This ensures `PI_PACKAGE_DIR` is set before any SDK code evaluates.
- **Always-overwrite sync** — `npm update -g` takes effect immediately. Bundled extensions and agents are synced to `~/.gsd/agent/` on every launch, not just first run.
- **DB-authoritative state** — the project-root GSD database is the runtime source of truth. `.gsd/` markdown files are rendered projections for review, prompt context, and git history. No in-memory state survives across sessions.

---

## Requirements

- **Node.js** ≥ 22.0.0 (24 LTS recommended)
- **An LLM provider** — any of the 20+ supported providers (see [Use Any Model](#use-any-model))
- **Git** — initialized automatically if missing

Optional:

- Brave Search API key (web research)
- Tavily API key (web research — alternative to Brave)
- Google Gemini API key (web research via Gemini Search grounding)
- Context7 API key (library docs)
- Jina API key (page extraction)

---

## Use Any Model

GSD isn't locked to one provider. It runs on the [Pi SDK](https://github.com/badlogic/pi-mono), which supports **20+ model providers** out of the box. Use different models for different phases — Opus for planning, Sonnet for execution, a fast model for research.

### Built-in Providers

Anthropic, Anthropic (Vertex AI), OpenAI, Google (Gemini), OpenRouter, GitHub Copilot, Amazon Bedrock, Azure OpenAI, Google Vertex, Groq, Cerebras, Mistral, xAI, HuggingFace, Vercel AI Gateway, and more.

### OAuth / Max Plans

If you have a **Claude Max**, **Codex**, or **GitHub Copilot** subscription, you can use those directly — Pi handles the OAuth flow. No API key needed.

> **⚠️ Important:** Using OAuth tokens from subscription plans outside their native applications may violate the provider's Terms of Service. In particular:
>
> - **Google Gemini** — Using Gemini CLI or Antigravity OAuth tokens in third-party tools has resulted in **Google account suspensions**. This affects your entire Google account, not just the Gemini service. **Use a Gemini API key instead.**
> - **Claude Max** — Anthropic's ToS may not explicitly permit OAuth use outside Claude's own applications.
> - **GitHub Copilot** — Usage outside GitHub's own tools may be restricted by your subscription terms.
>
> GSD supports API key authentication for all providers as the safe alternative. **We strongly recommend using API keys over OAuth for Google Gemini.**

### OpenRouter

[OpenRouter](https://openrouter.ai) gives you access to hundreds of models through a single API key. Use it to run GSD with Llama, DeepSeek, Qwen, or anything else OpenRouter supports.

### Per-Phase Model Selection

In your preferences (`/gsd prefs`), assign different models to different phases:

```yaml
models:
  research: openrouter/deepseek/deepseek-r1
  planning:
    model: claude-opus-4-7
    fallbacks:
      - openrouter/z-ai/glm-5
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
```

Use expensive models where quality matters (planning, complex execution) and cheaper/faster models where speed matters (research, simple completions). Each phase accepts a simple model string or an object with `model` and `fallbacks` — if the primary model fails (provider outage, rate limit, credit exhaustion), GSD automatically tries the next fallback. GSD tracks cost per-model so you can see exactly where your budget goes.

---

## Ecosystem

| Project                                                         | Description                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [GSD2 Config Utility](https://github.com/jeremymcs/gsd2-config) | Standalone configuration tool for managing GSD preferences, providers, and API keys |

---

## Star History

<a href="https://star-history.com/#gsd-build/gsd-2&Date">
  <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=gsd-build/gsd-2&type=Date" />
</a>

---

## License

[MIT License](LICENSE)

---

<div align="center">

**The original GSD showed what was possible. This version delivers it.**

**`npm install -g gsd-pi && gsd`**

</div>
