# S03: Live freshness and recovery diagnostics

**Goal:** Keep the browser parity shipped in S01-S02 truthful during live work by replacing the production auto-data stub, pushing narrow freshness updates through the existing bridge/SSE/store spine, and surfacing actionable recovery diagnostics without widening `/api/boot` or falling back to manual refresh loops.
**Demo:** During a live browser session, dashboard/sidebar/roadmap/status surfaces stay current from targeted live state, resumable-session and validation/recovery surfaces invalidate at the right lifecycle boundaries, and the browser exposes actionable doctor/forensics/interrupted-run diagnostics with retry/resume/refresh controls.

R011 is the only Active requirement this slice supports, and the risk is mostly about *truthfulness*, not UI volume. I’m grouping the work in the order that removes the biggest correctness risks first. First, replace the production auto stub and establish explicit live-state invalidation contracts, because any later freshness work is meaningless if the browser is animating all-zero fake auto data. Second, wire the existing external store and visible panels to those narrow invalidation signals so the browser refreshes only the affected view-models instead of leaning on `/api/boot` polling. Third, add on-demand recovery diagnostics backed by the existing doctor/forensics truth so failures become actionable in-browser without bloating the stream or boot snapshot. S04 still owns the final assembled `gsd --web` proof, so S03’s verification is strong contract/integration coverage plus a narrower runtime check around live updates, reconnect, and recovery behavior.

## Must-Haves

- Production web boot and live refresh use authoritative auto-mode dashboard data instead of `fallbackAutoDashboardData()`
- The existing SSE/store spine gains targeted live freshness or invalidation payloads for auto/workspace/recovery state, with explicit cache invalidation rules instead of aggressive `/api/boot` polling
- Dashboard, sidebar, roadmap, status, resumable-session, and related browser surfaces update from targeted live state during lifecycle boundaries such as `agent_end`, retry/compaction transitions, session switch/fork/rename, reconnect, and visibility return
- Heavy doctor/forensics data stays off the live stream and off `/api/boot`, but becomes available through a named browser-native recovery diagnostics surface with actionable retry/resume/refresh guidance
- Contract, integration, and runtime verification prove freshness, invalidation, reconnect behavior, and recovery failure-path visibility for the shipped browser surfaces

## Proof Level

- This slice proves: contract + integration + operational
- Real runtime required: yes
- Human/UAT required: no

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts src/tests/web-recovery-diagnostics-contract.test.ts src/tests/web-bridge-contract.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-state-surfaces-contract.test.ts src/tests/web-session-parity-contract.test.ts src/tests/integration/web-mode-assembled.test.ts src/tests/integration/web-mode-runtime.test.ts`
- `npm run build:web-host`
- Failure-path diagnostic: the new coverage must explicitly assert no production auto fallback payload, lifecycle-triggered invalidation on `agent_end`, `auto_retry_*`, `auto_compaction_*`, and session mutations, reconnect/visibility return behavior, and browser-visible recovery diagnostics that carry phase/code/attempt/error data without leaking secrets or raw session transcripts

## Observability / Diagnostics

- Runtime signals: bridge SSE payloads plus new targeted live-state/invalidation events, store freshness timestamps or stale flags for auto/workspace/recovery state, and shaped recovery summaries carrying retry/compaction/bridge-failure metadata
- Inspection surfaces: `/api/session/events`, `/api/boot`, the on-demand recovery route added in this slice, shared command-surface recovery state, and browser `data-testid` markers on freshness-sensitive panels
- Failure visibility: last recovery phase and error, retry attempt/max-attempt context, validation and doctor issue counts/codes, route-level load or unavailable states, and stale-surface markers when a targeted refresh fails
- Redaction constraints: keep everything current-project scoped; do not stream raw session text, full doctor reports, or secrets; return scrubbed summaries and actionable labels only

## Integration Closure

- Upstream surfaces consumed: `src/web/bridge-service.ts`, `web/app/api/session/events/route.ts`, `web/lib/gsd-workspace-store.tsx`, `web/lib/command-surface-contract.ts`, `web/components/gsd/dashboard.tsx`, `web/components/gsd/sidebar.tsx`, `web/components/gsd/roadmap.tsx`, `web/components/gsd/status-bar.tsx`, `web/components/gsd/command-surface.tsx`, `src/resources/extensions/gsd/auto.ts`, `src/resources/extensions/gsd/workspace-index.ts`, `src/resources/extensions/gsd/session-forensics.ts`, `src/resources/extensions/gsd/doctor.ts`, and `packages/pi-coding-agent/src/core/agent-session.ts`
- New wiring introduced in this slice: a production-safe auto dashboard helper, targeted live-state invalidation over the existing bridge/SSE/store seam, and an on-demand browser recovery diagnostics contract rendered through the shared browser surface
- What remains before the milestone is truly usable end-to-end: S04 still needs the final assembled `gsd --web` proof for refresh/reopen/interrupted-run scenarios and live daily-use browser validation against the real entrypoint

## Tasks

- [x] **T01: Replace the production auto stub and define the live-state invalidation contract** `est:1h`
  - Why: The browser cannot stay fresh if its core auto payload is fake in production and if freshness depends on implicit cache drift rather than explicit lifecycle invalidation.
  - Files: `src/web/bridge-service.ts`, `src/web/auto-dashboard-service.ts`, `web/app/api/session/events/route.ts`, `src/tests/web-bridge-contract.test.ts`, `src/tests/web-live-state-contract.test.ts`
  - Do: Add a production-safe helper for authoritative auto dashboard data instead of relying on `fallbackAutoDashboardData()`, following the same narrow server-only or child-process pattern S02 used for build safety. Extend the existing bridge event fan-out with small browser-facing live-state or invalidation payloads for the cheap freshness signals S03 needs (`auto`, `workspace`, `recovery`, resumable-session freshness, cache bust reasons), and add explicit workspace-index invalidation on the lifecycle boundaries that make snapshot data stale. Keep `/api/boot` as a snapshot and keep doctor/forensics detail off both boot and SSE.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts src/tests/web-bridge-contract.test.ts`
  - Done when: production boot no longer depends on the all-zero auto fallback, the bridge emits explicit freshness cues at the right lifecycle boundaries, and contract tests prove `/api/boot` stays snapshot-shaped while live invalidation is inspectable
