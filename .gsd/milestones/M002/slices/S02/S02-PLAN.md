# S02: Browser-native session and settings parity surfaces

**Goal:** Close the semantic browser parity gap left after S01 by adding a dedicated current-project session browser/name contract, promoting the remaining daily-use settings and auth controls that already have authoritative transport, and resolving the visible browser shell affordances that are still inert or store-only.
**Demo:** A current-project browser user can browse/search/sort/resume/rename project sessions, use `/name` without rejection, change steering/follow-up/auto-compact/retry settings alongside model/thinking/auth, open a real Git summary surface from the sidebar, and see title/widget/editor shell state rendered in-browser without dropping back to the TUI.

R011 is the only Active requirement carried by M002, and S02 advances the part S01 intentionally left open: semantic depth. I’m grouping the work in dependency order, not by UI polish. First comes the on-demand current-project session-browser contract because `/api/boot` is intentionally too thin and active-vs-inactive rename semantics depend on authoritative server/bridge truth. Once that contract exists, the shared command surface can absorb `/name` plus real session browsing/rename flows without inventing browser-only behavior. After that, the browser settings surface can safely grow to the daily-use controls that already have real RPC transport. Only then is it worth spending time on the remaining visible shell debt — the inert Git button and the store-fed title/widget/editor signals — because those need the shared surface and store seams to stay coherent. I am explicitly not widening this slice into cross-project resume or convenience-only TUI commands, and I am not planning a browser theme selector unless execution also mounts the real theme infrastructure in the same task.

## Must-Haves

- The browser gets a dedicated current-project session-browser contract separate from `/api/boot`, derived from authoritative session-manager and session-selector semantics instead of thickening the boot snapshot
- Browser session parity covers current-project browse/search/sort/thread/resume and session naming, with active-session rename staying bridge-synchronized and inactive-session rename reusing authoritative session-file mutation behavior
- `/name` becomes a real browser-native outcome on the shared command surface instead of a browser reject, and typed `/resume`/`/name` flows stay aligned with clicked browser affordances
- The shared browser settings/auth surface grows beyond model/thinking/auth to the daily-use settings already backed by authoritative transport in scope for S02: steering mode, follow-up mode, auto-compact, and retry controls with explicit failure visibility
- Remaining visible shell affordances are no longer inert: the sidebar Git button opens a real browser-native repo summary surface, and extension-driven title/widget/editor state is rendered instead of staying store-only
- Contract and integration proof cover the new session contract, rename/settings failure paths, visible-affordance wiring, and the no-dead-control expectation for the shipped browser chrome

## Proof Level

