# S03: Screenshot pipeline — UAT

**Milestone:** M002
**Written:** 2026-03-12

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: This slice changes internal implementation (sharp replaces canvas) and a default parameter value. Behavior is verified by grep checks, type checking, and extension load — no live runtime or human visual verification needed.

## Preconditions

- `npm install` completed (sharp installed)
- Project builds cleanly (`npx tsc --noEmit`)

## Smoke Test

Run `node -e "require('sharp')"` — should exit 0 with no output, confirming sharp is installed and loadable.

## Test Cases

### 1. No page.evaluate in capture.ts

1. Run `grep -c "page.evaluate" src/resources/extensions/browser-tools/capture.ts`
2. **Expected:** Output is `0`

### 2. Navigate screenshot parameter exists with correct default

1. Run `grep "screenshot.*Type.Boolean" src/resources/extensions/browser-tools/tools/navigation.ts`
2. **Expected:** Line contains `default: false`

### 3. Build passes

1. Run `npx tsc --noEmit`
2. **Expected:** Clean exit, no errors

### 4. Extension loads

1. Load `src/resources/extensions/browser-tools/index.ts` via jiti
2. **Expected:** Module exports a function without throwing

## Edge Cases

### Images within bounds not re-encoded

1. Review `constrainScreenshot` in capture.ts
2. Confirm early return when `width <= MAX_SCREENSHOT_DIM && height <= MAX_SCREENSHOT_DIM`
3. **Expected:** Buffer returned unchanged (no sharp resize call)

### browser_reload still captures screenshots

1. Review `browser_reload` tool in navigation.ts
2. **Expected:** Screenshot capture block has no `params.screenshot` gate — always captures

## Failure Signals

- `npx tsc --noEmit` reports errors in capture.ts or navigation.ts
- `node -e "require('sharp')"` fails
- `grep -c "page.evaluate" capture.ts` returns non-zero
- Extension fails to load via jiti

## Requirements Proved By This UAT

- R020 — sharp-based resizing confirmed by zero page.evaluate grep and sharp loadability
- R021 — opt-in navigate screenshots confirmed by parameter grep with default false

## Not Proven By This UAT

- Runtime screenshot quality/dimensions under actual browser usage (deferred to S06 unit tests with buffer fixtures)
- Token savings measurement from omitting navigate screenshots

## Notes for Tester

Simple infrastructure swap — all verification is automated grep/build checks. No browser session or visual inspection needed.
