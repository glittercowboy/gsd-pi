---
id: S03
parent: M002
milestone: M002
provides:
  - constrainScreenshot using sharp for server-side image resizing (no page dependency)
  - browser_navigate screenshot parameter (opt-in, default false)
requires:
  - slice: S01
    provides: capture.ts module with constrainScreenshot function, ToolDeps interface
affects:
  - S06
key_files:
  - src/resources/extensions/browser-tools/capture.ts
  - src/resources/extensions/browser-tools/tools/navigation.ts
  - src/resources/extensions/browser-tools/package.json
  - package.json
key_decisions:
  - D008 — sharp for image resizing (metadata + resize, replaces canvas round-trip)
  - D009 — Navigate screenshots off by default, opt-in via parameter
patterns_established:
  - Server-side image processing via sharp replaces in-browser canvas operations
observability_surfaces:
  - none
drill_down_paths:
  - .gsd/milestones/M002/slices/S03/tasks/T01-SUMMARY.md
duration: ~10min
verification_result: passed
completed_at: 2026-03-12
---

# S03: Screenshot pipeline

**Replaced browser canvas-based screenshot resizing with sharp; made browser_navigate screenshots opt-in (default off).**

## What Happened

Single task slice. Rewrote `constrainScreenshot` in capture.ts to use `sharp(buffer).metadata()` for dimension reading and `sharp(buffer).resize().jpeg({ quality })/png().toBuffer()` for resizing. Eliminated all manual JPEG SOF marker scanning, PNG header parsing, and the `page.evaluate` canvas round-trip that sent full buffers to the browser and back. Images within bounds are returned unchanged (no re-encoding). The `page` parameter kept as `_page` for ToolDeps interface stability.

Added `screenshot?: boolean` parameter (default: false) to `browser_navigate`, gating screenshot capture. `browser_reload` behavior unchanged (always captures).

## Verification

- `node -e "require('sharp')"` — sharp installed and loadable ✅
- `npx tsc --noEmit` — clean, no type errors ✅
- `grep -c "page.evaluate" capture.ts` → 0 (zero page.evaluate calls) ✅
- `grep "screenshot.*Type.Boolean" navigation.ts` → parameter found ✅
- `grep "default.*false" navigation.ts` → default confirmed ✅
- Extension loads via jiti without error ✅

## Requirements Validated

- R020 (Sharp-based screenshot resizing) — `constrainScreenshot` uses `sharp(buffer).metadata()` and `sharp(buffer).resize()` exclusively. Zero `page.evaluate` calls in capture.ts. sharp added to root dependencies and extension peerDependencies.
- R021 (Opt-in screenshots on navigate) — `browser_navigate` has `screenshot: Type.Optional(Type.Boolean({ default: false }))` parameter. Screenshot capture block gated with `if (params.screenshot)`. `browser_reload` unchanged.

## Requirements Advanced

- R026 (Test coverage) — sharp-based `constrainScreenshot` is now a pure buffer-in/buffer-out function, testable with buffer fixtures in S06.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

None.

## Known Limitations

- `constrainScreenshot` keeps the unused `_page` parameter for ToolDeps signature stability — minor dead parameter.

## Follow-ups

- S06 will add unit tests for `constrainScreenshot` with buffer fixtures (JPEG and PNG, within/exceeding bounds).

## Files Created/Modified

- `package.json` — added sharp ^0.34.5 to dependencies
- `src/resources/extensions/browser-tools/package.json` — added sharp >=0.33.0 to peerDependencies
- `src/resources/extensions/browser-tools/capture.ts` — rewrote constrainScreenshot with sharp, added import
- `src/resources/extensions/browser-tools/tools/navigation.ts` — added screenshot parameter (default false), gated capture block, updated description

## Forward Intelligence

### What the next slice should know
- capture.ts no longer has any `page.evaluate` calls — it's purely server-side now
- `constrainScreenshot` is a pure function (buffer in, buffer out) — ideal for unit testing with synthetic buffers

### What's fragile
- Nothing identified — sharp is a well-established library and the integration is straightforward

### Authoritative diagnostics
- `grep -c "page.evaluate" capture.ts` — should stay at 0; any non-zero means someone re-introduced browser-side processing

### What assumptions changed
- None — implementation matched the plan exactly
