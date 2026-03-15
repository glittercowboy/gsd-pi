---
id: T03
parent: S03
milestone: M002
provides:
  - On-demand current-project recovery diagnostics route with typed browser action ids and redacted doctor/forensics/bridge/auth summaries
  - Shared command-surface recovery state that loads, invalidates, survives soft refresh, and renders actionable retry/resume/auth/workspace controls
key_files:
  - src/web/recovery-diagnostics-service.ts
  - web/app/api/recovery/route.ts
  - web/lib/command-surface-contract.ts
  - web/lib/gsd-workspace-store.tsx
  - web/components/gsd/command-surface.tsx
  - src/tests/web-recovery-diagnostics-contract.test.ts
  - src/tests/integration/web-mode-assembled.test.ts
  - src/tests/integration/web-mode-runtime.test.ts
key_decisions:
  - D037 — shape recovery diagnostics behind `/api/recovery` and return typed browser action ids instead of leaking raw doctor/forensics objects or transcript-derived heuristics
patterns_established:
  - Keep heavy doctor/forensics work off `/api/boot` and SSE; load it on demand through a narrow current-project route and preserve stale/error state in the browser store
observability_surfaces:
  - /api/recovery
  - commandSurface.recovery in web/lib/command-surface-contract.ts
  - data-testid markers under command-surface-recovery*
  - browser-visible recovery route load/error/stale state in the shared command surface
duration: 1h55m
verification_result: passed
completed_at: 2026-03-15T15:56:28Z
blocker_discovered: false
---

# T03: Add on-demand recovery diagnostics and actionable browser recovery controls

**Added a dedicated `/api/recovery` diagnostics contract, wired it into the shared browser command surface, and shipped actionable retry/resume/auth/workspace recovery controls with redacted doctor/forensics state.**

## What Happened

I added `src/web/recovery-diagnostics-service.ts` as the build-safe server shim for recovery truth. It combines current-project bridge state, onboarding auth-refresh state, workspace validation state, and child-process doctor/session-forensics data into one redacted browser-ready payload. The service intentionally keeps raw doctor reports, crash-recovery prompts, and transcript-like session text out of the response; it only returns structured counts, codes, phases, labels, and action descriptors.

I exposed that payload through `web/app/api/recovery/route.ts` as a dedicated same-origin on-demand contract with `Cache-Control: no-store`, independent from `/api/boot` and the live SSE stream.

On the browser side, I extended `web/lib/command-surface-contract.ts` with typed recovery diagnostics models plus explicit `CommandSurfaceRecoveryState` load/stale/error tracking. In `web/lib/gsd-workspace-store.tsx`, I added `loadRecoveryDiagnostics()`, normalized `/api/recovery` responses, preserved recovery diagnostics across soft boot refreshes, and marked recovery state stale on `live_state_invalidation` events instead of dropping the last good payload. When the recovery panel is open, recovery invalidations now trigger an authoritative reload through the shared store path.

In `web/components/gsd/command-surface.tsx`, I added a new `recovery` section to the shared settings surface. It renders:
- recovery load/error/stale state
- structured bridge failure metadata
- retry/compaction/auth-refresh state
- doctor and validation counts/codes
- interrupted-run diagnostics
- typed browser actions for refresh, retry controls, resume controls, and auth controls
- suggested `/gsd ...` commands as labels only

I also repointed the existing dashboard/sidebar recovery entrypoints to open this dedicated recovery section instead of dropping the user onto the retry tab.

For verification coverage, I added `src/tests/web-recovery-diagnostics-contract.test.ts` for the new route contract and redaction behavior, updated `src/tests/web-state-surfaces-contract.test.ts` to pin the new store/component route wiring and recovery test ids, added an assembled recovery-route integration check in `src/tests/integration/web-mode-assembled.test.ts`, relaxed the brittle milestone-id assumption in `src/tests/integration/web-mode-runtime.test.ts`, and extended that runtime test to open the browser recovery panel and assert it renders a visible recovery load state.

