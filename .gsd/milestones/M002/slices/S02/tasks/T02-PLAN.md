---
estimated_steps: 5
estimated_files: 6
---

# T02: Wire `/resume` and `/name` onto a real browser session surface

**Slice:** S02 — Browser-native session and settings parity surfaces
**Milestone:** M002

## Description

With the dedicated session-browser contract in place, the browser still needs a real user-facing surface that consumes it. This task extends the shared command surface so `/resume` and `/name` are first-class browser-native flows instead of a thin boot list and a rejected built-in, while keeping typed slash actions and clicked controls on the same store path.

## Steps

1. Reclassify `/name` in the browser slash dispatcher from `reject` to the shared browser surface, preserving explicit slash-command outcomes.
2. Extend the command-surface contract/store state to hold session-browser query state, results, rename draft state, and rename/resume pending or error state.
3. Load the dedicated current-project session-browser view model into the existing session-oriented command surface and add the controls needed for S02: threaded/recent/relevance browsing, named-only filtering, search, resume, and rename.
4. Route both typed slash flows and existing clicked session affordances through the same store actions so resume/rename behavior cannot drift by entry point.
5. Add parity and integration coverage proving `/name` no longer rejects and that resume/rename actions keep bridge state and visible browser state aligned.

## Must-Haves

- [ ] `/name` no longer rejects in browser mode
- [ ] Shared command surface renders current-project session browse/search/sort/rename controls
- [ ] Resume and rename use one store action path for slash and click entry points
- [ ] Successful rename/resume updates visible browser session state immediately
- [ ] Tests prove typed and clicked flows stay aligned

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-command-parity-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`
- Integration assertions fail by naming the slash outcome or browser-surface state that regressed

## Observability Impact

- Signals added/changed: shared command-surface session-browser state plus explicit resume/rename pending/result/error state
- How a future agent inspects this: inspect `commandSurface`, `lastSlashCommandOutcome`, and the command-surface `data-testid` markers used by the new tests
- Failure state exposed: `/name` misrouting, stale session lists, and rename/resume failures remain visible in browser/store state

## Inputs

- T01 output — dedicated current-project session-browser and rename contract
- `web/lib/browser-slash-command-dispatch.ts` — current S01 slash outcome mapping
- `web/lib/command-surface-contract.ts`, `web/lib/gsd-workspace-store.tsx`, `web/components/gsd/command-surface.tsx` — shared surface and store seams introduced by S01
- `src/tests/web-command-parity-contract.test.ts`, `src/tests/integration/web-mode-assembled.test.ts` — existing parity and assembled-route proof seams

## Expected Output

- `web/lib/browser-slash-command-dispatch.ts` — `/name` mapped to the shared browser surface
- `web/lib/command-surface-contract.ts` — session-browser state and actions added
- `web/lib/gsd-workspace-store.tsx` — session browse/rename/resume store actions
- `web/components/gsd/command-surface.tsx` — browser session selector/name UI
- `src/tests/web-command-parity-contract.test.ts`, `src/tests/web-session-parity-contract.test.ts`, `src/tests/integration/web-mode-assembled.test.ts` — coverage for `/name`, resume, and rename parity
