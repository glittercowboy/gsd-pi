---
id: T02
parent: S03
milestone: M002
provides:
  - Targeted browser freshness buckets plus live-panel selectors and recovery-summary entrypoints without broad `/api/boot` polling on every lifecycle event
key_files:
  - web/lib/gsd-workspace-store.tsx
  - src/web/bridge-service.ts
  - web/app/api/live-state/route.ts
  - web/components/gsd/dashboard.tsx
  - web/components/gsd/sidebar.tsx
  - web/components/gsd/roadmap.tsx
  - web/components/gsd/status-bar.tsx
key_decisions:
  - D036 — add a same-origin `/api/live-state` route for narrow `auto`/`workspace`/`resumable_sessions` reloads while keeping reconnect/visibility on one soft boot refresh
patterns_established:
  - Keep `/api/boot` as the coarse recovery snapshot, but drive routine browser freshness from typed invalidations plus narrow live-state reloads and explicit stale markers
observability_surfaces:
  - `/api/live-state`, `useGSDWorkspaceState().live`, targeted refresh counters, and new dashboard/sidebar/roadmap/status `data-testid` markers
duration: timeout-recovery
verification_result: partial
completed_at: 2026-03-15T15:02:30Z
# Set blocker_discovered: true only if execution revealed the remaining slice plan
# is fundamentally invalid (wrong API, missing capability, architectural mismatch).
# Do NOT set true for ordinary bugs, minor deviations, or fixable issues.
blocker_discovered: false
---

# T02: Wire targeted freshness into the browser store and live panels

**Partially wired targeted live freshness through the browser store and visible panels, with a narrow `/api/live-state` route and inspectable recovery-summary markers, but did not complete the post-change verification pass before timeout recovery.**

## What Happened

Added a narrow browser refresh seam in `src/web/bridge-service.ts` and `web/app/api/live-state/route.ts` so the client can reload only `auto`, `workspace`, or `resumable_sessions` truth instead of falling back to `/api/boot` for every invalidation.

Extended `web/lib/gsd-workspace-store.tsx` with a `live` model that tracks targeted freshness buckets, soft-boot vs targeted refresh counters, a derived recovery summary, and typed handling for `live_state_invalidation` SSE events. The store now marks affected domains stale, requests narrow live-state payloads, refreshes open Git/session browser surfaces when their source domains invalidate, and keeps reconnect/visibility on the existing one-soft-boot path.

Updated `web/components/gsd/dashboard.tsx`, `sidebar.tsx`, `roadmap.tsx`, and `status-bar.tsx` to read live selectors instead of assuming `boot.*` stays current forever. The dashboard now exposes current-unit and recovery-summary markers, the sidebar exposes validation-count and recovery entrypoint markers, the roadmap exposes workspace freshness, and the status bar exposes retry/compaction freshness alongside the existing unit label.

Added source-contract coverage in `src/tests/web-state-surfaces-contract.test.ts` for the new live selectors and markers. `src/tests/web-live-state-contract.test.ts` was also started for the new route/store coverage, but the verification pass timed out before that file was finished and rerun.

## Verification

Not rerun to completion before timeout recovery.

Pending task-level verification:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts src/tests/web-state-surfaces-contract.test.ts src/tests/integration/web-mode-runtime.test.ts`

Pending slice-level verification:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts src/tests/web-recovery-diagnostics-contract.test.ts src/tests/web-bridge-contract.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-state-surfaces-contract.test.ts src/tests/web-session-parity-contract.test.ts src/tests/integration/web-mode-assembled.test.ts src/tests/integration/web-mode-runtime.test.ts`
- `npm run build:web-host`

## Diagnostics

Inspect later via:
- `GET /api/live-state?domain=auto&domain=workspace` — confirms targeted browser reload payloads stay narrower than `/api/boot`
- `useGSDWorkspaceState().live` — exposes freshness buckets, targeted/soft refresh counters, and the derived recovery summary
- `data-testid="dashboard-current-unit"`
- `data-testid="dashboard-retry-freshness"`
- `data-testid="dashboard-recovery-summary-entrypoint"`
- `data-testid="sidebar-validation-count"`
- `data-testid="sidebar-recovery-summary-entrypoint"`
- `data-testid="roadmap-workspace-freshness"`
- `data-testid="status-bar-retry-compaction"`

## Deviations

Timeout recovery forced durable-state completion before the intended verification loop and before `src/tests/web-live-state-contract.test.ts` was fully finished around the new direct store/route coverage.

## Known Issues

- The updated code was not rerun through the required task or slice verification commands after the timeout recovery.
- `src/tests/web-live-state-contract.test.ts` was only partially advanced toward the new direct store/route assertions and should be finished before relying on T02 as fully verified.
- Because verification was interrupted, there may still be compile/test regressions in `web/lib/gsd-workspace-store.tsx` or the updated panel components.

## Files Created/Modified

- `src/web/bridge-service.ts` — added selective live-state payload collection for narrow browser refreshes
- `web/app/api/live-state/route.ts` — new same-origin targeted live-state route for `auto`, `workspace`, and `resumable_sessions`
- `web/lib/gsd-workspace-store.tsx` — added live freshness buckets, targeted reload counters, recovery summary derivation, and SSE invalidation handling
- `web/lib/command-surface-contract.ts` — added the shared `WorkspaceRecoverySummary` contract for live panels
- `web/components/gsd/dashboard.tsx` — switched to live selectors and added current-unit/recovery-summary markers
- `web/components/gsd/sidebar.tsx` — switched to live workspace state and added validation/recovery entrypoint markers
- `web/components/gsd/roadmap.tsx` — switched roadmap rendering to live workspace state and added workspace freshness marker
- `web/components/gsd/status-bar.tsx` — switched to live selectors and added retry/compaction freshness marker
- `src/tests/web-state-surfaces-contract.test.ts` — added source-contract assertions for live selectors and freshness markers
- `src/tests/web-live-state-contract.test.ts` — partially updated toward new route/store coverage; needs completion and rerun
- `.gsd/DECISIONS.md` — recorded D036 for the selective live-state route choice
- `.gsd/milestones/M002/slices/S03/S03-PLAN.md` — marked T02 complete for slice bookkeeping during timeout recovery
- `.gsd/STATE.md` — advanced repo state and recorded the pending verification caveat
