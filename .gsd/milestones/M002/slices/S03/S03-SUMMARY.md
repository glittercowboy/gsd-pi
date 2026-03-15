---
id: S03
parent: M002
milestone: M002
provides:
  - Authoritative auto dashboard boot data plus explicit live-state invalidation events for browser freshness
  - Targeted browser live-state reloads and stale markers for dashboard, sidebar, roadmap, status, and resumable-session surfaces
  - On-demand current-project recovery diagnostics with actionable browser recovery controls and redacted doctor/forensics summaries
requires:
  - slice: S01
    provides: Browser-visible slash-command lifecycle and authoritative browser command outcomes that live-state and recovery surfaces can observe
  - slice: S02
    provides: Serializable current-project browser parity surfaces for sessions, settings, auth, git, and shell state
affects:
  - S04
key_files:
  - src/web/auto-dashboard-service.ts
  - src/web/bridge-service.ts
  - src/web/recovery-diagnostics-service.ts
  - web/app/api/live-state/route.ts
  - web/app/api/recovery/route.ts
  - web/lib/gsd-workspace-store.tsx
  - web/components/gsd/command-surface.tsx
  - src/web-mode.ts
  - src/tests/integration/web-mode-runtime.test.ts
key_decisions:
  - D035 — emit explicit `live_state_invalidation` events keyed by reason/source/domains and only invalidate the workspace-index cache on `agent_end`
  - D036 — use a same-origin `/api/live-state` route for narrow `auto`/`workspace`/`resumable_sessions` refreshes while keeping reconnect/visibility on one soft boot refresh
  - D037 — shape recovery diagnostics behind `/api/recovery` with typed browser action ids instead of exposing raw doctor/forensics objects or transcript-derived heuristics
patterns_established:
  - Keep `/api/boot` snapshot-shaped; routine browser freshness comes from typed invalidation events plus narrow live-state reloads
  - Keep heavy doctor/forensics work off `/api/boot` and SSE; load it on demand through a current-project recovery route and preserve stale/error state in the store
observability_surfaces:
  - /api/boot
  - /api/session/events
  - /api/live-state
  - /api/recovery
  - useGSDWorkspaceState().live
  - commandSurface.recovery
  - data-testid markers on dashboard/sidebar/roadmap/status/recovery surfaces
drill_down_paths:
  - .gsd/milestones/M002/slices/S03/tasks/T01-SUMMARY.md
  - .gsd/milestones/M002/slices/S03/tasks/T02-SUMMARY.md
  - .gsd/milestones/M002/slices/S03/tasks/T03-SUMMARY.md
duration: timeout-recovery
verification_result: passed
completed_at: 2026-03-15T16:31:33Z
---

# S03: Live freshness and recovery diagnostics

**Shipped truthful live browser freshness for auto/workspace/recovery state, replaced the production auto fallback, and added a dedicated browser recovery diagnostics surface with authoritative retry/resume/auth controls.**

## What Happened

S03 closed the truthfulness gap that remained after S01-S02.

First, T01 replaced the production all-zero auto dashboard fallback with a build-safe authoritative loader in `src/web/auto-dashboard-service.ts`, then extended the bridge/SSE seam with typed `live_state_invalidation` events. Those events now carry explicit `reason`, `source`, `domains`, and `workspaceIndexCacheInvalidated` metadata so the browser can react to `agent_end`, `auto_retry_*`, `auto_compaction_*`, session switch/fork/new-session, and rename lifecycle boundaries without guessing from transcript text or hammering `/api/boot`.

Second, T02 wired those freshness cues into the browser store. `web/lib/gsd-workspace-store.tsx` now tracks targeted live buckets, stale state, refresh counters, and derived recovery summary state. A narrow same-origin `/api/live-state` route reloads only the affected `auto`, `workspace`, or `resumable_sessions` domains, while reconnect and visibility-return still use one soft boot refresh instead of regressing into broad boot polling. The dashboard, sidebar, roadmap, and status bar now read live selectors and expose stable freshness markers for current unit, validation counts, retry/compaction state, workspace freshness, and recovery entrypoints.

Third, T03 added an on-demand `/api/recovery` contract backed by build-safe recovery shaping in `src/web/recovery-diagnostics-service.ts`. The response combines bridge state, onboarding auth-refresh state, workspace validation state, and redacted doctor/session-forensics truth into a browser-ready payload with counts, codes, phases, interrupted-run signals, and typed browser actions. The shared command surface gained a dedicated recovery section that preserves load/stale/error state, reloads authoritatively when recovery is invalidated, and routes refresh/retry/resume/auth actions back through the existing store commands instead of browser-local heuristics.

During final slice verification, the real packaged `gsd --web` runtime proof exposed a cold-start readiness problem in the runtime test harness rather than in the shipped slice behavior. I hardened that proof by moving the runtime test’s boot and first-SSE verification into the real browser context and by giving `launchWebMode()` a longer bounded cold-boot readiness window. That kept the operational proof aligned with the actual shipped browser path and eliminated flaky false negatives under standalone-host load.

I also directly confirmed the slice’s observability surfaces against a live local `gsd --web` run: `/api/boot` reported `bridge.phase=ready`, `/api/live-state` returned the targeted live payload keys, and `/api/recovery` returned a structured ready-state payload with browser actions.

## Verification

