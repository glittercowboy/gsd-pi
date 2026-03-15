---
estimated_steps: 4
estimated_files: 6
---

# T05: Render the remaining store-fed browser shell state for title, widgets, and editor prefill

**Slice:** S02 — Browser-native session and settings parity surfaces
**Milestone:** M002

## Description

The browser store already captures extension-driven title overrides, widgets, and editor prefill text, but the shell still discards those signals. This task renders that existing state into the browser chrome and terminal so real extension UI updates stop ending at the store boundary.

## Steps

1. Render `titleOverride` into the browser shell/header in a stable inspectable way.
2. Render `widgetContents` in the browser shell using the existing placement semantics, with bounded display and explicit clear behavior.
3. Add a consume-once path for `editorTextBuffer` so `set_editor_text` pre-fills the terminal/editor input visibly and does not replay forever.
4. Add contract coverage that proves widget/title/editor signals become visible and clear correctly.

## Must-Haves

- [ ] `titleOverride` becomes visible in browser chrome
- [ ] `widgetContents` render in the browser shell with placement-aware semantics
- [ ] `editorTextBuffer` visibly pre-fills the browser input/editor and is not an infinite replay source
- [ ] Tests prove render and clear behavior for all three store-fed surfaces

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-state-surfaces-contract.test.ts src/tests/web-live-interaction-contract.test.ts && npm run build:web-host`
- Contract failures identify which store-fed shell surface stopped rendering or clearing correctly

## Observability Impact

- Signals added/changed: browser-visible shell state for title/widget/editor updates that were previously store-only
- How a future agent inspects this: inspect the browser shell `data-testid` markers and the underlying store fields in existing live-interaction tests
- Failure state exposed: missing render/clear behavior becomes visible through deterministic contract assertions

## Inputs

- `web/lib/gsd-workspace-store.tsx` — existing `titleOverride`, `widgetContents`, and `editorTextBuffer` state
- `web/components/gsd/app-shell.tsx`, `web/components/gsd/status-bar.tsx`, `web/components/gsd/terminal.tsx` — browser chrome that currently ignores those signals
- `src/tests/web-live-interaction-contract.test.ts` — existing proof that the store captures the signals already

## Expected Output

- `web/components/gsd/app-shell.tsx`, `web/components/gsd/status-bar.tsx`, `web/components/gsd/terminal.tsx` — browser rendering for title/widget/editor signals
- `web/lib/gsd-workspace-store.tsx` — consume-once editor prefill support if needed
- `src/tests/web-state-surfaces-contract.test.ts`, `src/tests/web-live-interaction-contract.test.ts` — visibility and clear-path coverage for the rendered shell state
