---
estimated_steps: 4
estimated_files: 4
---

# T01: Replace constrainScreenshot with sharp and make navigate screenshots opt-in

**Slice:** S03 — Screenshot pipeline
**Milestone:** M002

## Description

Two contained changes delivering R020 and R021. Replace `constrainScreenshot`'s manual JPEG/PNG header parsing and canvas-based resizing with sharp's `metadata()` and `resize()` APIs. Add an opt-in `screenshot` boolean parameter to `browser_navigate` (default false) so screenshots are only captured when explicitly requested.

## Steps

1. Add `sharp` to root `package.json` dependencies and to `src/resources/extensions/browser-tools/package.json` peerDependencies. Run `npm install`.
2. Rewrite `constrainScreenshot` in `capture.ts`:
   - Add `import sharp from "sharp"` at top
   - Replace manual header parsing with `const { width, height } = await sharp(buffer).metadata()`
   - Early-return original buffer if `width <= MAX_SCREENSHOT_DIM && height <= MAX_SCREENSHOT_DIM`
   - For JPEG: `return Buffer.from(await sharp(buffer).resize(MAX_SCREENSHOT_DIM, MAX_SCREENSHOT_DIM, { fit: 'inside' }).jpeg({ quality }).toBuffer())`
   - For PNG: `return Buffer.from(await sharp(buffer).resize(MAX_SCREENSHOT_DIM, MAX_SCREENSHOT_DIM, { fit: 'inside' }).png().toBuffer())`
   - Keep `page: Page` as first parameter (unused) — signature stability per D008 constraints
3. In `navigation.ts`, modify `browser_navigate`:
   - Add `screenshot: Type.Optional(Type.Boolean({ description: "Capture and return a screenshot (default: false)", default: false }))` to parameters
   - Gate the `screenshotContent` block with `if (params.screenshot)`
   - Update the tool description to mention screenshots are opt-in
4. Verify: build passes, grep checks confirm no `page.evaluate` in capture.ts, extension loads with 43 tools via jiti

## Must-Haves

- [ ] `constrainScreenshot` uses sharp — zero `page.evaluate` calls in capture.ts
- [ ] Images within bounds returned unchanged (no re-encoding)
- [ ] JPEG uses quality param; PNG uses lossless `.png()`
- [ ] `(page, buffer, mimeType, quality)` signature preserved
- [ ] `browser_navigate` screenshot parameter defaults to false
- [ ] `browser_reload` screenshot behavior unchanged
- [ ] Build passes and extension loads with 43 tools

## Verification

- `npm install` succeeds with sharp
- `grep -c "page.evaluate" src/resources/extensions/browser-tools/capture.ts` returns 0
- `grep "screenshot.*Type.Boolean\|screenshot.*boolean" src/resources/extensions/browser-tools/tools/navigation.ts` finds the parameter
- Build/typecheck passes
- Extension loads via jiti: 43 tools registered

## Inputs

- `src/resources/extensions/browser-tools/capture.ts` — current `constrainScreenshot` with manual header parsing and canvas resizing (lines 126-182)
- `src/resources/extensions/browser-tools/tools/navigation.ts` — current `browser_navigate` with always-on screenshot (lines 56-61)
- `src/resources/extensions/browser-tools/state.ts` — ToolDeps interface with `constrainScreenshot` signature (line ~342)
- S01 summary — module structure, import patterns, ToolDeps contract

## Expected Output

- `package.json` — sharp added to dependencies
- `src/resources/extensions/browser-tools/package.json` — sharp added to peerDependencies
- `src/resources/extensions/browser-tools/capture.ts` — `constrainScreenshot` rewritten with sharp, zero `page.evaluate` calls
- `src/resources/extensions/browser-tools/tools/navigation.ts` — `browser_navigate` has `screenshot` parameter (default false), gated screenshot block, updated description
