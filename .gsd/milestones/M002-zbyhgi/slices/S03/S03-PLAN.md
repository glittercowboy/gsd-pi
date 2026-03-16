# S03: Screenshot pipeline

**Goal:** `constrainScreenshot` uses sharp instead of canvas; `browser_navigate` returns no screenshot by default.
**Demo:** Build passes, `constrainScreenshot` calls sharp for dimension check and resize (no `page.evaluate`), `browser_navigate` omits screenshot unless `screenshot: true` is passed.

## Must-Haves

- `constrainScreenshot` uses `sharp(buffer).metadata()` for dimensions and `sharp(buffer).resize().jpeg()/png().toBuffer()` for resizing — no `page.evaluate` call
- Images already within MAX_SCREENSHOT_DIM bounds are returned unchanged (no re-encoding)
- JPEG output uses the `quality` parameter; PNG output uses lossless `.png()` (no quality param)
- `constrainScreenshot` keeps its existing `(page, buffer, mimeType, quality)` signature for backward compatibility
- `browser_navigate` has a `screenshot` parameter (default: `false`) gating screenshot capture
- `browser_reload` screenshot behavior is unchanged
- `captureErrorScreenshot` works with the new `constrainScreenshot`
- sharp added to root `package.json` dependencies and extension `peerDependencies`

## Verification

- `node -e "require('sharp')"` — sharp is installed and loadable
- `npx tsc --noEmit` or equivalent build check passes
- Grep verification: `grep -c "page.evaluate" src/resources/extensions/browser-tools/capture.ts` returns 0
- Grep verification: `grep "screenshot.*boolean" src/resources/extensions/browser-tools/tools/navigation.ts` finds the parameter
- Grep verification: `grep "default.*false\|screenshot.*false" src/resources/extensions/browser-tools/tools/navigation.ts` confirms default is false
- Extension loads via jiti and all 43 tools register

## Tasks

- [x] **T01: Replace constrainScreenshot with sharp and make navigate screenshots opt-in** `est:30m`
  - Why: Delivers both R020 (sharp-based resizing) and R021 (opt-in navigate screenshots) — the two requirements this slice owns
  - Files: `package.json`, `src/resources/extensions/browser-tools/package.json`, `src/resources/extensions/browser-tools/capture.ts`, `src/resources/extensions/browser-tools/tools/navigation.ts`
  - Do: (1) Add sharp to root `package.json` dependencies and extension `peerDependencies`, run install. (2) Rewrite `constrainScreenshot` internals: use `sharp(buffer).metadata()` for width/height, return buffer unchanged if within bounds, otherwise `sharp(buffer).resize(MAX, MAX, { fit: 'inside' }).jpeg({ quality }).toBuffer()` for JPEG or `.png().toBuffer()` for PNG. Keep the `page` parameter unused. (3) Add `screenshot?: boolean` parameter (default: false) to `browser_navigate`, gate the screenshot capture block on it. Update the tool description. (4) Verify build, grep checks, extension load.
  - Verify: Build passes; `grep -c "page.evaluate" capture.ts` returns 0; extension loads with 43 tools; navigate tool schema includes `screenshot` boolean parameter
  - Done when: sharp handles all screenshot resizing with no page dependency; navigate returns no screenshot by default

## Files Likely Touched

- `package.json`
- `src/resources/extensions/browser-tools/package.json`
- `src/resources/extensions/browser-tools/capture.ts`
- `src/resources/extensions/browser-tools/tools/navigation.ts`
