---
estimated_steps: 5
estimated_files: 8
---

# T02: Wire targeted freshness into the browser store and live panels

**Slice:** S03 — Live freshness and recovery diagnostics
**Milestone:** M002

## Description

S02 created real browser surfaces, but most of them still depend on boot-era `workspace`, `auto`, and `resumableSessions` data that only move after a full boot refresh. This task teaches the external store and the shipped panels to react to the new live-state invalidation contract so the browser stays current during live work, reconnect, and visibility return without regressing to broad `/api/boot` polling.

## Steps

1. Extend the workspace store with live freshness buckets, stale flags, and selective invalidation helpers for auto, workspace, recovery, resumable sessions, and any open on-demand surfaces that need a reload.
2. Handle the new bridge invalidation events by patching or reloading only the affected data, while preserving the existing reconnect and visibility-return soft-boot behavior as the coarse recovery path.
3. Update the dashboard, sidebar, roadmap, and status inputs to read the live state instead of assuming `boot.*` stays current for the full session, including a visible recovery-summary entrypoint for deeper diagnostics.
4. Surface stable test markers for current unit, validation count, retry or compaction freshness, and recovery-summary visibility so later slices can inspect staleness directly.
5. Add contract and runtime coverage that fails if manual refresh is required or if the store falls back to whole-boot refreshes for every lifecycle event.

## Must-Haves

- [ ] Store state can represent targeted freshness and stale-state transitions per surface
- [ ] Lifecycle boundaries refresh only the affected browser data instead of hammering `/api/boot`
- [ ] Dashboard/sidebar/roadmap/status read current live state during active work
- [ ] Reconnect and visibility return still have one explicit soft-refresh path
- [ ] Tests prove the live panels stay current without manual refresh loops

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts src/tests/web-state-surfaces-contract.test.ts src/tests/integration/web-mode-runtime.test.ts`
- The tests must name the stale panel, missing invalidation, or reconnect regression when the freshness rules drift

## Observability Impact

- Signals added/changed: store freshness timestamps or stale flags, targeted reload counters, and panel-level test markers for live current-unit, validation, and recovery-summary state
- How a future agent inspects this: inspect `useGSDWorkspaceState()` output in tests, check the panel `data-testid` markers, and use runtime/integration tests to see which boundaries trigger a selective refresh
- Failure state exposed: stale browser panels become inspectable store or UI-state failures instead of “looks old after a while” bugs

## Inputs

- `web/lib/gsd-workspace-store.tsx` — existing external-store, reconnect, and visibility-refresh behavior
- `web/lib/command-surface-contract.ts` — inspectable surface state that should stay aligned with live freshness
- `web/components/gsd/dashboard.tsx`, `sidebar.tsx`, `roadmap.tsx`, `status-bar.tsx` — current boot-driven browser panels
- `src/tests/web-continuity-contract.test.ts` — existing reconnect and visibility-return expectations to preserve
- T01 output — authoritative auto data and explicit invalidation events from the bridge/SSE seam

## Expected Output

- `web/lib/gsd-workspace-store.tsx` — targeted freshness handling, stale markers, and selective reload rules
- `web/lib/command-surface-contract.ts` — any extra live freshness or recovery-summary state needed by the UI
- `web/components/gsd/dashboard.tsx` — live auto and recovery summary rendering with inspectable markers
- `web/components/gsd/sidebar.tsx` and `web/components/gsd/status-bar.tsx` — live validation, scope, and recovery/failure visibility
- `src/tests/web-live-state-contract.test.ts` — focused freshness and invalidation assertions
- `src/tests/web-state-surfaces-contract.test.ts` and `src/tests/integration/web-mode-runtime.test.ts` — proof that the shipped browser panels stay current under live runtime boundaries
