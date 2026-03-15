# S02: Browser-native session and settings parity surfaces — Research

**Date:** 2026-03-15
**Requirement focus:** Supports **R011** — remaining lower-frequency TUI capabilities reach browser parity after the primary loop.

## Summary

S02 should build on S01’s shared browser command surface and store contract rather than creating a second browser-only settings or session system. `web/lib/gsd-workspace-store.tsx` already centralizes slash dispatch, surface state, auth orchestration, session switching, forking, compaction, and soft boot refreshes. The gap is no longer safe command routing; it is semantic depth. The browser now has a real sheet for model, thinking, auth, resume, fork, session stats/export, and compact, but the authoritative TUI selectors still define much richer behavior than the browser exposes.

The highest-leverage surprise is how much transport already exists for daily-use parity. RPC already supports `set_session_name`, `set_steering_mode`, `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, plus the model/thinking/session commands S01 already wired. That means much of the settings and naming work is a browser surface problem, not a backend invention problem. By contrast, session browsing parity is missing real browser-facing data: `/api/boot` only exposes a flat `BootResumableSession` list, and the contract test explicitly proves it omits `firstMessage` and `allMessagesText`. That payload cannot faithfully drive the TUI’s threaded/searchable/renameable session selector.

The other surprise is visible-affordance debt. The Settings button now works, but the Git button in `web/components/gsd/sidebar.tsx` is still inert. Theme plumbing exists (`web/components/theme-provider.tsx`, `next-themes` dependency), but the provider is not mounted in `web/app/layout.tsx`. The store also captures `widgetContents`, `titleOverride`, and `editorTextBuffer`, yet no browser surface renders them. S02 therefore needs explicit decisions about which visible controls become real browser surfaces now, which are clearly deferred, and which require new serializable contracts before they can claim parity.

## Recommendation

1. **Keep one browser control plane.**
   Extend the existing `commandSurface` state and `CommandSurface` sheet instead of creating a separate settings page, modal stack, or second dispatcher. S01 already established the correct seam.

2. **Add a dedicated current-project session browser contract instead of thickening `/api/boot`.**
   The browser needs a narrow serializable session view model derived from `SessionManager.list(...)` and TUI session-selector semantics, not more boot snapshot weight. A slice-ready contract should carry at least:
   - `id`, `path`, `name`, `cwd`, `modifiedAt`, `createdAt`, `messageCount`
   - `parentSessionPath`
   - `firstMessage`
   - `isActive`
   - enough data for current-project search, threaded view, recent view, and named-only filter

   Current-project scope is enough for S02. Do **not** widen this into all-project hub behavior from R020.

3. **Wire session naming as first-class browser parity.**
   `/name` is currently still rejected in browser mode even though the behavior is simple and already authoritative in TUI. Ship:
   - a browser name field/action in the existing session section or a small dedicated name subsection
   - slash `/name <value>` -> browser surface or direct browser action
   - active-session rename via RPC `set_session_name`
   - inactive-session rename via a server-side session mutation path that reuses `SessionManager.open(...).appendSessionInfo(...)`

   Important nuance: renaming the active session by writing the JSONL file directly is not enough; the live bridge session state also needs to stay in sync.

4. **Promote the daily-use settings that already have serializable transport.**
   The current browser “settings” surface is really only model/thinking/auth. S02 should add the TUI settings that matter for real browser use and already map cleanly to RPC or settings storage:
   - steering mode
   - follow-up mode
   - auto-compact
   - auto-retry / abort-retry if the UX stays clear
   - possibly transport if live browser use shows it matters

   These should stay in the shared browser settings surface rather than becoming hidden slash-only controls.

5. **Use TUI selectors as parity truth, but cut scope explicitly where contracts are missing.**
   For this slice, the browser should align with the semantics in:
   - `session-selector.ts` for browse/sort/search/thread/rename/delete behavior
   - `settings-selector.ts` for settings inventory and labeling
   - `interactive-mode.ts` for `/name`, `/settings`, `/resume`, and `/model` command behavior

   Explicitly defer or reject, with browser-visible reasoning, anything that still lacks a clean serializable seam for S02: `/tree`, `/reload`, and likely `/scoped-models` unless daily-use testing proves they are blocking.

6. **Resolve visible affordance debt instead of leaving chrome inert.**
   The Git button cannot stay clickable and inert if S02 claims parity surfaces. The slice should either:
   - wire it to a minimal browser-native git summary surface backed by existing repo/git truth, or
   - explicitly demote/remove it from the visible affordance set for now.

   Do not silently leave it dead.

7. **Prove parity with targeted contract and integration coverage.**
   Add or extend:
   - `src/tests/web-session-parity-contract.test.ts` for session browser, rename, and settings surface contracts
   - `src/tests/integration/web-mode-assembled.test.ts` for typed `/name`, settings button flows, session rename/resume, and auth management round-trips
   - browser/runtime assertions that the visible Settings and Git affordances no longer behave as inert UI

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Current-project session browser semantics | `packages/pi-coding-agent/src/modes/interactive/components/session-selector.ts` + `session-selector-search.ts` + `packages/pi-coding-agent/src/core/session-manager.ts` | Preserves the real threaded/recent/relevance, named-filter, rename, delete, and current-vs-all semantics instead of inventing a browser-only session browser. |
| Session naming behavior | `packages/pi-coding-agent/src/modes/rpc/rpc-types.ts` (`set_session_name`) + `packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts#handleNameCommand()` | The TUI behavior is already simple and authoritative; browser parity should reuse it rather than designing a new naming model. |
| Daily-use settings inventory and side effects | `packages/pi-coding-agent/src/modes/interactive/components/settings-selector.ts` + `packages/pi-coding-agent/src/core/settings-manager.ts` + `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts` | The labels, options, persistence rules, and many mutations already exist. Browser work should serialize and expose them, not redefine them. |
| Browser auth management | `src/web/onboarding-service.ts` + `src/web/web-auth-storage.ts` + existing auth section in `web/components/gsd/command-surface.tsx` | Auth setup, OAuth progress, validation, bridge refresh, and logout constraints already have a browser-safe contract. |
| Shared browser panel orchestration | `web/lib/gsd-workspace-store.tsx` + `web/lib/command-surface-contract.ts` + `web/components/gsd/command-surface.tsx` | S01 already established the inspectable store/surface seam. Extending it avoids click-vs-slash drift and avoids inventing another panel model. |