- This slice proves: contract + integration
- Real runtime required: no (S04 carries the live `gsd --web` runtime assembly proof)
- Human/UAT required: no

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-command-parity-contract.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts src/tests/web-state-surfaces-contract.test.ts src/tests/web-live-interaction-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`
- `npm run build:web-host`
- Failure-path diagnostic: the parity tests must explicitly assert current-project scoping, active-vs-inactive rename behavior, settings/git surface error state, and visible browser rendering for title/widget/editor signals rather than only happy-path success

## Observability / Diagnostics

- Runtime signals: session-browser response metadata, shared command-surface section/pending/error/result state, bridge session state for rename/settings mutations, git-summary load state, and existing `titleOverride` / `widgetContents` / `editorTextBuffer` store fields once rendered
- Inspection surfaces: `/api/session/browser`, the session mutation route introduced in this slice, shared command-surface `data-testid` markers, sidebar Git affordance state, and browser shell surfaces for title/status/widgets/editor prefill
- Failure visibility: rename/settings/git failures must leave inspectable browser-visible error state, active-session rename must be distinguishable from inactive-session mutation failures, and inert-or-missing shell chrome must fail contract tests rather than silently disappearing
- Redaction constraints: keep session-browser data current-project scoped and on-demand; do not widen `/api/boot`, do not echo secrets from session text or auth failures, and avoid exposing broad message corpora outside the dedicated local browser contract

## Integration Closure

- Upstream surfaces consumed: `packages/pi-coding-agent/src/core/session-manager.ts`, `packages/pi-coding-agent/src/modes/interactive/components/session-selector.ts`, `packages/pi-coding-agent/src/modes/interactive/components/session-selector-search.ts`, `packages/pi-coding-agent/src/modes/rpc/rpc-types.ts`, `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts`, `web/lib/browser-slash-command-dispatch.ts`, `web/lib/command-surface-contract.ts`, `web/lib/gsd-workspace-store.tsx`, `web/components/gsd/command-surface.tsx`, `src/web/bridge-service.ts`, `src/web/onboarding-service.ts`, and the existing browser shell/sidebar/status components
- New wiring introduced in this slice: a dedicated current-project session-browser contract plus session mutation route, expanded shared command-surface/store actions for session naming and daily-use settings, a real Git summary surface, and browser rendering for the existing title/widget/editor state already tracked by the store
- What remains before the milestone is truly usable end-to-end: S03 still needs targeted live freshness plus recovery diagnostics, and S04 still needs the full assembled `gsd --web` refresh/reopen/interruption proof

## Tasks

- [x] **T01: Establish the dedicated current-project session browser and rename contract** `est:1h`
  - Why: The browser cannot reach TUI-like session semantics from `boot.resumableSessions`; it needs an on-demand current-project contract with authoritative search/thread metadata and explicit active-vs-inactive rename behavior before any real session UI can be honest.
  - Files: `src/web/bridge-service.ts`, `web/app/api/session/browser/route.ts`, `web/app/api/session/manage/route.ts`, `web/lib/session-browser-contract.ts`, `src/tests/web-session-parity-contract.test.ts`, `src/tests/web-bridge-contract.test.ts`
  - Do: Add a dedicated same-origin current-project session-browser contract instead of widening `/api/boot`. Drive it from `SessionManager.list(...)` and the TUI session-selector semantics, keeping search/sort/thread logic authoritative on the server side so the browser can request current-project threaded/recent/relevance and named-only views without depending on `BootResumableSession`. Return a serializable session view model with the fields needed for S02 UI (`id`, `path`, `name`, `cwd`, `createdAt`, `modifiedAt`, `messageCount`, `parentSessionPath`, `firstMessage`, `isActive`, and any threading metadata the browser renderer needs). Add a companion session mutation route for rename behavior that uses RPC `set_session_name` for the active session and `SessionManager.open(...).appendSessionInfo(...)` for inactive sessions, with explicit current-project scoping and actionable errors.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-bridge-contract.test.ts`
  - Done when: the browser has a dedicated current-project session-browser API plus rename mutation path, `/api/boot` stays lightweight, and contract tests prove current-project scoping plus active-vs-inactive rename semantics
- [x] **T02: Wire `/resume` and `/name` onto a real browser session surface** `est:1h`
  - Why: Once the session contract exists, the shared browser command surface has to consume it so session browsing, resume, and naming stop being a thin boot list plus a rejected built-in.
  - Files: `web/lib/browser-slash-command-dispatch.ts`, `web/lib/command-surface-contract.ts`, `web/lib/gsd-workspace-store.tsx`, `web/components/gsd/command-surface.tsx`, `src/tests/web-command-parity-contract.test.ts`, `src/tests/integration/web-mode-assembled.test.ts`
  - Do: Reclassify `/name` from browser reject to the shared browser surface, extend the command-surface/store contract for session-browser state, and load the new current-project session-browser view model into the existing session-oriented surface. Support the TUI-aligned controls needed for S02: threaded/recent/relevance browsing, named-only filtering, current-project search, resume, and rename. Keep typed slash flows and clicked session affordances on the same store action path so click-vs-slash behavior cannot drift, and ensure successful rename/resume updates the active browser session state immediately.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-command-parity-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`
  - Done when: `/name` no longer rejects, the browser session surface can browse/search/resume/rename current-project sessions, and integration coverage proves typed and clicked flows stay on one inspectable contract
- [x] **T03: Promote the remaining daily-use settings and auth parity on the shared surface** `est:1h`
  - Why: S01’s settings surface is still semantically shallow; the browser needs the everyday queue/compaction/retry controls that already have authoritative transport, with state that is inspectable instead of blind toggles.
  - Files: `packages/pi-coding-agent/src/modes/rpc/rpc-types.ts`, `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts`, `web/lib/command-surface-contract.ts`, `web/lib/gsd-workspace-store.tsx`, `web/components/gsd/command-surface.tsx`, `src/tests/web-session-parity-contract.test.ts`, `src/tests/integration/web-mode-assembled.test.ts`
  - Do: Extend the shared settings/auth browser surface to include steering mode, follow-up mode, auto-compaction, and retry controls in addition to the existing model/thinking/auth flows. Add any missing inspectable bridge state to `get_state` (for example retry enabled/in-progress) rather than shipping browser-local guesses, and route mutations through the existing RPC commands (`set_steering_mode`, `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`). Keep the UI explicit about live-session vs persisted behavior, preserve auth-management visibility from S01, and do not add a dead theme control unless the same task also mounts the real browser theme infrastructure.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`
  - Done when: the browser settings surface exposes the daily-use settings in scope with real state and mutations, retry/auth failures stay inspectable, and no shipped setting control is inert
