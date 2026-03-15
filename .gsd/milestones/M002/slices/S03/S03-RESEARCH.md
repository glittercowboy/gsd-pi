# M002/S03 — Research

**Date:** 2026-03-15

## Summary

S03 supports **R011** by making the browser parity shipped in S01-S02 stay truthful during live work and by surfacing recovery state the browser can actually act on. The current web stack already has the right *shape* for this: a long-lived project bridge, one SSE stream, and a `useSyncExternalStore` store that can absorb targeted updates. The problem is that only the terminal path is truly live today. `web/lib/gsd-workspace-store.tsx` patches `boot.bridge` from `bridge_status` events, but dashboard/sidebar/roadmap/status mostly render `boot.workspace`, `boot.auto`, and `boot.resumableSessions`, which only move when `/api/boot` is refreshed.

The biggest surprise is worse than ordinary staleness: the current production boot path does **not** load authoritative auto-mode data at all. In `src/web/bridge-service.ts`, `collectBootPayload()` uses `deps.getAutoDashboardData ?? fallbackAutoDashboardData`, and the fallback returns an all-zero inactive payload. Tests hide this because they inject fake auto data through `configureBridgeServiceForTests(...)`. So S03 is not just “add freshness”; it must first replace a production stub with real current-project auto truth.

The recovery side has the opposite problem: the truth already exists, but the browser does not expose it. `src/resources/extensions/gsd/session-forensics.ts` and `src/resources/extensions/gsd/doctor.ts` already provide structured recovery and validation diagnostics, while `packages/pi-coding-agent/src/core/agent-session.ts` emits rich retry and compaction events with attempts and error details. None of that has a browser-native route or surface yet. The right S03 move is therefore: keep `/api/boot` as a startup snapshot, add narrow live view-model updates over the existing SSE/store spine, and add dedicated on-demand diagnostics routes for heavier doctor/forensics data.

## Recommendation

1. **Replace the auto stub before doing anything else.**
   Add a production-safe server helper for `getAutoDashboardData()` instead of relying on `fallbackAutoDashboardData()`. Follow the S02 build-safe pattern: prefer a narrow child-process or server-only helper over importing broad extension runtime directly into the Next host.

2. **Keep `/api/boot` as a startup snapshot. Do not solve freshness with polling.**
   The existing 30s workspace-index cache in `src/web/bridge-service.ts` has no production invalidation path. Polling `/api/boot` harder would increase file parsing and session scan cost while still leaving correctness gaps.

3. **Extend the existing SSE/store contract with targeted live payloads.**
   Reuse `web/app/api/session/events/route.ts`, `BridgeService.subscribe(...)`, and `useSyncExternalStore` in `web/lib/gsd-workspace-store.tsx`. Add small browser-facing payloads for:
   - `auto` freshness: active/paused/step mode, elapsed, current unit, totals
   - `workspace` freshness: active scope, validation-issue summary/count, suggested next commands, resumable-session freshness
   - `recovery` freshness: interrupted-run / retry / compaction / bridge-failure state with actionable labels

4. **Keep heavy diagnostics off the stream and off `/api/boot`.**
   Add dedicated same-origin routes for expensive or richer state, using S02’s on-demand route pattern. Likely candidates:
   - a recovery/forensics route backed by `session-forensics.ts`
   - a doctor diagnostics route backed by `doctor.ts` and `workspace-index.ts`
   These routes should return already-shaped browser view models, not raw internal objects.

5. **Define explicit invalidation rules instead of “refresh sometimes”.**
   S03 should write down when each surface refreshes. Example:
   - on `agent_end` / `turn_end`: refresh workspace validation + suggested next actions
   - on `auto_retry_start|end` / `auto_compaction_start|end`: refresh live session + auto + recovery state
   - on session switch/new/fork/rename success: refresh resumable sessions and any open session-browser state
   - on reconnect / visibility return: soft refresh boot once, then restore targeted live subscriptions
   - on Git surface open while stale: reload only `/api/git`, not boot

6. **Expose recovery state in a named browser surface, not only terminal lines.**
   The browser already has an inspectable command-surface contract (`web/lib/command-surface-contract.ts`). Either extend it with a diagnostics/recovery section or add a sibling browser-native diagnostics surface, but keep it inspectable and stateful the same way S01-S02 surfaces are.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Live auto/dashboard truth | `src/resources/extensions/gsd/auto.ts#getAutoDashboardData()` and `src/resources/extensions/gsd/dashboard-overlay.ts` | This is the real GSD auto-state source; browser metrics should match it instead of inferring from terminal text or test stubs. |