## Verification

Passed:

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-recovery-diagnostics-contract.test.ts src/tests/web-state-surfaces-contract.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts src/tests/web-recovery-diagnostics-contract.test.ts src/tests/web-bridge-contract.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-state-surfaces-contract.test.ts src/tests/web-session-parity-contract.test.ts src/tests/integration/web-mode-assembled.test.ts src/tests/integration/web-mode-runtime.test.ts`
- `npm run build:web-host`

Notable explicit runtime/browser proof that passed:
- the assembled integration suite now asserts `/api/recovery` exposes actionable browser diagnostics without leaking recovery/auth secrets
- the runtime web-mode test launches the real host, opens the dashboard recovery entrypoint in a real browser, and verifies the `command-surface-recovery` panel renders an inspectable recovery state marker

## Diagnostics

Use these surfaces later to inspect T03 output:

- `GET /api/recovery` — authoritative current-project recovery diagnostics payload
- `commandSurface.recovery` in `web/lib/command-surface-contract.ts` / `web/lib/gsd-workspace-store.tsx` — browser-native load/pending/stale/error state
- `data-testid="command-surface-recovery"`
- `data-testid="command-surface-recovery-state"`
- `data-testid="command-surface-recovery-error"`
- `data-testid="command-surface-recovery-last-failure"`
- `data-testid="command-surface-recovery-action-refresh_diagnostics"`
- `data-testid="command-surface-recovery-action-open_retry_controls"`
- `data-testid="command-surface-recovery-action-open_resume_controls"`
- `data-testid="command-surface-recovery-action-open_auth_controls"`

## Deviations

- I removed a dead `.tsx` import from `src/tests/web-live-state-contract.test.ts` because Node’s strip-types harness cannot load `.tsx` directly and the import was unused. This was necessary to let the intended live-state contract assertions run.
- I updated the runtime integration test’s hardcoded `M001` expectation to accept the repository’s current live milestone rather than a frozen milestone id; the previous assertion was unrelated to recovery diagnostics and was causing false negatives.

## Known Issues

- The Next/Turbopack web-host build still logs the existing optional `@gsd/native` warning from `native-git-bridge.ts` during `/api/git` bundling, but the staged production host build completes successfully and the recovery work did not introduce a new build failure.

## Files Created/Modified

- `src/web/recovery-diagnostics-service.ts` — build-safe recovery diagnostics shaping from bridge/onboarding/workspace plus child-process doctor/forensics data
- `web/app/api/recovery/route.ts` — dedicated on-demand recovery diagnostics route
- `src/web/bridge-service.ts` — added a narrow onboarding-state helper so recovery diagnostics can reuse current-project bridge test/runtime truth without widening `/api/boot`
- `web/lib/command-surface-contract.ts` — typed recovery diagnostics payload, action ids, and explicit recovery load/stale/error state
- `web/lib/gsd-workspace-store.tsx` — recovery loader, stale/error persistence, invalidation wiring, and exported recovery action
- `web/components/gsd/command-surface.tsx` — dedicated recovery section with actionable browser controls and diagnostics rendering
- `web/components/gsd/dashboard.tsx` — recovery entrypoint now opens the dedicated recovery section
- `web/components/gsd/sidebar.tsx` — recovery entrypoint now opens the dedicated recovery section
- `src/tests/web-recovery-diagnostics-contract.test.ts` — recovery route contract and redaction coverage
- `src/tests/web-state-surfaces-contract.test.ts` — source-level assertions for the recovery surface/store contract
- `src/tests/web-live-state-contract.test.ts` — removed an unused `.tsx` import so the live-state contract suite runs under the Node strip-types harness
- `src/tests/integration/web-mode-assembled.test.ts` — assembled recovery-route integration proof
- `src/tests/integration/web-mode-runtime.test.ts` — runtime browser proof for opening the recovery panel plus milestone-id expectation hardening
- `.gsd/DECISIONS.md` — appended D037 for the recovery diagnostics transport/action contract