- [x] **T02: Wire targeted freshness into the browser store and live panels** `est:1h15m`
  - Why: S02’s named browser surfaces still drift because the store mostly patches `boot.bridge`; the user-facing panels need targeted refresh rules and stale-state handling, not more whole-boot refreshes.
  - Files: `web/lib/gsd-workspace-store.tsx`, `web/lib/command-surface-contract.ts`, `web/components/gsd/dashboard.tsx`, `web/components/gsd/sidebar.tsx`, `web/components/gsd/status-bar.tsx`, `src/tests/web-live-state-contract.test.ts`, `src/tests/web-state-surfaces-contract.test.ts`, `src/tests/integration/web-mode-runtime.test.ts`
  - Do: Extend the external store with live auto/workspace/recovery freshness state, explicit stale markers, and selective invalidation for on-demand surfaces such as session browser and git summary when they are open. On targeted SSE events, patch or reload only the affected view-models, update the dashboard/sidebar/roadmap/status inputs from the live state instead of stale boot-only values, and keep reconnect or visibility return limited to one soft boot refresh before targeted subscriptions take over again. Add stable test hooks for the live metrics, validation counts, current unit, and a visible recovery-summary entrypoint that T03 can deepen into a full diagnostics surface.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts src/tests/web-state-surfaces-contract.test.ts src/tests/integration/web-mode-runtime.test.ts`
  - Done when: live work updates the visible browser panels without manual refresh, reconnect and visibility return follow the explicit refresh rules, and the tests fail if the store regresses to broad boot-polling behavior for every event
- [x] **T03: Add on-demand recovery diagnostics and actionable browser recovery controls** `est:1h15m`
  - Why: The structured recovery and validation truth already exists in doctor/forensics/core events, but the browser still cannot inspect or act on it through a named native surface.
  - Files: `src/web/recovery-diagnostics-service.ts`, `web/app/api/recovery/route.ts`, `web/lib/command-surface-contract.ts`, `web/lib/gsd-workspace-store.tsx`, `web/components/gsd/command-surface.tsx`, `src/tests/web-recovery-diagnostics-contract.test.ts`, `src/tests/integration/web-mode-assembled.test.ts`, `src/tests/integration/web-mode-runtime.test.ts`
  - Do: Add a current-project, on-demand recovery diagnostics contract shaped from `workspace-index.ts`, `doctor.ts`, `session-forensics.ts`, and live bridge session state. Return browser-ready summaries with issue counts/codes, interrupted-run or crash-recovery state, retry/compaction metadata, last failure phase, and actionable labels instead of raw internal objects. Extend the shared command surface and store with a recovery section that loads this contract, reflects stale or load-failed states, and wires retry/resume/refresh or inspect actions onto the existing authoritative store commands rather than browser-only guesses.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-recovery-diagnostics-contract.test.ts src/tests/integration/web-mode-assembled.test.ts src/tests/integration/web-mode-runtime.test.ts && npm run build:web-host`
  - Done when: a browser user can inspect actionable recovery diagnostics without leaving the web shell, load and failure states stay inspectable after reconnect or refresh, and integration/runtime proof shows the retry/resume/refresh controls stay wired to authoritative actions

## Files Likely Touched

- `src/web/bridge-service.ts`
- `src/web/auto-dashboard-service.ts`
- `src/web/recovery-diagnostics-service.ts`
- `web/app/api/session/events/route.ts`
- `web/app/api/recovery/route.ts`
- `web/lib/command-surface-contract.ts`
- `web/lib/gsd-workspace-store.tsx`
- `web/components/gsd/dashboard.tsx`
- `web/components/gsd/sidebar.tsx`
- `web/components/gsd/roadmap.tsx`
- `web/components/gsd/status-bar.tsx`
- `web/components/gsd/command-surface.tsx`
- `src/tests/web-live-state-contract.test.ts`
- `src/tests/web-recovery-diagnostics-contract.test.ts`
- `src/tests/web-state-surfaces-contract.test.ts`
- `src/tests/web-bridge-contract.test.ts`
- `src/tests/integration/web-mode-assembled.test.ts`
- `src/tests/integration/web-mode-runtime.test.ts`