| Workspace validation and next-step hints | `src/resources/extensions/gsd/workspace-index.ts#indexWorkspace()` and `getSuggestedNextCommands()` | Keeps browser validation/recovery suggestions aligned with authoritative workspace and doctor semantics. |
| Interrupted-run recovery and deep diagnostics | `src/resources/extensions/gsd/session-forensics.ts#synthesizeCrashRecovery()` and `getDeepDiagnostic()` | Reuses real session-file and activity-log recovery logic instead of inventing a thinner browser-only interpretation. |
| Structured doctor output | `src/resources/extensions/gsd/doctor.ts#runGSDDoctor()`, `summarizeDoctorIssues()`, and `formatDoctorReport()` | Produces actionable diagnostics with counts, codes, and scoping rules the browser can present directly. |
| Browser live-state plumbing | `web/app/api/session/events/route.ts` + `src/web/bridge-service.ts#subscribe()` + `web/lib/gsd-workspace-store.tsx` | The transport, store subscription model, and local event routing already exist; S03 should extend them, not replace them. |
| Narrow on-demand browser contracts | `web/app/api/session/browser/route.ts`, `web/app/api/session/manage/route.ts`, and `web/app/api/git/route.ts` | S02 already proved the right pattern for rich same-origin browser contracts without widening `/api/boot`. |

## Existing Code and Patterns

- `src/web/bridge-service.ts` — authoritative web boot assembly, singleton bridge lifecycle, SSE subscriber fan-out, workspace-index cache, and the current production auto-data stub via `fallbackAutoDashboardData()`.
- `web/lib/gsd-workspace-store.tsx` — current browser external store; the terminal is event-driven, but `recordBridgeStatus()` only patches `boot.bridge`, leaving `boot.workspace`, `boot.auto`, and `boot.resumableSessions` snapshot-driven.
- `web/app/api/session/events/route.ts` — good existing Next.js/App Router SSE seam (`runtime = "nodejs"`, `dynamic = "force-dynamic"`, streaming `ReadableStream` with `text/event-stream`).
- `web/components/gsd/dashboard.tsx` — renders metrics, progress, and session picker largely from `boot.auto`, `boot.workspace`, and `boot.resumableSessions`; these are not live today.
- `web/components/gsd/sidebar.tsx` — shows current scope and validation-issue count from `boot.workspace.validationIssues`; currently only refreshed through boot refreshes.
- `web/components/gsd/roadmap.tsx` — renders milestones/slices entirely from `boot.workspace`; it will drift during live work without targeted updates or invalidation.
- `web/components/gsd/status-bar.tsx` — shows elapsed time, token/cost totals, title override, and extension status; title/status text are live, but auto totals still come from `boot.auto`.
- `web/lib/command-surface-contract.ts` — existing inspectable browser-native surface state; there is no recovery/doctor section yet, but this is the strongest existing seam for adding one.
- `src/resources/extensions/gsd/auto.ts` — authoritative auto-mode runtime state, including current unit, totals, retry counters, and recovery behavior.
- `src/resources/extensions/gsd/workspace-index.ts` — authoritative workspace structure, validation issues, and suggested next commands.
- `src/resources/extensions/gsd/session-forensics.ts` — structured crash-recovery and deep-diagnostic generation from session JSONL/activity truth.
- `src/resources/extensions/gsd/doctor.ts` — structured doctor report model, summaries, formatting, and scope-aware issue selection.
- `packages/pi-coding-agent/src/core/agent-session.ts` — rich retry/compaction event payloads already exist (`auto_retry_start|end`, `auto_compaction_start|end`), including attempts and error text.
- `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts` / `rpc-types.ts` — current `get_state` already exposes `retryInProgress`, `retryAttempt`, and compaction flags, giving S03 a stable live-session seam to build from.

## Constraints

- `R011` is the only Active requirement, and S03 supports it by making S01-S02 parity surfaces stay fresh and recoverable during real browser work.
- `/api/boot` is intentionally heavy and should stay a startup snapshot; it assembles workspace index, sessions, onboarding, bridge snapshot, and currently caches workspace-index data for 30 seconds.
- `src/web/bridge-service.ts` currently has **no production invalidation path** for `workspaceIndexCache`; only test helpers clear it.
- The current production boot path uses `fallbackAutoDashboardData()` unless deps are overridden, so auto-mode metrics are currently stubbed in real web mode.
- S02 already established a build-safety rule: avoid importing broad TUI/package runtime directly into Next routes. Reuse child-process or narrow server-only helper seams for doctor/forensics/auto truth.
- `useSyncExternalStore` remains the right client-state pattern here; new live state should stay in the external store, not be scattered into component-local polling effects.
- Keep M002 current-project scoped; do not let recovery/session freshness grow into cross-project launcher or analytics scope (R020/R021).