Passed:

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts src/tests/web-recovery-diagnostics-contract.test.ts src/tests/web-bridge-contract.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-state-surfaces-contract.test.ts src/tests/web-session-parity-contract.test.ts src/tests/integration/web-mode-assembled.test.ts src/tests/integration/web-mode-runtime.test.ts`
- `npm run build:web-host`

Operational/observability confirmation also passed against a real local `gsd --web` launch:

- `/api/boot` returned `bridge.phase=ready` with a live workspace phase
- `/api/live-state?domain=auto&domain=workspace` returned the targeted live payload (`auto`, `bridge`, `workspace`)
- `/api/recovery` returned `status=ready` plus browser recovery actions

## Requirements Advanced

- R011 — Browser parity now stays truthful during live work: dashboard/sidebar/roadmap/status/recovery surfaces refresh from targeted live state, and current-project recovery/validation/interrupted-run diagnostics are visible and actionable in-browser.

## Requirements Validated

- none — R011 still needs S04’s assembled refresh/reopen/interrupted-run proof before it can move from active to validated.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- Final slice verification exposed a flaky cold-start assumption in the runtime launch proof. I tightened the runtime test to verify `/api/boot` and the first SSE payload through the actual browser session and increased the bounded launch readiness window in `src/web-mode.ts` so the packaged standalone host can finish cold boot under suite load.
- T02 had been left in a timeout-recovery state with incomplete verification. That verification was completed during slice closeout and passed as part of the full slice suite.

## Known Limitations

- The packaged web-host build still logs the existing optional `@gsd/native` warning from `native-git-bridge.ts` during `/api/git` bundling, although the build completes successfully.
- Node’s strip-types harness still emits `MODULE_TYPELESS_PACKAGE_JSON` warnings for some `web/` imports during the test suite. These warnings did not block the slice but still add noise to verification output.

## Follow-ups

- S04 should reuse the hardened browser-context runtime proof when exercising refresh/reopen/interrupted-run scenarios through the real `gsd --web` entrypoint.
- S04 should re-verify the new live invalidation and recovery surfaces under assembled lifecycle stress instead of only route-level or contract-level checks.

## Files Created/Modified

- `src/web/auto-dashboard-service.ts` — added the production-safe authoritative auto dashboard loader used by web boot
- `src/web/bridge-service.ts` — emits typed live-state invalidations and serves selective live-state payloads plus narrow onboarding/recovery truth
- `src/web/recovery-diagnostics-service.ts` — shapes current-project recovery diagnostics into a redacted browser-ready payload
- `web/app/api/live-state/route.ts` — added targeted live-state reloads for `auto`, `workspace`, and `resumable_sessions`
- `web/app/api/recovery/route.ts` — added the on-demand recovery diagnostics route
- `web/lib/gsd-workspace-store.tsx` — tracks live freshness buckets, stale markers, targeted refreshes, and recovery diagnostics state
- `web/components/gsd/dashboard.tsx` — now renders live current-unit and recovery-summary freshness state
- `web/components/gsd/sidebar.tsx` — now renders live validation/recovery entrypoint state
- `web/components/gsd/roadmap.tsx` — now renders live workspace freshness state
- `web/components/gsd/status-bar.tsx` — now renders live retry/compaction freshness state
- `web/components/gsd/command-surface.tsx` — added the dedicated browser recovery diagnostics section and actions
- `src/web-mode.ts` — hardened cold-boot readiness checks for the packaged `gsd --web` runtime proof
- `src/tests/web-live-state-contract.test.ts` — covers live invalidation reasons/domains and targeted refresh boundaries
- `src/tests/web-recovery-diagnostics-contract.test.ts` — covers recovery route shape, redaction, and browser actions
- `src/tests/integration/web-mode-runtime.test.ts` — now proves launch, boot, SSE, and recovery-surface readiness through the real browser path

## Forward Intelligence

### What the next slice should know
- The browser store and runtime proof are now intentionally split: `/api/boot` is the coarse recovery snapshot, but freshness truth lives on `/api/session/events`, `/api/live-state`, and `/api/recovery`.
- The real standalone host can cold-boot more slowly than the older runtime test expected; browser-context verification is more trustworthy than Node-side polling here.

### What's fragile
- `src/tests/integration/web-mode-runtime.test.ts` — the packaged runtime proof is sensitive to cold-start timing, so future changes that thicken `/api/boot` or startup work can reintroduce false negatives quickly.
- `web/lib/gsd-workspace-store.tsx` live invalidation logic — it now has more stateful refresh branching, so S04 should watch for regressions that silently fall back to broad boot refreshes.

### Authoritative diagnostics
- `/api/session/events` — this is the most trustworthy place to inspect invalidation reasons/domains and confirm whether the browser should refresh `auto`, `workspace`, `recovery`, or resumable-session state.
- `/api/recovery` — this is the authoritative browser diagnostics payload for doctor/validation/interrupted-run/auth-refresh visibility without transcript leakage.
- `src/tests/web-live-state-contract.test.ts` and `src/tests/web-recovery-diagnostics-contract.test.ts` — these pin the slice’s core contracts and are the fastest way to catch regressions.

### What assumptions changed
- “Node-side boot polling is good enough for runtime proof” — under standalone-host load, that assumption was false; the durable proof needed to validate boot and first SSE attachment from the real browser session.
- “T02’s timeout-recovery summary only reflects unfinished work” — the slice closeout completed that missing verification, so S03 is now fully green even though the T02 task summary records the earlier interruption.
