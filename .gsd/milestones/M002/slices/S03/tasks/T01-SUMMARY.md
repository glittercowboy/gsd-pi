---
id: T01
parent: S03
milestone: M002
provides:
  - constrainScreenshot using sharp instead of browser canvas
  - browser_navigate screenshot parameter (opt-in, default false)
key_files:
  - src/resources/extensions/browser-tools/capture.ts
  - src/resources/extensions/browser-tools/tools/navigation.ts
  - src/resources/extensions/browser-tools/package.json
  - package.json
key_decisions:
  - sharp used for both metadata reading and resize — eliminates manual JPEG/PNG header parsing and page.evaluate canvas round-trip
  - _page parameter retained in constrainScreenshot for ToolDeps signature stability (D008)
patterns_established:
  - Server-side image processing via sharp replaces in-browser canvas operations
observability_surfaces:
  - none
duration: ~10min
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T01: Replace constrainScreenshot with sharp and make navigate screenshots opt-in

**Replaced browser canvas-based screenshot resizing with sharp; made browser_navigate screenshots opt-in via `screenshot` parameter (default false).**

## What Happened

Two changes delivered:

1. **sharp integration**: Rewrote `constrainScreenshot` in capture.ts to use `sharp(buffer).metadata()` for dimension reading and `sharp(buffer).resize().jpeg()/png()` for resizing. Eliminated all manual JPEG SOF marker scanning, PNG header parsing, and the `page.evaluate` canvas round-trip. Images within bounds are returned unchanged (no re-encoding). The `page` parameter is preserved as `_page` for ToolDeps interface stability.

2. **Opt-in navigate screenshots**: Added `screenshot: Type.Optional(Type.Boolean({ default: false }))` parameter to `browser_navigate`. Screenshot capture block gated with `if (params.screenshot)`. `browser_reload` screenshot behavior left unchanged (always captures).

## Verification

All must-haves verified:

- `grep -c "page.evaluate" capture.ts` → 0 (zero page.evaluate calls in capture.ts)
- `grep "screenshot.*Type.Boolean" navigation.ts` → finds the parameter definition
- `grep "default.*false" navigation.ts` → confirms default is false
- `npx tsc --noEmit` → clean, no errors
- `node -e "require('sharp')"` → sharp loadable
- Extension loads via jiti with `@mariozechner/jiti` → 43 tools registered
- `browser_reload` screenshot block has no gate → always captures (unchanged)

Slice-level verification status (this is the only task in S03):
- ✅ `node -e "require('sharp')"` — sharp installed and loadable
- ✅ `npx tsc --noEmit` — build/typecheck passes
- ✅ `grep -c "page.evaluate" capture.ts` returns 0
- ✅ `grep "screenshot.*boolean" navigation.ts` finds parameter
- ✅ `grep "default.*false" navigation.ts` confirms default
- ✅ Extension loads via jiti — 43 tools registered

## Diagnostics

None — this is a pure implementation swap with no new runtime state.

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `package.json` — added sharp ^0.34.5 to dependencies
- `src/resources/extensions/browser-tools/package.json` — added sharp >=0.33.0 to peerDependencies
- `src/resources/extensions/browser-tools/capture.ts` — rewrote constrainScreenshot with sharp, added `import sharp from "sharp"`
- `src/resources/extensions/browser-tools/tools/navigation.ts` — added `screenshot` parameter (default false), gated screenshot block, updated description
