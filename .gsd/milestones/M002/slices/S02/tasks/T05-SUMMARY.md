---
id: T05
parent: S02
milestone: M002
provides:
  - Browser-visible title, widget, and editor-prefill shell surfaces for the existing store-fed extension signals, including clear/consume semantics
key_files:
  - web/components/gsd/app-shell.tsx
  - web/components/gsd/status-bar.tsx
  - web/components/gsd/terminal.tsx
  - web/lib/gsd-workspace-store.tsx
  - src/tests/web-state-surfaces-contract.test.ts
  - src/tests/web-live-interaction-contract.test.ts
key_decisions:
  - Treat empty `setTitle` updates as clear operations and consume `editorTextBuffer` through an explicit store action instead of replaying it from terminal-local state
patterns_established:
  - Store-fed browser shell signals should render through stable `data-testid` markers, preserve existing placement semantics, and use explicit consume/clear paths instead of silent one-off local effects
observability_surfaces:
  - browser shell markers: workspace-title-override, status-bar-title-override, terminal-widgets-above-editor, terminal-widgets-below-editor, terminal-widget, terminal-widget-overflow, terminal-command-input
  - workspace store fields: titleOverride, widgetContents, editorTextBuffer
  - store action: consumeEditorTextBuffer
  - contract coverage: src/tests/web-state-surfaces-contract.test.ts and src/tests/web-live-interaction-contract.test.ts
duration: 2h
verification_result: passed
completed_at: 2026-03-15T13:01:47Z
# Set blocker_discovered: true only if execution revealed the remaining slice plan
# is fundamentally invalid (wrong API, missing capability, architectural mismatch).
# Do NOT set true for ordinary bugs, minor deviations, or fixable issues.
blocker_discovered: false
---

# T05: Render the remaining store-fed browser shell state for title, widgets, and editor prefill

**Rendered the existing store-fed title/widget/editor shell signals into the browser chrome and terminal, including clearable title overrides, placement-aware widgets, and consume-once editor prefills.**

## What Happened

I rendered `titleOverride` into the browser shell instead of leaving it stranded in store state. The app shell now projects the override into actual browser chrome via `document.title` and shows a stable header marker, while the status bar keeps the same override visible in the lower shell so agents have an inspectable fallback outside the header.

I rendered `widgetContents` in the terminal using the existing extension placement semantics. Widgets now resolve to `aboveEditor` by default, render in dedicated above/below-editor bands with stable markers, and use bounded output (`MAX_VISIBLE_WIDGET_LINES = 6`) plus an explicit overflow indicator so large extension widgets cannot silently take over the browser shell.

I added an explicit `consumeEditorTextBuffer()` store action and wired the terminal input to use it. `set_editor_text` now visibly pre-fills the browser command input exactly once, focuses the input, and clears the store buffer immediately after consumption so the same text does not replay forever on rerender/remount.

On the authoritative state side, I also tightened the clear path for titles: blank `setTitle` payloads now clear `titleOverride` instead of leaving an empty string in browser chrome. The existing widget clear behavior (`widgetLines: undefined`) stayed authoritative, and the live-interaction contract now mirrors both title clearing and one-shot editor-buffer consumption.

## Verification

Passed task-level verification:

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-state-surfaces-contract.test.ts src/tests/web-live-interaction-contract.test.ts`
  - proved the browser shell source contracts render title/widget/editor markers and consume-once input wiring
  - proved the live store/event contract clears blank titles, clears widgets via `undefined`, and consumes `editorTextBuffer` exactly once

Passed the slice-level verification set:

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-command-parity-contract.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts src/tests/web-state-surfaces-contract.test.ts src/tests/web-live-interaction-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`

Passed host build verification:

- `npm run build:web-host`
  - build completed successfully and staged the standalone host
  - Next emitted the existing optional `@gsd/native` warning path from `src/resources/extensions/gsd/native-git-bridge.ts`, but the build passed

Real browser smoke on the built host:

- started `GSD_WEB_PACKAGE_ROOT=$PWD GSD_WEB_PROJECT_CWD=$PWD PORT=3000 HOSTNAME=127.0.0.1 node dist/web/standalone/server.js`
- loaded `http://127.0.0.1:3000`
- asserted `[data-testid='workspace-connection-status']`, `[data-testid='terminal-command-input']`, and `[data-testid='status-bar-unit']` were visible
- confirmed the page URL matched the standalone host and browser diagnostics stayed clean on the final smoke pass (`no console logs`, `no failed requests`)

## Diagnostics

Later inspection points:

- header/browser title surfaces
  - `web/components/gsd/app-shell.tsx`
  - `data-testid="workspace-title-override"`
  - browser tab title via `document.title`
- footer shell title surface
  - `web/components/gsd/status-bar.tsx`
  - `data-testid="status-bar-title-override"`
- terminal widget surfaces
  - `data-testid="terminal-widgets-above-editor"`
  - `data-testid="terminal-widgets-below-editor"`
  - `data-testid="terminal-widget"`
  - `data-testid="terminal-widget-overflow"`
- terminal editor prefill surface
  - `data-testid="terminal-command-input"`
  - `web/lib/gsd-workspace-store.tsx` → `editorTextBuffer` + `consumeEditorTextBuffer()`
- live-state proof
  - `src/tests/web-live-interaction-contract.test.ts`
  - `src/tests/web-state-surfaces-contract.test.ts`

## Deviations

None.

## Known Issues

- `npm run build:web-host` still emits the existing optional `@gsd/native` warning from `src/resources/extensions/gsd/native-git-bridge.ts`, but the build completes successfully and the rendered shell surfaces work.
- Manual standalone browser smoke needs the launcher-equivalent `GSD_WEB_PACKAGE_ROOT=$PWD` env; launching `dist/web/standalone/server.js` bare from the repo root still hits the pre-existing workspace-index loader resolution failure because the real `gsd --web` launcher normally provides that env contract.

## Files Created/Modified

- `web/components/gsd/app-shell.tsx` — projected `titleOverride` into browser chrome and added a stable visible header marker
- `web/components/gsd/status-bar.tsx` — rendered the active shell title override in the footer for inspectable parity outside the header
- `web/components/gsd/terminal.tsx` — rendered placement-aware widget bands, bounded widget output, overflow markers, and consume-once editor prefill behavior in the live input
- `web/lib/gsd-workspace-store.tsx` — added `consumeEditorTextBuffer()`, exported it through workspace actions, and made blank `setTitle` updates clear the stored override
- `src/tests/web-state-surfaces-contract.test.ts` — added browser-shell source-contract coverage for title/widget/editor render markers and consume-once wiring
- `src/tests/web-live-interaction-contract.test.ts` — added live-state coverage for title clear behavior and one-shot editor-buffer consumption
- `.gsd/DECISIONS.md` — recorded the shell-signal lifecycle decision for downstream work
