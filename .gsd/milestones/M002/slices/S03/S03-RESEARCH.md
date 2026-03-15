# S03: Screenshot pipeline — Research

**Date:** 2026-03-12

## Summary

S03 delivers two requirements: R020 (replace canvas-based screenshot resizing with sharp) and R021 (make browser_navigate screenshots opt-in). Both are low-risk, well-contained changes. The current `constrainScreenshot` in capture.ts does manual JPEG/PNG header parsing for dimensions, then bounces the entire buffer through `page.evaluate` as base64 → Image → canvas → toDataURL → back to Node. Sharp replaces all of this with `sharp(buffer).metadata()` for dimensions and `sharp(buffer).resize().jpeg().toBuffer()` for resizing — faster, simpler, no page dependency.

The navigate screenshot change is a parameter addition (`screenshot?: boolean`, default false) and a conditional gate around the existing screenshot capture block in navigation.ts. The description text needs updating to reflect the new default.

Both changes touch files from S01 (capture.ts, navigation.ts, state.ts) but don't affect any other tool's behavior. The `constrainScreenshot` signature in ToolDeps keeps the `page` parameter for backward compatibility — it just goes unused internally.

## Recommendation

**R020:** Replace `constrainScreenshot` internals with sharp. Keep the same function signature (including unused `page` parameter) to avoid touching ToolDeps and all call sites. Use `sharp(buffer).metadata()` for dimension checking (replaces manual header parsing), then `sharp(buffer).resize(MAX, MAX, { fit: 'inside' }).jpeg({ quality }).toBuffer()` or `.png().toBuffer()` for actual resizing. Return the original buffer untouched if already within bounds (avoids unnecessary re-encoding).

**R021:** Add `screenshot?: boolean` parameter to browser_navigate (default: `false`). Gate the existing screenshot capture block on this flag. Update the tool description. The reload tool keeps its screenshot behavior — its description already says it returns a screenshot.

Install sharp in root `package.json` dependencies. The extension resolves non-bundled packages from node_modules via jiti's standard resolution — same as playwright.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Image dimension extraction | `sharp(buf).metadata()` → `{ width, height }` | Replaces fragile manual JPEG SOF marker scanning and PNG header parsing |
| Image resizing | `sharp(buf).resize(w, h, { fit: 'inside' }).toBuffer()` | Replaces canvas-in-browser approach that requires a live page context |
| Format-specific output | `sharp(buf).jpeg({ quality })` / `sharp(buf).png()` | Clean API vs manual canvas toDataURL |

## Existing Code and Patterns

- `src/resources/extensions/browser-tools/capture.ts` — Contains `constrainScreenshot()` (lines 126-182) and `captureErrorScreenshot()` (lines 184-195). Both need modification. The `MAX_SCREENSHOT_DIM = 1568` constant stays.
- `src/resources/extensions/browser-tools/state.ts:342` — ToolDeps interface defines `constrainScreenshot: (page: Page, buffer: Buffer, mimeType: string, quality: number) => Promise<Buffer>`. Signature preserved to avoid cascading changes.
- `src/resources/extensions/browser-tools/tools/navigation.ts` — `browser_navigate` always captures screenshot (lines 55-61). Gate this on a new `screenshot` parameter.
- `src/resources/extensions/browser-tools/tools/screenshot.ts` — `browser_screenshot` calls `deps.constrainScreenshot(p, ...)`. No changes needed — just works with new internals.
- `src/resources/extensions/browser-tools/tools/navigation.ts` — `browser_reload` also captures screenshot (lines 197-204). Keep this behavior — reload's description promises a screenshot.

## Constraints

- **ToolDeps signature stability** — `constrainScreenshot` signature includes `page: Page` as first parameter. Changing it would require updates to state.ts (ToolDeps), index.ts (wiring), screenshot.ts, navigation.ts (2 places), and capture.ts (captureErrorScreenshot). Keep the parameter, ignore it internally.
- **sharp is a native addon** — Uses prebuilt platform-specific binaries (`@img/sharp-*`). npm handles this automatically. In the Bun binary distribution, jiti falls through to node_modules resolution for non-virtualModule packages, same as playwright.
- **No page context needed** — The whole point of R020 is removing the `page.evaluate` dependency. After this change, `constrainScreenshot` can be called without a browser page being in a usable state (edge case: page crashed but we still have a buffer to resize).
- **MAX_SCREENSHOT_DIM = 1568** — Anthropic API cap. This constant stays unchanged.

## Common Pitfalls

- **Re-encoding small images** — If we naively pipe everything through sharp's resize pipeline, images already within bounds get re-encoded (quality loss, wasted CPU). Must check dimensions first and return original buffer untouched.
- **JPEG quality parameter range** — sharp uses 1-100, same as the current code. Canvas toDataURL uses 0-1 fractional. The current code already divides by 100 for canvas (`q / 100`). With sharp, pass quality directly.
- **PNG quality** — PNG is lossless, so the `quality` parameter doesn't apply to PNG output. sharp's `.png()` accepts `compressionLevel` (0-9) instead. For PNGs, just call `.png()` without quality.
- **Format detection** — Must output the same format as input (JPEG → JPEG, PNG → PNG). Use the existing `mimeType` parameter to branch.

## Open Risks

- **sharp install on CI / Bun binary** — sharp's prebuilt binaries cover macOS (x64, arm64) and Linux (x64, arm64). If the project distributes as a Bun-compiled binary, sharp's native addon must be available in the runtime environment. Playwright has the same constraint and already works, so this should be fine. Monitor first install for platform issues.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| sharp | No directly relevant professional skill | none found — low install count generic image skills only |
| Playwright | Already in available_skills (browser tools are the context) | n/a |

## Sources

- sharp resize API: `fit: 'inside'` preserves aspect ratio within bounds (source: sharp docs via Context7)
- sharp metadata API: `sharp(input).metadata()` returns `{ width, height, format, ... }` without decoding pixels (source: sharp docs via Context7)
- sharp JPEG output: `sharp(input).jpeg({ quality: N })` with quality 1-100 (source: sharp docs via Context7)
