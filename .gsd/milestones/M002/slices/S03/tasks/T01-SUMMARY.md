---
id: T01
parent: S03
milestone: M002
provides:
  - Production-safe authoritative auto dashboard loading for web boot plus explicit live freshness invalidation events
key_files:
  - src/web/auto-dashboard-service.ts
  - src/web/bridge-service.ts
  - src/tests/web-live-state-contract.test.ts
  - src/tests/web-bridge-contract.test.ts
key_decisions:
  - D035 — use explicit `live_state_invalidation` bridge/SSE events keyed by reason/source/domains, and only invalidate the workspace-index cache on `agent_end`
patterns_established:
  - Keep `/api/boot` snapshot-shaped; drive freshness with inspectable invalidation events instead of boot polling
observability_surfaces:
  - /api/boot, /api/session/events, and the new web live-state contract tests
duration: 1h20m
verification_result: passed
completed_at: 2026-03-15T14:26:40Z
# Set blocker_discovered: true only if execution revealed the remaining slice plan
# is fundamentally invalid (wrong API, missing capability, architectural mismatch).
# Do NOT set true for ordinary bugs, minor deviations, or fixable issues.
blocker_discovered: false
---

# T01: Replace the production auto stub and define the live-state invalidation contract

**Shipped a production-safe auto dashboard loader for web boot and added explicit bridge/SSE live-state invalidation events with narrow workspace-cache bust rules.**

## What Happened

Added `src/web/auto-dashboard-service.ts` as a build-safe child-process helper that imports the authoritative GSD auto module and reads `getAutoDashboardData()` without pulling broad extension runtime into the Next host bundle. Wired `collectBootPayload()` onto that helper so the default production path no longer falls back to the all-zero stub; the fallback now only exists as an explicit test-only path.

Extended `src/web/bridge-service.ts` with a typed `live_state_invalidation` contract carrying `reason`, `source`, `domains`, and `workspaceIndexCacheInvalidated`. The bridge now emits explicit invalidations for `agent_end`, `auto_retry_*`, `auto_compaction_*`, `new_session`, `switch_session`, `fork`, and session-name mutations, while only invalidating the cached workspace index on the lifecycle boundary that actually makes that snapshot stale: `agent_end`. Inactive session-file rename now emits the same freshness signal through the bridge singleton.

Kept `/api/boot` snapshot-shaped and left heavy doctor/forensics work off both boot and SSE. The SSE route itself stayed transport-compatible and now also sends `X-Accel-Buffering: no` for better streaming behavior.

Added contract coverage proving the default boot path uses authoritative auto truth and that `/api/session/events` exposes inspectable invalidation reasons/domains without turning `/api/boot` into a live diagnostics payload.

## Verification

Passed task-level verification:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts src/tests/web-bridge-contract.test.ts`

Passed slice-level checks already green from this task:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts src/tests/web-recovery-diagnostics-contract.test.ts src/tests/web-bridge-contract.test.ts`
- `npm run build:web-host`

Partial slice-level verification on later work:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-state-surfaces-contract.test.ts src/tests/web-session-parity-contract.test.ts src/tests/integration/web-mode-assembled.test.ts src/tests/integration/web-mode-runtime.test.ts`
  - 28/29 passed
  - `src/tests/integration/web-mode-runtime.test.ts` still failed on the real `gsd --web` runtime launch/boot check during the broader slice suite

Observability verified directly through the passing contract tests by reading `/api/boot` and `/api/session/events` and asserting the new auto source and `live_state_invalidation` payloads.

## Diagnostics

Inspect later via:
- `GET /api/boot` — confirms boot still returns the snapshot-shaped payload and now carries authoritative auto data
- `GET /api/session/events` — streams `live_state_invalidation` events with `reason`, `source`, `domains`, and `workspaceIndexCacheInvalidated`
- `src/tests/web-bridge-contract.test.ts` — pins authoritative auto sourcing and boot-shape non-regression
- `src/tests/web-live-state-contract.test.ts` — pins invalidation triggers and workspace-cache boundaries

## Deviations

None.

## Known Issues

- The broader slice verification suite still has one failing runtime integration test: `src/tests/integration/web-mode-runtime.test.ts` reported live host boot/bridge readiness instability during `gsd --web` launch. The T01 contract suite and packaged web-host build both passed, so this remains slice-level follow-up work rather than a T01 blocker.

## Files Created/Modified

- `src/web/auto-dashboard-service.ts` — new production-safe child-process helper for authoritative auto dashboard data, with an explicit test-only fallback path
- `src/web/bridge-service.ts` — boot now uses the authoritative auto helper; bridge emits typed `live_state_invalidation` events and only busts workspace cache on `agent_end`
- `web/app/api/session/events/route.ts` — SSE transport unchanged semantically, but marked non-bufferable for better live streaming
- `src/tests/web-live-state-contract.test.ts` — new contract coverage for invalidation reasons/domains and workspace-cache boundaries
- `src/tests/web-bridge-contract.test.ts` — boot contract now proves the default path uses authoritative auto truth and stays snapshot-shaped
- `.gsd/DECISIONS.md` — recorded D035 for the freshness invalidation transport choice
- `.gsd/milestones/M002/slices/S03/S03-PLAN.md` — marked T01 complete
- `.gsd/STATE.md` — advanced slice state to T02 as the next action
