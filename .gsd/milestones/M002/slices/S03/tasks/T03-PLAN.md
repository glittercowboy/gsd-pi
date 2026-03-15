---
estimated_steps: 5
estimated_files: 8
---

# T03: Add on-demand recovery diagnostics and actionable browser recovery controls

**Slice:** S03 — Live freshness and recovery diagnostics
**Milestone:** M002

## Description

The browser already receives enough live state to know that something failed, but it still cannot inspect the structured recovery truth that GSD already has in doctor, workspace validation, session forensics, and retry or compaction state. This task adds a narrow same-origin recovery diagnostics contract and renders it through the shared browser surface so interrupted runs, validation failures, bridge issues, and retry/compaction problems become actionable in-browser.

## Steps

1. Add a build-safe recovery diagnostics service that shapes current-project doctor, validation, forensics, and bridge retry/compaction state into one browser-ready view model.
2. Expose that view model through an on-demand same-origin recovery route, keeping the payload scoped, shaped, and independent from `/api/boot` and the live SSE stream.
3. Extend the shared command-surface/store contract with a recovery section that loads, refreshes, invalidates, and reports pending or failed diagnostics state explicitly.
4. Render actionable browser controls and diagnostics summaries for retry, resume, refresh, interrupted-run guidance, validation issues, and bridge/auth refresh failures without parsing transcript text.
5. Add contract and integration/runtime tests for happy path, unavailable or load-failed diagnostics, reconnect persistence, and action wiring.

## Must-Haves

- [ ] Recovery diagnostics are available through a dedicated on-demand browser contract
- [ ] The browser surface shows structured counts, codes, phases, and actionable labels rather than raw internal objects
- [ ] Retry/resume/refresh actions stay wired to authoritative store commands
- [ ] Diagnostics survive refresh or reconnect with explicit stale/load-failure states
- [ ] Tests prove both happy-path and failure-path browser visibility

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-recovery-diagnostics-contract.test.ts src/tests/integration/web-mode-assembled.test.ts src/tests/integration/web-mode-runtime.test.ts && npm run build:web-host`
- Tests should fail by naming the missing diagnostic field, broken action wiring, or stale-after-reconnect behavior if the browser recovery surface regresses

## Observability Impact

- Signals added/changed: shaped recovery summary payloads, explicit diagnostics pending or error state in the shared command surface, and browser-visible last-failure metadata
- How a future agent inspects this: query the recovery route, inspect command-surface recovery state, and use integration/runtime tests to verify retry or resume actions after a failure
- Failure state exposed: interrupted-run recovery, doctor/validation issues, bridge/auth refresh failures, and diagnostics route load errors become inspectable browser state instead of terminal-only clues

## Inputs

- `src/resources/extensions/gsd/session-forensics.ts` — authoritative interrupted-run and deep-diagnostic logic
- `src/resources/extensions/gsd/doctor.ts` — structured doctor issue and summary model
- `src/resources/extensions/gsd/workspace-index.ts` — validation issues and suggested next commands
- `web/lib/command-surface-contract.ts` and `web/lib/gsd-workspace-store.tsx` — inspectable browser-native surface and action wiring from S01-S02
- T01/T02 output — live recovery staleness or invalidation signals and panel-level recovery entrypoints

## Expected Output

- `src/web/recovery-diagnostics-service.ts` — build-safe browser-ready diagnostics shaping
- `web/app/api/recovery/route.ts` — on-demand current-project recovery diagnostics route
- `web/lib/command-surface-contract.ts` and `web/lib/gsd-workspace-store.tsx` — recovery section state and authoritative action wiring
- `web/components/gsd/command-surface.tsx` — browser-native diagnostics and recovery controls
- `src/tests/web-recovery-diagnostics-contract.test.ts` — recovery contract coverage
- `src/tests/integration/web-mode-assembled.test.ts` and `src/tests/integration/web-mode-runtime.test.ts` — proof that recovery diagnostics stay actionable during real browser lifecycle events
