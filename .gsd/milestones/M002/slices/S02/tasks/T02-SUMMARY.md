---
id: T02
parent: S02
milestone: M002
provides:
  - A browser-native current-project session surface that wires `/resume` and `/name` through one shared store path with inspectable session-browser and rename/resume state
key_files:
  - web/lib/browser-slash-command-dispatch.ts
  - web/lib/command-surface-contract.ts
  - web/lib/gsd-workspace-store.tsx
  - web/components/gsd/command-surface.tsx
  - src/tests/web-command-parity-contract.test.ts
  - src/tests/web-session-parity-contract.test.ts
  - src/tests/integration/web-mode-assembled.test.ts
key_decisions:
  - Overlay the live active-session name into browser store state after resume/rename instead of widening `/api/boot` or the session-browser route just to reflect RPC-only active renames
patterns_established:
  - Typed `/resume` and `/name` now open one shared browser-native session surface, while clicked resume/rename affordances route through the same store actions and inspectable command-surface state
observability_surfaces:
  - `commandSurface.sessionBrowser`, `commandSurface.resumeRequest`, and `commandSurface.renameRequest`
  - command-surface `data-testid` markers for session-browser query/meta/resume/rename controls
  - `/api/session/browser` and `/api/session/manage`
duration: 4h
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Wire `/resume` and `/name` onto a real browser session surface

**Shipped a real browser-native current-project session browser for `/resume` and `/name`, with shared store actions for typed and clicked resume/rename flows plus immediate visible state updates after success.**

## What Happened

I promoted `/name` from a browser reject to a first-class browser surface in `web/lib/browser-slash-command-dispatch.ts` and added a dedicated `name` surface/section to the shared command-surface contract.

In `web/lib/command-surface-contract.ts` I extended the shared state with:
- current-project session-browser query/results state
- explicit `resumeRequest` and `renameRequest` mutation state
- a `name` target that carries rename draft state
- `load_session_browser` and `rename_session` pending/result handling on the same reducer path as the existing session actions

In `web/lib/gsd-workspace-store.tsx` I added the real browser actions for:
- loading `/api/session/browser`
- updating query/sort/name-filter state
- posting rename mutations to `/api/session/manage`
- keeping typed slash entry and clicked resume/rename controls on the same store action path
- patching visible boot/session-browser state immediately after successful resume or rename

A key detail is active-session naming: active rename is bridge RPC-only and does not rewrite the session file, so I overlaid the live bridge session name into `boot.resumableSessions` and the command-surface session-browser state in the browser store. That keeps the visible browser state aligned immediately without widening `/api/boot` or the session-browser contract.

In `web/components/gsd/command-surface.tsx` I replaced the thin boot-based resume list with a real current-project session browser shared by both the `resume` and `name` sections. It now renders:
- search
- threaded/recent/relevance sort
- named-only filtering
- current-project result metadata
- resume selection/apply controls
- rename selection/draft/apply controls
- stable `data-testid` markers for future inspection

I updated parity/integration tests so `/name` is explicitly browser-native, the new command-surface state remains inspectable, and clicked resume/rename affordances are proven to use the same store action path as typed slash flows.

## Verification

Passed task-level verification:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-command-parity-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`

Passed additional slice-level verification already in scope for this slice:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts src/tests/web-state-surfaces-contract.test.ts src/tests/web-live-interaction-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`
- `npm run build:web-host`

Browser verification attempt:
- Started the local host and exercised the browser shell.
- The built standalone host returned `_next` asset 500s under browser automation; switching to `next dev` loaded a generic client-side exception page instead of the shell.
- Captured a debug bundle for follow-up at `.artifacts/browser/2026-03-15T11-24-44-143Z-t02-browser-smoke-failure`.

## Diagnostics

- Inspect `commandSurface.sessionBrowser`, `commandSurface.resumeRequest`, and `commandSurface.renameRequest` in the browser store
- Hit `GET /api/session/browser` for current-project browse/query payloads
- Hit `POST /api/session/manage` for rename mutation results
- Inspect `data-testid` markers in `web/components/gsd/command-surface.tsx`:
  - `command-surface-session-browser-query`
  - `command-surface-session-browser-meta`
  - `command-surface-apply-resume`
  - `command-surface-apply-rename`
- Browser failure artifact: `.artifacts/browser/2026-03-15T11-24-44-143Z-t02-browser-smoke-failure`

## Deviations

None.

## Known Issues

- The required real-browser smoke did not complete cleanly under automation in this run: the standalone host served `_next` asset 500s, and `next dev` rendered a generic client-side exception page without a captured console stack. Contract tests and `build:web-host` passed, but the browser debug bundle should be used if later work needs to chase the automation/runtime failure.
- The existing non-blocking `MODULE_TYPELESS_PACKAGE_JSON` warnings for `web/package.json` remain.

## Files Created/Modified

- `web/lib/browser-slash-command-dispatch.ts` — promoted `/name` to a browser-native surface outcome
- `web/lib/command-surface-contract.ts` — added session-browser state, rename draft target, and inspectable resume/rename mutation state
- `web/lib/gsd-workspace-store.tsx` — added session-browser load/query/rename actions and immediate visible state patching for resume/rename success
- `web/components/gsd/command-surface.tsx` — replaced the thin resume list with a real current-project browser for resume/name flows
- `src/tests/web-command-parity-contract.test.ts` — added `/name` parity, session-browser state, and shared click-path coverage
- `src/tests/web-session-parity-contract.test.ts` — added wiring/observability coverage for the shared session surface
- `src/tests/integration/web-mode-assembled.test.ts` — added assembled `/name` surface proof
- `.gsd/DECISIONS.md` — recorded the browser-store overlay decision for active-session naming parity
