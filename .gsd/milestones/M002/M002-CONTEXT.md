# M002: Browser Tools Performance & Intelligence — Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

## Project Description

Performance optimization and capability expansion of pi's browser-tools extension. The extension provides 43 browser interaction tools to the coding agent via Playwright. This milestone decomposes the monolithic 5000-line index.ts into modules, optimizes the per-action performance pipeline, replaces canvas-based screenshot resizing with sharp, and adds form intelligence, intent-ranked element retrieval, and semantic action tools.

## Why This Milestone

The browser-tools extension is the agent's primary interface for UI verification and testing. Every action pays a latency tax from redundant page.evaluate calls, unnecessary body text capture, and canvas-based screenshot resizing. The monolithic file structure makes changes risky. And the most common browser tasks (forms, finding the right button, executing obvious micro-actions) still require multiple tool calls where one would suffice.

## User-Visible Outcome

### When this milestone is complete, the user can:

- See faster browser interactions (fewer evaluate round-trips, faster settle, faster screenshots)
- See smaller token payloads (no screenshots on navigate by default, no body text on scroll/hover)
- Use `browser_analyze_form` to inspect any form's fields, types, values, and validation in one call
- Use `browser_fill_form` to fill a form by label/name/placeholder mapping in one call
- Use `browser_find_best` with an intent to get scored element candidates
- Use `browser_act` to execute common micro-tasks ("submit form", "close modal") in one call

### Entry point / environment

- Entry point: pi CLI with browser-tools extension loaded
- Environment: local dev, any website/web app
- Live dependencies involved: Playwright browser instance, sharp npm package

## Completion Class

- Contract complete means: Tests pass for shared utilities, heuristic scoring, form analysis logic, and screenshot resizing
- Integration complete means: All 43 existing tools work with the new module structure; new tools work against real web pages
- Operational complete means: Build succeeds; the extension loads and registers all tools

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- All existing browser tools work identically after module decomposition (build + behavioral spot-check)
- New tools (browser_analyze_form, browser_fill_form, browser_find_best, browser_act) register and execute against a real page
- Screenshot resizing uses sharp (no canvas evaluate calls)
- Navigate returns no screenshot by default
- Test suite passes

## Risks and Unknowns

- Module split regression risk — 43 tools sharing module-level state (browser, context, pageRegistry, logs) must all still work after decomposition
- sharp native dependency — binary compatibility across platforms (macOS, Linux)
- addInitScript timing — injected scripts must be available before any evaluate that references them, including on new pages and after navigation
- Form label association complexity — real-world forms use diverse patterns (for/id, wrapping labels, aria-label, aria-labelledby, placeholder, custom components)

## Existing Codebase / Prior Art

- `src/resources/extensions/browser-tools/index.ts` — The monolithic file being decomposed (~5000 lines, 43 tools, all shared infrastructure)
- `src/resources/extensions/browser-tools/core.js` — Existing shared utilities (~1000 lines: action timeline, page registry, state diffing, assertions, fingerprinting, snapshot modes, batch execution)
- `src/resources/extensions/browser-tools/BROWSER-TOOLS-V2-PROPOSAL.md` — Design proposal; many items already implemented (assertions, batch, diff, timeline, pages, frames, traces). M002 covers remaining items: form intelligence, intent ranking, semantic actions, plus performance work not in V2 proposal.
- `src/resources/extensions/browser-tools/package.json` — Extension package metadata

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- R015 — Module decomposition: split index.ts into focused modules
- R016 — Shared evaluate utilities: inject once, reference everywhere
- R017 — Consolidated state capture: fewer evaluate calls per action
- R018 — Conditional body text: skip for low-signal actions
- R019 — Faster settle: short-circuit on zero mutations
- R020 — Sharp-based screenshot resizing
- R021 — Opt-in navigate screenshots
- R022 — browser_analyze_form
- R023 — browser_fill_form
- R024 — browser_find_best
- R025 — browser_act
- R026 — Test coverage

## Scope

### In Scope

- Decomposing index.ts into modules (core infrastructure, tool groups, browser-side utilities)
- Injecting shared browser-side utilities once via addInitScript or setup evaluate
- Consolidating captureCompactPageState + postActionSummary into fewer evaluate calls
- Conditional body text capture based on action signal level
- Short-circuiting settle on zero-mutation actions
- Replacing constrainScreenshot canvas approach with sharp
- Making screenshots opt-in on browser_navigate (default off)
- New tool: browser_analyze_form
- New tool: browser_fill_form
- New tool: browser_find_best (deterministic heuristic scoring)
- New tool: browser_act (semantic micro-actions)
- Test coverage for new and refactored code

### Out of Scope / Non-Goals

- Browser reuse across sessions (deferred, skip completely)
- LLM-powered intent resolution (deterministic heuristics only)
- Changes to core.js beyond what's needed for the module split
- Changes to existing tool APIs (all 43 existing tools maintain their current interface)

## Technical Constraints

- Must maintain backward compatibility for all 43 existing tools
- sharp is acceptable as a native dependency
- Browser-side injected utilities must work on any web page (no assumptions about page content)
- addInitScript runs before page scripts; must not conflict with page globals
- All injected browser-side code must use a namespaced global (e.g. window.__pi) to avoid collisions

## Integration Points

- Playwright — browser automation library, provides page.evaluate, page.addInitScript, locator API
- sharp — Node image processing library, replaces canvas-based constrainScreenshot
- pi extension API — registerTool, pi.on("session_shutdown"), ExtensionAPI interface
- core.js — existing shared utilities that index.ts imports

## Open Questions

- Best approach for shared evaluate utilities: page.addInitScript vs one-time page.evaluate at ensureBrowser time — addInitScript survives navigation but runs before page scripts; setup evaluate is simpler but must be re-run on navigation. Likely addInitScript is correct.
- How to handle the module-level mutable state (browser, context, pageRegistry, logs, refs) during decomposition — probably a shared state module that all tool modules import.
