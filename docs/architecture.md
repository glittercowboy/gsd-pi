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
              ├─ extensions/...     12 supporting extensions
              ├─ agents/            scout, researcher, worker
              ├─ AGENTS.md          Agent routing instructions
              └─ GSD-WORKFLOW.md    Manual bootstrap protocol
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

### Fresh Session Per Unit

Every dispatch creates a new agent session. The LLM starts with a clean context window containing only the pre-inlined artifacts it needs. This prevents quality degradation from context accumulation.

## Bundled Extensions

| Extension | What It Provides |
|-----------|-----------------|
| **GSD** | Core workflow engine — auto mode, state machine, commands, dashboard |
| **Browser Tools** | Playwright-based browser with form intelligence and semantic actions |
| **Search the Web** | Brave Search, Tavily, or Jina page extraction |
| **Google Search** | Gemini-powered web search with AI-synthesized answers |
| **Context7** | Up-to-date library/framework documentation |
| **Background Shell** | Long-running process management with readiness detection |
| **Subagent** | Delegated tasks with isolated context windows |
| **Mac Tools** | macOS native app automation via Accessibility APIs |
| **MCPorter** | Lazy on-demand MCP server integration |
| **Voice** | Real-time speech-to-text (macOS, Linux) |
| **Slash Commands** | Custom command creation |
| **LSP** | Language Server Protocol — diagnostics, definitions, references, hover, rename |
| **Ask User Questions** | Structured user input with single/multi-select |
| **Secure Env Collect** | Masked secret collection |

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

## Key Modules (v2.19)

| Module | Purpose |
|--------|---------|
| `auto.ts` | Auto-mode state machine and orchestration |
| `auto-dispatch.ts` | Declarative dispatch table (phase → unit mapping) |
| `auto-prompts.ts` | Prompt builders with inline level compression |
| `auto-worktree.ts` | Worktree lifecycle (create, enter, merge, teardown) |
| `complexity-classifier.ts` | Unit complexity classification (light/standard/heavy) |
| `model-router.ts` | Dynamic model routing with cost-aware selection |
| `model-cost-table.ts` | Built-in per-model cost data for cross-provider comparison |
| `routing-history.ts` | Adaptive learning from routing outcomes |
| `captures.ts` | Fire-and-forget thought capture and triage classification |
| `triage-resolution.ts` | Capture resolution (inject, defer, replan, quick-task) |
| `visualizer-overlay.ts` | Workflow visualizer TUI overlay |
| `visualizer-data.ts` | Data loading for visualizer tabs |
| `visualizer-views.ts` | Tab renderers (progress, deps, metrics, timeline) |
| `metrics.ts` | Token and cost tracking ledger |
| `state.ts` | State derivation from disk |
| `preferences.ts` | Preference loading, merging, validation |
| `queue-order.ts` | Milestone queue ordering |