## Common Pitfalls

- **Trying to fix freshness by polling `/api/boot`** — this increases parsing/session-scan cost and still misses proper invalidation. Use targeted live payloads plus explicit refresh rules instead.
- **Missing the production auto-data stub** — tests inject fake auto data, so they can mask that real browser boot currently gets an all-zero fallback payload. Replace the production provider first.
- **Inferring recovery state from terminal lines** — `session-forensics.ts`, `doctor.ts`, and `agent-session.ts` already have structured truth. Use that instead of parsing browser transcript text.
- **Forgetting on-demand surface invalidation** — `commandSurface.gitSummary` and `commandSurface.sessionBrowser` are cached in client state after load. S03 needs explicit stale/reload rules when resume/new/fork/git state changes.
- **Importing too much server runtime into Next routes** — S02 already showed that broad imports can break the standalone host bundle. Keep diagnostics behind narrow helpers or subprocess seams.

## Open Risks

- Authoritative auto-mode data may require a new production-safe child-process/helper seam before any live refresh work can be truthful.
- Running doctor or session-forensics too often could be expensive; diagnostics likely need lazy loading, active-scope scoping, and event-triggered invalidation instead of continuous recompute.
- Current-project session listing still scales with history because metadata comes from session files; refreshing resumable sessions on every low-level event would regress responsiveness.
- If workspace freshness hooks fire on noisy events like every `message_update`, the browser could thrash. S03 needs coarse invalidation on lifecycle boundaries, not token-by-token refreshes.
- A recovery surface can easily grow into a generic analytics/forensics console; keep it focused on actionable daily browser recovery for R011.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Next.js App Router | `wshobson/agents@nextjs-app-router-patterns` | available (not installed) — `npx skills add wshobson/agents@nextjs-app-router-patterns` |
| React | `vercel-labs/agent-skills@vercel-react-best-practices` | available (not installed) — `npx skills add vercel-labs/agent-skills@vercel-react-best-practices` |
| Server-Sent Events | `dadbodgeoff/drift@sse-streaming` | available (not installed) — `npx skills add dadbodgeoff/drift@sse-streaming` |

## Sources

- Boot currently caches workspace-index data for 30 seconds, has no production cache invalidation, and defaults auto state to `fallbackAutoDashboardData()` in real web mode (source: `src/web/bridge-service.ts`).
- The browser store is already event-driven via `useSyncExternalStore`, but `bridge_status` only patches `boot.bridge`; the surrounding workspace/auto/session panels remain boot-snapshot-driven (source: `web/lib/gsd-workspace-store.tsx`).
- Dashboard, sidebar, roadmap, and status bar all depend heavily on `boot.workspace`, `boot.auto`, and `boot.resumableSessions`, which explains why they drift while terminal streaming stays live (source: `web/components/gsd/dashboard.tsx`, `sidebar.tsx`, `roadmap.tsx`, `status-bar.tsx`).
- Existing browser route patterns already favor narrow same-origin contracts instead of widening boot, which is the right pattern to reuse for S03 diagnostics (source: `web/app/api/session/browser/route.ts`, `web/app/api/session/manage/route.ts`, `web/app/api/git/route.ts`).
- Auto-mode, validation, doctor, and interrupted-run recovery truths already exist in GSD core and should be reused instead of inferred (source: `src/resources/extensions/gsd/auto.ts`, `workspace-index.ts`, `session-forensics.ts`, `doctor.ts`).
- Agent session events already carry structured retry/compaction details the browser could surface more richly than terminal summaries do today (source: `packages/pi-coding-agent/src/core/agent-session.ts`, `web/lib/gsd-workspace-store.tsx`).
- The existing SSE route shape is compatible with targeted live payload expansion in Next.js/App Router (`text/event-stream`, streaming responses, dynamic route handlers) (source: `web/app/api/session/events/route.ts`; Context7 Next.js docs for streaming route handlers).
- The current external-store architecture is aligned with React’s recommended `useSyncExternalStore` pattern for live subscriptions (source: `web/lib/gsd-workspace-store.tsx`; Context7 React docs for `useSyncExternalStore`).
