---
id: S02
parent: M002
milestone: M002
provides:
  - Browser-native current-project session browsing, naming, daily-use settings/auth controls, Git summary, and shell title/widget/editor parity surfaces without widening `/api/boot`
requires:
  - slice: S01
    provides: Authoritative browser slash-command dispatch plus shared command-surface/store semantics for daily-use built-ins
affects:
  - S03
  - S04
key_files:
  - src/web/bridge-service.ts
  - web/lib/session-browser-contract.ts
  - web/app/api/session/browser/route.ts
  - web/app/api/session/manage/route.ts
  - web/lib/command-surface-contract.ts
  - web/lib/gsd-workspace-store.tsx
  - web/components/gsd/command-surface.tsx
  - src/web/git-summary-service.ts
  - web/app/api/git/route.ts
  - web/components/gsd/app-shell.tsx
  - web/components/gsd/status-bar.tsx
  - web/components/gsd/terminal.tsx
key_decisions:
  - Keep rich current-project session browsing and rename behavior on dedicated on-demand browser routes instead of thickening `/api/boot`
  - Keep session search/threading server-side and use narrow child-process helpers for authoritative inactive-session mutation so the web host stays bundle-safe
  - Overlay active-session rename state in the browser store after resume/rename instead of widening server contracts for RPC-only active names
  - Represent queue/compaction/retry changes as structured `commandSurface.settingsRequests` state while deriving live retry truth from bridge `get_state` plus event-triggered refresh
  - Keep browser Git parity on a dedicated `/api/git` route and render title/widget/editor shell signals through explicit clear/consume lifecycle paths
patterns_established:
  - Shared browser parity surfaces can add narrow on-demand contracts with inspectable `pending` / `result` / `error` store state instead of widening boot snapshots
  - Typed slash commands and clicked affordances should reuse the same store action path so click-vs-slash behavior cannot drift
  - Build-sensitive server logic should stay behind route-local helpers or subprocess seams rather than importing broader TUI/package runtime into the Next host
  - Store-fed browser shell signals need stable render markers plus explicit consume/clear semantics instead of one-off local effects
observability_surfaces:
  - GET `/api/session/browser`
  - POST `/api/session/manage`
  - GET `/api/git`
  - `commandSurface.sessionBrowser`, `commandSurface.resumeRequest`, `commandSurface.renameRequest`, `commandSurface.settingsRequests`, and `commandSurface.gitSummary`
  - shared-surface and shell `data-testid` markers for session, settings, Git, title override, widgets, and editor prefill state
  - `boot.bridge.sessionState.autoRetryEnabled`, `retryInProgress`, and `retryAttempt`
drill_down_paths:
  - .gsd/milestones/M002/slices/S02/tasks/T01-SUMMARY.md
  - .gsd/milestones/M002/slices/S02/tasks/T02-SUMMARY.md
  - .gsd/milestones/M002/slices/S02/tasks/T03-SUMMARY.md
  - .gsd/milestones/M002/slices/S02/tasks/T04-SUMMARY.md
  - .gsd/milestones/M002/slices/S02/tasks/T05-SUMMARY.md
duration: 15h
verification_result: passed
completed_at: 2026-03-15
---

# S02: Browser-native session and settings parity surfaces

**Shipped real browser-native current-project session, settings/auth, Git, and shell-state parity surfaces so the remaining visible daily-use controls no longer depend on thin boot data or inert browser chrome.**

## What Happened

S02 closed the semantic browser parity gap left after S01 by promoting the browser from a thin shell into a real current-project control surface.

First, the slice established a dedicated current-project session browser and rename contract. Instead of widening `/api/boot`, the web host now exposes `GET /api/session/browser` for current-project browse/search/sort/thread/name data and `POST /api/session/manage` for rename mutations. The server keeps session search/threading authoritative and current-project scoped, returns only the browser-visible fields the UI needs, routes active-session rename through bridge RPC, and routes inactive-session rename through authoritative session-file mutation.

