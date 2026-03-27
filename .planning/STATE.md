---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: milestone
current_phase: 5
current_plan: Not started
status: planning
stopped_at: Completed 04-01-PLAN.md
last_updated: "2026-03-27T13:06:52.226Z"
last_activity: 2026-03-27
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 6
  completed_plans: 6
---

# Project State

**Current Phase:** 5
**Current Plan:** Not started
**Status:** Ready to plan
**Last activity:** 2026-03-27

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-26)

**Core value:** Developers can see and track their project progress in real-time without leaving their terminal workflow.
**Current focus:** Phase 04 — renderer-entry-command-integration

## Progress Bar

```
Phase 2: [ ] Foundation
Phase 3: [ ] Core Renderer
Phase 4: [ ] Renderer Entry + Command Integration
Phase 5: [ ] Navigation
```

Phases complete: 0/4 | Plans complete: 0/?

## Accumulated Context

- v1.0 shipped capability-aware model routing (Phase 1, 5 plans, all complete)
- Extension system uses dispatcher pattern with handler chain in `commands/handlers/core.ts`
- Commands register via `pi.registerCommand()` in bootstrap
- Existing `/gsd cmux` command has tmux integration patterns to reference
- All new code lives in `src/resources/extensions/gsd/watch/` module
- Only two existing files need modification: `commands/handlers/core.ts` and `commands/catalog.ts`
- Zero new npm dependencies — chokidar, @gsd/pi-tui, and chalk already present
- Architecture: orchestrator (in-process) spawns renderer subprocess into tmux pane; renderer reads .planning/ directly, no IPC

## Decisions

| Decision | Rationale | Phase |
|----------|-----------|-------|
| Two-process architecture | Renderer runs in separate PTY; cannot share TUI context with main process | Roadmap |
| Renderer reads filesystem directly | No IPC needed; .planning/ is the source of truth; keeps renderer self-contained | Roadmap |
| DISP-04 (viewport scrolling) in Phase 4 | Scrolling is a renderer entry point concern — needs process wiring before scroll state can be managed | Roadmap |
| Flat icons, no color for badges | Explicit user preference; simplifies rendering and avoids terminal color compatibility issues | Roadmap |

- [Phase 02]: Use function-based ignored predicate in chokidar v5 (glob array patterns unreliable in v5)
- [Phase 02-foundation]: isMainModule guard uses process.argv[1] endsWith check so tests can import exported helpers without running subprocess main block
- [Phase 02-foundation]: Exported resetQuitState() for test beforeEach isolation instead of module re-loading
- [Phase 02-02]: Dynamic import used for watch orchestrator in core.ts to avoid loading at startup (matches cmux pattern)
- [Phase 02-02]: Watch lock stored in .gsd/watch.lock; isWatchPidAlive uses EPERM-aware process.kill(pid,0) pattern from crash-recovery.ts
- [Phase 03]: readMilestoneLabel extracts text after em/en-dash from ROADMAP.md heading for concise label
- [Phase 03]: derivePhaseStatus ignores badges — status derived from plan files only
- [Phase 03]: scanPlans filters /^\d{2}-\d{2}-PLAN\.md$/ strictly — plan files only in plans array
- [Phase 03-core-renderer]: Badge string formatted as ' ' + 7 circles — leading space provides visual separation; MIN_NAME_WITH_BADGES=4 drops badges entirely when space is tight
- [Phase 03-core-renderer]: renderPlaceholder retained in renderer-entry.ts for backward compatibility — renderTree replaces all 3 call sites in main block
- [Phase 04]: parseArrowKey runs first in stdin handler before parseQuitSequence to prevent \x1b prefix collision
- [Phase 04]: scrollable = total > height (full height) before reducing contentHeight prevents blank status bar row when tree fits
- [Phase 04]: lastRenderedLines module-level cache stores previous render output for arrow key and resize handlers

## Critical Pitfalls (from research)

- SIGHUP must be handled in renderer-entry.ts — tmux kill-pane sends SIGHUP, not SIGTERM
- PTY width=0 at pane creation time — guard with minimum 40 columns, defer first render until resize event
- Event flood during orchestrator execution — single coalescing debounce (300ms), awaitWriteFinish: { stabilityThreshold: 200 }
- ANSI overflow in narrow panes — use truncateToWidth/visibleWidth from @gsd/pi-tui everywhere

## Todos

- [ ] Run `discuss-phase` before `plan-phase 2` to generate CONTEXT.md

## Blockers

None.

## Last Session

**Stopped at:** Completed 04-01-PLAN.md
**Timestamp:** 2026-03-27T04:40:43Z