## Existing Code and Patterns

- `web/lib/gsd-workspace-store.tsx` — authoritative browser store; already owns slash outcomes, `commandSurface`, auth actions, session switching, forking, compaction, boot refresh, `pendingUiRequests`, and extra RPC-fed UI state. Extend this seam rather than splitting browser parity logic across components.
- `web/components/gsd/command-surface.tsx` — existing browser-native sheet for settings/session/auth actions. It is the natural home for name, queue-mode, and richer session-browse parity.
- `packages/pi-coding-agent/src/modes/interactive/components/session-selector.ts` — canonical resume/session browser semantics: current-vs-all scope, threaded/recent/relevance sorting, regex/exact search, named-only filter, rename, delete, and active-session protection.
- `packages/pi-coding-agent/src/core/session-manager.ts` — authoritative session metadata includes `parentSessionPath`, `firstMessage`, and `allMessagesText`, which the current browser boot payload drops.
- `src/web/bridge-service.ts` — `/api/boot` assembly, 30s workspace-index cache, and current lightweight `BootResumableSession` mapping. Good snapshot source; wrong place to stuff a rich live session browser.
- `src/tests/web-bridge-contract.test.ts` — already asserts `BootResumableSession` omits `firstMessage` and `allMessagesText`, which is strong evidence that S02 needs a new session-browser contract instead of pretending boot is enough.
- `packages/pi-coding-agent/src/modes/rpc/rpc-types.ts` + `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts` — existing serializable surface for model/thinking/session plus queue modes, auto-compaction, retry, and session naming.
- `packages/pi-coding-agent/src/modes/interactive/components/settings-selector.ts` + `packages/pi-coding-agent/src/core/settings-manager.ts` — authoritative daily settings menu and persistence behavior; most values are global/persistent, while some affect the live session immediately.
- `src/web/onboarding-service.ts` — authoritative browser auth lifecycle, including required/optional provider state, OAuth progress, validation, and explicit auth-file-only logout behavior.
- `web/components/gsd/sidebar.tsx` — Settings button now opens the shared surface, but the Git button remains inert and therefore still counts as visible parity debt.
- `web/app/layout.tsx` + `web/components/theme-provider.tsx` — theme plumbing exists in-repo, but the provider is not mounted in the live shell.
- `web/components/gsd/status-bar.tsx` — only `statusTexts` are rendered today; `widgetContents`, `titleOverride`, and `editorTextBuffer` are captured in store but still invisible in the browser.

## Constraints

