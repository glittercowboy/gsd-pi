# Project

## What This Is

A pi coding agent extension (GSD — "Get Stuff Done") that provides structured planning, auto-mode execution, and project management for autonomous coding sessions. Includes proactive secret management and browser automation tools for UI verification.

## Core Value

Auto-mode runs from start to finish without blocking. The agent has hands, eyes, and judgment in the browser — fast, token-efficient, and reliable.

## Current State

The GSD extension is fully functional with:
- Milestone/slice/task planning hierarchy
- Auto-mode state machine with fresh-session-per-unit dispatch
- Guided `/gsd` wizard flow
- `secure_env_collect` tool with masked TUI input, multi-destination write support, guidance display, and summary screen
- Proactive secret management: planning prompts forecast secrets, manifests persist them, auto-mode collects them before first dispatch
- Browser-tools extension with 47 registered tools covering navigation, interaction, inspection, verification, tracing, debugging, form intelligence (browser_analyze_form, browser_fill_form), and intent-ranked retrieval and semantic actions (browser_find_best, browser_act)
- Browser-tools `core.js` with shared utilities for action timeline, page registry, state diffing, assertions, fingerprinting

## Architecture / Key Patterns

- **Extension model**: pi extensions register tools, commands, hooks via `ExtensionAPI`
- **State machine**: `auto.ts` drives `dispatchNextUnit()` which reads disk state and dispatches fresh sessions
- **Secrets gate**: `startAuto()` checks `getManifestStatus()` before first dispatch
- **Disk-driven state**: `.gsd/` files are the source of truth, `STATE.md` is derived cache
- **File parsing**: `files.ts` has markdown parsers for all GSD file types
- **Browser-tools**: Modular structure — slim `index.ts` orchestrator, 8 focused infrastructure modules (state.ts, utils.ts, evaluate-helpers.ts, lifecycle.ts, capture.ts, settle.ts, refs.ts), 11 categorized tool files under `tools/` (including forms.ts, intent.ts), shared infrastructure in `core.js` (~1000 lines). Browser-side utilities injected once via `addInitScript` under `window.__pi` namespace. Uses Playwright for browser control. Accessibility-first state representation, deterministic versioned refs, adaptive DOM settling, compact post-action summaries. Form tools use Playwright locator APIs for type-aware filling with structured result reporting. Intent tools use deterministic 4-dimension heuristic scoring for element retrieval and one-call semantic actions.
- **Prompt templates**: `prompts/` directory with mustache-like `{{var}}` substitution
- **TUI components**: `@gsd/pi-tui` provides `Editor`, `Text`, key handling, themes
- **Branch-per-slice**: git branches isolate slice work, squash-merged to main on completion

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: Proactive Secret Management — Front-loaded API key collection into planning so auto-mode runs uninterrupted (10 requirements validated)
- [x] M002: Browser Tools Performance & Intelligence — Module decomposition, action pipeline optimization, sharp-based screenshots, form intelligence, intent-ranked retrieval, semantic actions, 108-test suite (12 requirements validated)