With that contract in place, `/resume` and `/name` were wired onto one shared browser-native session surface. The command-surface/store contract now carries inspectable session-browser query state plus explicit resume/rename request state. Typed slash flows and clicked session affordances use the same store actions, so resume and rename behavior cannot drift by entrypoint. Because active-session naming is RPC-only, the browser store overlays the live active name into visible state immediately after success instead of waiting for a heavier boot refresh.

The slice then deepened the settings/auth surface beyond model and thinking. Queue controls, follow-up mode, auto-compaction, auto-retry, and retry abort now render on the shared browser surface and mutate through authoritative RPC commands. Per-control pending/result/error state is inspectable in `commandSurface.settingsRequests`, while live retry truth comes from bridge `get_state` plus event-triggered refresh rather than browser-local guesses.

S02 also retired one of the most visible dead controls: the sidebar Git button now opens a real browser-native Git summary surface backed by `GET /api/git`. That route stays current-project scoped, reports explicit repo or not-a-repo state, exposes branch/main-branch truth plus concise file-status counts, and keeps build-sensitive Git logic behind narrow read-only helpers.

Finally, the browser stopped throwing away store-fed shell signals. `titleOverride` now renders into browser chrome and the footer shell, widgets render in bounded placement-aware bands around the editor, and `editorTextBuffer` feeds the terminal input through a consume-once store action so extension-driven editor prefills become visible and usable instead of replaying indefinitely.

Together these changes gave S03 stable named surfaces and contracts to keep fresh later: current-project session browsing and mutation, structured settings request state, on-demand Git summary state, and rendered title/widget/editor shell signals.

## Verification

Passed the full slice verification set from the plan:

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-command-parity-contract.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts src/tests/web-state-surfaces-contract.test.ts src/tests/web-live-interaction-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`
- `npm run build:web-host`

The reruns passed with:

- contract proof for current-project session browsing, active-vs-inactive rename semantics, `/name` parity, shared resume/rename action paths, settings request state, Git route behavior, and title/widget/editor shell rendering
- integration proof that assembled web-mode flows keep the new settings and slash-command behavior authoritative
- successful staged web-host build including `/api/session/browser`, `/api/session/manage`, and `/api/git`

Observability surfaces were also confirmed on the built host:

- `GET /api/session/browser` returned current-project-scoped query metadata and rich session fields outside `/api/boot`
- `GET /api/git` returned current-project Git truth with branch/main-branch metadata
- a standalone browser smoke at `http://127.0.0.1:3100` loaded the shell, exposed the sidebar Git affordance, opened the Git summary surface successfully, and stayed free of console errors and failed network requests during the smoke flow

## Requirements Advanced

- R011 — S02 proved the browser can browse/search/resume/rename current-project sessions, expose daily-use queue/compaction/retry/auth controls, open a real Git sidebar surface, and render title/widget/editor shell signals without falling back to terminal-only behavior.

## Requirements Validated

- none — R011 still needs S03 live-freshness/recovery proof and S04 assembled runtime proof before it can move from active to validated.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

None.

## Known Limitations

- R011 is not fully validated yet; S03 still needs targeted live freshness and recovery diagnostics, and S04 still needs the final assembled `gsd --web` runtime proof.
- Node-based test runs still emit non-blocking `MODULE_TYPELESS_PACKAGE_JSON` warnings because `web/package.json` is not marked as an ES module package.
- `npm run build:web-host` still emits the existing optional `@gsd/native` warning path from `native-git-bridge.ts`, but the build succeeds and the web host stages correctly.

## Follow-ups

- S03 should keep these new parity surfaces fresh via targeted live updates instead of boot polling: session browser state, retry/compaction state, Git surface cache invalidation, and browser-visible recovery/diagnostic panels.
- S03 should use the named S02 surfaces and test hooks as its primary live-state targets rather than inventing parallel state channels.

## Files Created/Modified