- [x] **T04: Turn the sidebar Git button into a real browser-native repo surface** `est:45m`
  - Why: S02 cannot claim parity surfaces while a visible sidebar control is still a dead click; Git needs a real browser outcome or it remains obvious affordance debt.
  - Files: `src/web/git-summary-service.ts`, `web/app/api/git/route.ts`, `web/lib/command-surface-contract.ts`, `web/lib/gsd-workspace-store.tsx`, `web/components/gsd/command-surface.tsx`, `web/components/gsd/sidebar.tsx`, `src/tests/web-session-parity-contract.test.ts`, `src/tests/web-state-surfaces-contract.test.ts`
  - Do: Add a read-only current-project git summary contract backed by existing repo truth (prefer the native read-only git helpers and porcelain parsing rather than inventing browser-only status logic) and wire the sidebar Git button to open that summary inside the shared command surface. Show the current branch plus a concise dirty/staged/untracked/conflict summary, and surface explicit not-a-repo or load-error state instead of a dead button.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-state-surfaces-contract.test.ts && npm run build:web-host`
  - Done when: the sidebar Git button opens a real browser-native repo summary surface with actionable empty/error states and the shell no longer has an inert Git affordance
- [x] **T05: Render the remaining store-fed browser shell state for title, widgets, and editor prefill** `est:45m`
  - Why: The store already captures `titleOverride`, `widgetContents`, and `editorTextBuffer`, but the browser still throws those signals away; that leaves real extension-driven shell surfaces invisible even though the transport exists.
  - Files: `web/components/gsd/app-shell.tsx`, `web/components/gsd/status-bar.tsx`, `web/components/gsd/terminal.tsx`, `web/lib/gsd-workspace-store.tsx`, `src/tests/web-state-surfaces-contract.test.ts`, `src/tests/web-live-interaction-contract.test.ts`
  - Do: Render the tracked title/widget/editor state instead of leaving it store-only. Update browser/header title presentation from `titleOverride`, render widgets in the browser shell using the existing placement semantics, and seed the terminal/editor input from `editorTextBuffer` through an explicit consume-once store path so `set_editor_text` becomes visible and usable. Add stable test hooks and keep the rendering bounded so future agents can inspect whether a widget/title/editor signal is present or has been cleared.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-state-surfaces-contract.test.ts src/tests/web-live-interaction-contract.test.ts && npm run build:web-host`
  - Done when: extension-driven title/widget/editor updates are visible in the browser shell, clear/consume behavior is covered by contract tests, and those store signals are no longer invisible browser debt

## Files Likely Touched

- `src/web/bridge-service.ts`
- `web/lib/session-browser-contract.ts`
- `web/app/api/session/browser/route.ts`
- `web/app/api/session/manage/route.ts`
- `web/lib/browser-slash-command-dispatch.ts`
- `web/lib/command-surface-contract.ts`
- `web/lib/gsd-workspace-store.tsx`
- `web/components/gsd/command-surface.tsx`
- `packages/pi-coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts`
- `src/web/git-summary-service.ts`
- `web/app/api/git/route.ts`
- `web/components/gsd/sidebar.tsx`
- `web/components/gsd/app-shell.tsx`
- `web/components/gsd/status-bar.tsx`
- `web/components/gsd/terminal.tsx`
- `src/tests/web-session-parity-contract.test.ts`
- `src/tests/web-command-parity-contract.test.ts`
- `src/tests/web-bridge-contract.test.ts`
- `src/tests/web-state-surfaces-contract.test.ts`
- `src/tests/web-live-interaction-contract.test.ts`
- `src/tests/integration/web-mode-assembled.test.ts`
