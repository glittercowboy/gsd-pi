# Architecture Overview

GSD is a TypeScript application built on the [Pi SDK](https://github.com/badlogic/pi-mono). It embeds the Pi coding agent and extends it with the GSD workflow engine, auto mode state machine, and project management primitives.

## System Structure

```
gsd (CLI binary)
  └─ loader.ts          Sets PI_PACKAGE_DIR, GSD env vars, dynamic-imports cli.ts
      └─ cli.ts         Wires SDK managers, loads extensions, starts InteractiveMode
          ├─ onboarding.ts   First-run setup wizard (LLM provider + tool keys)
          ├─ wizard.ts       Env hydration from stored auth.json credentials
          ├─ app-paths.ts    ~/.gsd/agent/, ~/.gsd/sessions/, auth.json
          ├─ resource-loader.ts  Syncs bundled extensions + agents to ~/.gsd/agent/
          └─ src/resources/
              ├─ extensions/gsd/    Core GSD extension
              ├─ extensions/...     23 supporting extensions
              ├─ agents/            scout, researcher, worker
              ├─ AGENTS.md          Agent routing instructions
              └─ GSD-WORKFLOW.md    Manual bootstrap protocol

gsd headless              Headless mode — CI/cron orchestration via RPC child process
gsd --mode mcp            MCP server mode — exposes tools over stdin/stdout

vscode-extension/         VS Code extension — chat participant (@gsd), sidebar dashboard, RPC integration
```

## Key Design Decisions

### State Lives on Disk

`.gsd/` is the sole source of truth. Auto mode reads it, writes it, and advances based on what it finds. No in-memory state survives across sessions. This enables crash recovery, multi-terminal steering, and session resumption.

### Two-File Loader Pattern

`loader.ts` sets all environment variables with zero SDK imports, then dynamically imports `cli.ts` which does static SDK imports. This ensures `PI_PACKAGE_DIR` is set before any SDK code evaluates.

### `pkg/` Shim Directory

`PI_PACKAGE_DIR` points to `pkg/` (not project root) to avoid Pi's theme resolution colliding with GSD's `src/` directory. Contains only `piConfig` and theme assets.

### Always-Overwrite Sync

Bundled extensions and agents are synced to `~/.gsd/agent/` on every launch, not just first run. This means `npm update -g` takes effect immediately.

### Lazy Provider Loading

LLM provider SDKs (Anthropic, OpenAI, Google, etc.) are lazy-loaded on first use rather than imported at startup. This significantly reduces cold-start time — only the provider you actually connect to gets loaded.

### Fresh Session Per Unit

Every dispatch creates a new agent session. The LLM starts with a clean context window containing only the pre-inlined artifacts it needs. This prevents quality degradation from context accumulation.

## Bundled Extensions

| Extension | What It Provides |
|-----------|-----------------|
| **GSD** | Core workflow engine — auto mode, state machine, commands, dashboard |
| **Browser Tools** | Playwright-based browser automation — navigation, forms, screenshots, PDF export, device emulation, visual regression, structured data extraction, route mocking, accessibility tree inspection, and semantic actions |
| **Search the Web** | Brave Search, Tavily, or Jina page extraction |
| **Google Search** | Gemini-powered web search with AI-synthesized answers |
| **Context7** | Up-to-date library/framework documentation |
| **Background Shell** | Long-running process management with readiness detection |
| **Subagent** | Delegated tasks with isolated context windows |
| **Mac Tools** | macOS native app automation via Accessibility APIs |
| **MCP Client** | Native MCP server integration via @modelcontextprotocol/sdk |
| **Voice** | Real-time speech-to-text (macOS, Linux) |
| **Slash Commands** | Custom command creation |
| **LSP** | Language Server Protocol — diagnostics, definitions, references, hover, rename |
| **Ask User Questions** | Structured user input with single/multi-select |
| **Secure Env Collect** | Masked secret collection |
| **Async Jobs** | Background command execution with `async_bash`, `await_job`, `cancel_job` |
| **Remote Questions** | Discord, Slack, and Telegram integration for headless question routing |
| **TTSR** | Tool-triggered system rules — conditional context injection based on tool usage |
| **Universal Config** | Discovery of existing AI tool configurations (Claude Code, Cursor, Windsurf, etc.) |
| **AWS Auth** | AWS credential management and authentication |
| **Claude Code CLI** | Claude Code CLI integration |
| **cmux** | Context multiplexing for multi-session coordination |
| **GitHub Sync** | GitHub issue and PR synchronization |
| **Ollama** | Local Ollama model integration |
| **Shared** | Shared utilities across extensions |

## Bundled Agents

| Agent | Role |
|-------|------|
| **Scout** | Fast codebase recon — compressed context for handoff |
| **Researcher** | Web research — finds and synthesizes current information |
| **Worker** | General-purpose execution in an isolated context window |

## Native Engine

Performance-critical operations use a Rust N-API engine:

- **grep** — ripgrep-backed content search
- **glob** — gitignore-aware file discovery
- **ps** — cross-platform process tree management
- **highlight** — syntect-based syntax highlighting
- **ast** — structural code search via ast-grep
- **diff** — fuzzy text matching and unified diff generation
- **text** — ANSI-aware text measurement and wrapping
- **html** — HTML-to-Markdown conversion
- **image** — decode, encode, resize images
- **fd** — fuzzy file path discovery
- **clipboard** — native clipboard access
- **git** — libgit2-backed git read operations (v2.16+)
- **parser** — GSD file parsing and frontmatter extraction

## Dispatch Pipeline

The auto mode dispatch pipeline:

```
1.  Read disk state (STATE.md, roadmap, plans)
2.  Determine next unit type and ID
3.  Classify complexity → select model tier
4.  Apply budget pressure adjustments
5.  Check routing history for adaptive adjustments
6.  Dynamic model routing (if enabled) → select cheapest model for tier
7.  Resolve effective model (with fallbacks)
8.  Check pending captures → triage if needed
9.  Build dispatch prompt (applying inline level compression)
10. Create fresh agent session
11. Inject prompt and let LLM execute
12. On completion: snapshot metrics, verify artifacts, persist state
13. Loop to step 1
```

Phase skipping (from token profile) gates steps 2-3: if a phase is skipped, the corresponding unit type is never dispatched.

## Key Modules (v2.63)

| Module | Purpose |
|--------|---------|
| `auto.ts` | Auto-mode state machine and orchestration |
| `auto/session.ts` | `AutoSession` class — all mutable auto-mode state in one encapsulated instance |
| `auto-dispatch.ts` | Declarative dispatch table (phase → unit mapping) |
| `auto-idempotency.ts` | Completed-key checks, skip loop detection, key eviction |
| `auto-stuck-detection.ts` | Stuck loop recovery and unit retry escalation |
| `auto-start.ts` | Fresh-start bootstrap — git/state init, crash lock detection, worktree setup |
| `auto-post-unit.ts` | Post-unit processing — commit, doctor, state rebuild, hooks |
| `auto-verification.ts` | Post-unit verification gate (lint/test/typecheck with auto-fix retries) |
| `auto-prompts.ts` | Prompt builders with inline level compression |
| `auto-worktree.ts` | Worktree lifecycle (create, enter, merge, teardown) |
| `auto-recovery.ts` | Expected artifact resolution, completed-key persistence, self-healing |
| `auto-timeout-recovery.ts` | Timed-out unit recovery and continuation |
| `auto-timers.ts` | Unit supervision — soft/idle/hard timeouts, continue-here monitor |
| `complexity-classifier.ts` | Unit complexity classification (light/standard/heavy) |
| `model-router.ts` | Dynamic model routing with cost-aware selection |
| `model-cost-table.ts` | Built-in per-model cost data for cross-provider comparison |
| `routing-history.ts` | Adaptive learning from routing outcomes |
| `captures.ts` | Fire-and-forget thought capture and triage classification |
| `triage-resolution.ts` | Capture resolution (inject, defer, replan, quick-task) |
| `visualizer-overlay.ts` | Workflow visualizer TUI overlay |
| `visualizer-data.ts` | Data loading for visualizer tabs |
| `visualizer-views.ts` | Tab renderers (progress, deps, metrics, timeline, discussion status) |
| `metrics.ts` | Token and cost tracking ledger |
| `state.ts` | State derivation from disk |
| `session-lock.ts` | OS-level exclusive session locking (proper-lockfile) |
| `crash-recovery.ts` | Lock file management for crash detection and recovery |
| `preferences.ts` | Preference loading, merging, validation |
| `git-service.ts` | Git operations — commit, merge, worktree sync, completed-units cross-boundary sync |
| `unit-id.ts` | Centralized `parseUnitId()` — milestone/slice/task extraction from unit IDs |
| `error-utils.ts` | `getErrorMessage()` — unified error-to-string conversion |
| `roadmap-slices.ts` | Roadmap parser with prose fallback for LLM-generated variants |
| `memory-extractor.ts` | Extract reusable knowledge from session transcripts |
| `memory-store.ts` | Persistent memory store for cross-session knowledge |
| `queue-order.ts` | Milestone queue ordering |
| `context-masker.ts` | Context masking for model routing optimization |
| `phase-anchor.ts` | Phase anchoring for dispatch pipeline |
| `slice-parallel-orchestrator.ts` | Slice-level parallelism with dependency-aware dispatch |
| `slice-parallel-eligibility.ts` | Slice parallel eligibility checks |
| `slice-parallel-conflict.ts` | Slice parallel conflict detection |
| `preferences-models.ts` | Model preferences configuration |
| `preferences-validation.ts` | Preferences validation |
| `preferences-types.ts` | Preferences type definitions |