- `src/web/bridge-service.ts` — added browser-session helpers, authoritative rename behavior, and bridge refresh wiring for retry/compaction live state
- `web/lib/session-browser-contract.ts` — added the dedicated serializable session-browser and rename contract
- `web/app/api/session/browser/route.ts` — added the on-demand current-project session browser route
- `web/app/api/session/manage/route.ts` — added the current-project session rename route with explicit active/inactive behavior
- `web/lib/browser-slash-command-dispatch.ts` — promoted `/name` and `git` to browser-native surface outcomes
- `web/lib/command-surface-contract.ts` — expanded shared surface state for session browsing, settings requests, Git summary, and shell-facing parity sections
- `web/lib/gsd-workspace-store.tsx` — added browser actions for session browsing/rename, settings mutations, Git summary load, and consume-once editor text behavior
- `web/components/gsd/command-surface.tsx` — rendered the real session, settings/auth, and Git browser-native surfaces with stable inspection markers
- `src/web/git-summary-service.ts` — added a current-project read-only Git summary service with repo/not-a-repo handling and build-safe local git helpers
- `web/app/api/git/route.ts` — added the on-demand Git summary route
- `web/components/gsd/sidebar.tsx` — wired the sidebar Git affordance to the shared browser surface
- `web/components/gsd/app-shell.tsx` — projected title overrides into browser chrome and visible header state
- `web/components/gsd/status-bar.tsx` — rendered the active title override in the footer shell
- `web/components/gsd/terminal.tsx` — rendered placement-aware widgets and consume-once editor prefills in the browser terminal
- `src/tests/web-session-parity-contract.test.ts` — added current-project session, rename, settings, and Git contract coverage
- `src/tests/web-command-parity-contract.test.ts` — added `/name` parity plus shared session-surface and action-state coverage
- `src/tests/web-bridge-contract.test.ts` — proved `/api/boot` stayed lightweight while new bridge/session fields remained authoritative
- `src/tests/web-state-surfaces-contract.test.ts` — added no-dead-control, Git surface, and shell render coverage
- `src/tests/web-live-interaction-contract.test.ts` — added title clear behavior and one-shot editor-buffer consumption proof
- `src/tests/integration/web-mode-assembled.test.ts` — added assembled settings and slash-command parity coverage
- `.gsd/DECISIONS.md` — recorded the S02 transport and shell lifecycle decisions as D027-D032

## Forward Intelligence

### What the next slice should know
- S02 intentionally kept `/api/boot` thin. The stable live targets for S03 are now the named browser surfaces and state buckets: session browser/manage routes, structured settings requests, Git summary state, and rendered title/widget/editor signals.
- Active-session rename is still a browser-store overlay on top of bridge truth because the RPC path does not rewrite the session file. Any live invalidation work must preserve that distinction.
- Retry and compaction live state already have a bridge-refresh seam through `get_state` plus lifecycle-triggered refresh; reuse that before inventing a new polling path.

### What's fragile
- Build safety around server imports is still a real constraint — importing broader TUI/package or Git runtime directly into Next routes can pull non-web-safe dependencies into the bundle.
- The session-browser subprocess helper seam matters — it preserves authoritative session semantics without leaking the full search corpus or widening `/api/boot`, so changes there can easily regress scoping or build stability.

### Authoritative diagnostics
- `src/tests/web-session-parity-contract.test.ts` — this is the fastest trustworthy signal for current-project scoping, session rename splits, settings surface markers, and Git route behavior.
- `commandSurface.*` store state plus the shared `data-testid` markers — these are the most direct browser-visible diagnostics for whether a parity surface is pending, loaded, failed, or stale.
- `GET /api/session/browser`, `POST /api/session/manage`, and `GET /api/git` — these are the narrowest route-level truths for debugging browser parity regressions without involving the whole shell.

### What assumptions changed
- The initial assumption that richer parity could reuse existing boot payloads or broad shared services directly was wrong — both session and Git parity needed dedicated on-demand contracts to stay honest, current-project scoped, and bundle-safe.
- The assumption that store-fed shell signals were already effectively visible was also wrong — title/widget/editor state needed explicit browser rendering and consume/clear lifecycle handling before they became real user-facing surfaces.