- S02 supports **R011** and stays **current-project scoped**. Do not widen the slice into all-project resume/hub behavior from deferred **R020**.
- `/api/boot` is still a heavy snapshot path, and `src/web/bridge-service.ts` still keeps a 30s workspace-index cache with no production invalidation helper exposed outside test setup. Do not solve parity by polling or overloading boot.
- The current browser `resumableSessions` payload is intentionally lightweight; it cannot faithfully drive the TUI session tree/search contract.
- RPC mode deliberately strips TUI-only factories and does not support theme switching via `ui.setTheme(...)`; browser parity must use serializable view models or browser-local theme handling.
- Many settings in `SettingsSelectorComponent` persist through `SettingsManager`, not just through transient session state. Browser settings UX must distinguish live-session changes from persisted/global settings.
- Browser logout is intentionally limited to providers configured via `auth_file`. Environment/runtime-backed auth must still fail explicitly and visibly.
- For active session rename, browser parity needs live bridge state sync; direct file mutation alone is insufficient.

## Common Pitfalls

- **Treating the S01 sheet as “settings parity complete”** — it currently covers model, thinking, auth, resume, fork, stats/export, and compact, but not session naming, queue modes, auto-compact, retry, or the broader TUI settings inventory.
- **Trying to derive browser session parity from `BootResumableSession`** — that contract omits the exact fields (`parentSessionPath`, `firstMessage`, search corpus) that the TUI session browser depends on.
- **Solving richer session browsing by making `/api/boot` fatter** — this fights D022 and increases snapshot cost; use a narrow session-browser contract instead.
- **Renaming active sessions by mutating the JSONL file directly** — the live bridge session state will drift unless the active-session path also uses RPC or an equivalent bridge-aware mutation.
- **Assuming store capture equals UI parity** — `widgetContents`, `titleOverride`, and `editorTextBuffer` are tracked, but nothing in the browser shell renders them yet.
- **Mounting theme UI without mounting theme infrastructure** — `next-themes` is present, but `ThemeProvider` is not currently in the live app tree.
- **Leaving the Git button inert** — if the control stays visible, S02 needs a real browser outcome for it.

## Open Risks

- The Git affordance may not have a clean existing browser-native counterpart beyond branch/status plumbing, so it may force either a small new view model or an explicit visual deferral.
- `/tree`, `/reload`, and `/scoped-models` still lack a proven browser-appropriate contract. If S02 tries to absorb them all, it can easily spill into S03/S04.
- Richer session browsing can regress responsiveness if it parses too much history too often; the slice should keep the contract current-project and refresh-on-demand.
- Persisted settings changes can affect both the live bridge and the browser host. Poorly separated “live vs persisted” behavior could create confusing partial updates.
- Theme parity can widen scope quickly if the web skin’s actual dark/light/theme variants are not already complete beyond the dormant provider plumbing.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Next.js App Router | `wshobson/agents@nextjs-app-router-patterns` | available (not installed, 8.4K installs) — `npx skills add wshobson/agents@nextjs-app-router-patterns` |
| React | `vercel-labs/agent-skills@vercel-react-best-practices` | available (not installed, 210.2K installs) — `npx skills add vercel-labs/agent-skills@vercel-react-best-practices` |
| Server-Sent Events | `dadbodgeoff/drift@sse-streaming` | available (not installed, 29 installs) — `npx skills add dadbodgeoff/drift@sse-streaming` |

## Sources

- Shared browser store and command-surface seam already centralize slash outcomes, auth, session actions, and extra extension UI state (source: `web/lib/gsd-workspace-store.tsx`, `web/lib/command-surface-contract.ts`, `web/components/gsd/command-surface.tsx`)
- Browser boot session payload is intentionally lightweight and currently omits rich session-browser fields (source: `src/web/bridge-service.ts`, `src/tests/web-bridge-contract.test.ts`)
- Canonical session browsing, threading, search, rename, and delete semantics already exist in the TUI selector (source: `packages/pi-coding-agent/src/modes/interactive/components/session-selector.ts`, `packages/pi-coding-agent/src/core/session-manager.ts`)
- Session naming is already implemented in TUI and serializable over RPC, but the browser does not expose it yet (source: `packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts`, `packages/pi-coding-agent/src/modes/rpc/rpc-types.ts`, `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts`)
- Daily-use settings inventory and persistence rules already exist; browser currently exposes only a subset (source: `packages/pi-coding-agent/src/modes/interactive/components/settings-selector.ts`, `packages/pi-coding-agent/src/core/settings-manager.ts`, `packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts`)
- Browser auth management is already authoritative and browser-safe, including explicit logout limits for environment/runtime auth (source: `src/web/onboarding-service.ts`, `src/web/web-auth-storage.ts`, `web/components/gsd/onboarding-gate.tsx`)
- Visible affordance debt remains in the shell: Git button inert, theme provider unmounted, and extra store-fed widget/title/editor signals still unrendered (source: `web/components/gsd/sidebar.tsx`, `web/app/layout.tsx`, `web/components/theme-provider.tsx`, `web/components/gsd/status-bar.tsx`)
