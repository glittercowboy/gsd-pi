---
estimated_steps: 5
estimated_files: 5
---

# T01: Replace the production auto stub and define the live-state invalidation contract

**Slice:** S03 — Live freshness and recovery diagnostics
**Milestone:** M002

## Description

The browser’s current freshness story is compromised before any client code runs: production boot still falls back to an all-zero auto payload, and the server has no explicit invalidation contract for workspace-derived state. This task fixes the truth source first by replacing the auto stub with a production-safe helper and by emitting narrow live-state invalidation signals at the lifecycle boundaries that actually make browser state stale.

## Steps

1. Add a production-safe auto dashboard helper that can read authoritative GSD auto state without importing broad extension runtime directly into the Next host bundle.
2. Wire `collectBootPayload()` to that helper so production boot and later targeted refreshes stop using `fallbackAutoDashboardData()` except as an explicit test-only override path.
3. Extend the bridge service with typed live-state or invalidation events for the cheap freshness domains S03 needs: auto, workspace, recovery, and resumable-session freshness.
4. Invalidate cached workspace-index state on the lifecycle boundaries that genuinely stale it, while keeping heavy doctor/forensics work off `/api/boot` and off the SSE stream.
5. Add contract coverage proving real auto truth, explicit invalidation triggers, and boot-shape non-regression.

## Must-Haves

- [ ] Production boot no longer relies on the all-zero auto fallback path
- [ ] Live-state invalidation events are explicit and inspectable
- [ ] Workspace-index invalidation happens on real lifecycle boundaries, not generic polling
- [ ] `/api/boot` remains a startup snapshot rather than absorbing heavy live diagnostics
- [ ] Contract tests pin the auto-data source and invalidation behavior

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts src/tests/web-bridge-contract.test.ts`
- Tests should fail by naming the missing auto provider, invalidation trigger, or snapshot-shape regression if the contract drifts

## Observability Impact

- Signals added/changed: authoritative auto payload sourcing and explicit bridge live-state or invalidation events for freshness-sensitive surfaces
- How a future agent inspects this: inspect `/api/boot`, read `/api/session/events`, and use the new contract tests to confirm which lifecycle events invalidate workspace or recovery state
- Failure state exposed: missing auto truth or stale-cache regressions become route/event-contract failures instead of silent stale UI drift

## Inputs

- `src/web/bridge-service.ts` — current boot assembly, workspace cache, and bridge event fan-out
- `src/resources/extensions/gsd/auto.ts` — authoritative auto dashboard state that the browser must mirror
- `src/resources/extensions/gsd/workspace-index.ts` — authoritative workspace/validation summary and suggested next commands
- `web/app/api/session/events/route.ts` — existing SSE seam to extend without replacing
- S02 summary — named browser surfaces now exist and need narrow freshness instead of wider boot payloads

## Expected Output

- `src/web/auto-dashboard-service.ts` — production-safe authoritative auto dashboard helper
- `src/web/bridge-service.ts` — boot wiring plus explicit live-state or invalidation event emission and cache invalidation rules
- `web/app/api/session/events/route.ts` — SSE route that streams the widened event contract
- `src/tests/web-live-state-contract.test.ts` — contract coverage for invalidation signals and freshness boundaries
- `src/tests/web-bridge-contract.test.ts` — proof that boot remains snapshot-shaped while using real auto truth
