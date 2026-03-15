---
estimated_steps: 4
estimated_files: 8
---

# T04: Turn the sidebar Git button into a real browser-native repo surface

**Slice:** S02 — Browser-native session and settings parity surfaces
**Milestone:** M002

## Description

The sidebar Git button is still visibly clickable and functionally dead. This task gives it a real browser-native outcome by introducing a read-only current-project git summary contract and wiring the button into the shared command surface, so the shell no longer advertises inert chrome.

## Steps

1. Add a small read-only git summary service for the current project that uses existing repo truth rather than browser-only heuristics.
2. Expose that data through a same-origin route with explicit not-a-repo and load-failure behavior.
3. Extend the shared command-surface/store contract with a git summary section and wire the sidebar Git button to open it.
4. Add tests proving the button is no longer inert and that empty/error states stay browser-visible instead of silently failing.

## Must-Haves

- [ ] Sidebar Git button opens a real browser-native surface
- [ ] Git summary is current-project scoped and read-only
- [ ] Not-a-repo and load-error states are explicit
- [ ] Tests fail if the visible affordance becomes inert again

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-state-surfaces-contract.test.ts && npm run build:web-host`
- Verification names the affordance or git-summary state that regressed if the button goes dead again

## Observability Impact

- Signals added/changed: git-summary load/pending/error/result state in the shared command surface
- How a future agent inspects this: hit `/api/git`, inspect the sidebar button target and command-surface section markers, and read the state-surface contract assertions
- Failure state exposed: not-a-repo and git-load errors become inspectable browser-visible state instead of a no-op click

## Inputs

- `web/components/gsd/sidebar.tsx` — currently inert Git button
- `web/lib/command-surface-contract.ts`, `web/lib/gsd-workspace-store.tsx`, `web/components/gsd/command-surface.tsx` — shared browser surface seams
- `src/resources/extensions/gsd/native-git-bridge.ts` and related repo-truth helpers — preferred read-only git source

## Expected Output

- `src/web/git-summary-service.ts` — read-only current-project git summary helper
- `web/app/api/git/route.ts` — git summary route
- `web/lib/command-surface-contract.ts`, `web/lib/gsd-workspace-store.tsx`, `web/components/gsd/command-surface.tsx` — shared git surface support
- `web/components/gsd/sidebar.tsx` — Git button wired to the new browser surface
- `src/tests/web-session-parity-contract.test.ts`, `src/tests/web-state-surfaces-contract.test.ts` — non-inert affordance coverage
