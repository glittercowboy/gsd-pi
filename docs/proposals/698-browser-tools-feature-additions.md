# Browser-Tools Feature Additions — Implementation Requirements

> Ref: [#698](https://github.com/gsd-build/gsd-2/issues/698)
> Status: **Shipped** — all 10 features implemented and merged to main

## Current State

Browser-tools shipped **47 tools** across 10 modules (~8,300 lines) at the time this proposal was written. After implementation of these 10 features, the tool count expanded with 13 additional tools (some features map to multiple tools).

Key existing capabilities at proposal time: `browser_navigate`, `browser_click`, `browser_evaluate`, `browser_assert`, `browser_diff`, `browser_batch`, `browser_find_best`, `browser_act`, `browser_trace_start/stop`, `browser_export_har`, `browser_set_viewport`, `browser_screenshot`, `browser_snapshot_refs`.

**Implemented tools** (shipped in main): `browser_save_pdf`, `browser_save_state`, `browser_restore_state`, `browser_mock_route`, `browser_block_urls`, `browser_clear_routes`, `browser_emulate_device`, `browser_extract`, `browser_visual_diff`, `browser_zoom_region`, `browser_generate_test`, `browser_check_injection`, `browser_action_cache`.

---

## Feature 1: Structured Data Extraction with Schema Validation

**Tool:** `browser_extract`

### What it does
Accept a JSON Schema (or simplified shape description), extract matching structured data from the current page, validate against the schema, return typed JSON.

### Implementation requirements

| Item | Details |
|---|---|
| **New file** | `tools/extract.ts` |
| **Playwright API** | `page.evaluate()` — runs extraction logic in-page |
| **Schema validation** | Use `@sinclair/typebox` (already a dependency) for schema definition; `ajv` or inline validation for runtime checking |
| **Extraction strategy** | 1. Convert page to accessibility tree or clean text via existing `browser_get_accessibility_tree` / `browser_get_page_source` infrastructure. 2. Use `page.evaluate()` to run CSS selector-based extraction. 3. For complex extraction, pass schema + page content to the LLM via tool result and let the agent extract (Stagehand approach) |
| **Tool signature** | `browser_extract({ schema: JSONSchema, selector?: string, multiple?: boolean })` → `{ data: T, validationErrors?: string[] }` |
| **Dependencies** | None new — Typebox already available, `page.evaluate` is Playwright core |
| **Estimated effort** | **16–24 hours** |
| **Risk** | Medium — extraction quality depends heavily on page structure; may need multiple strategies (DOM-based, a11y-tree-based, LLM-assisted) |

### Acceptance criteria
- [ ] Extracts data matching a provided JSON schema from a page
- [ ] Returns validation errors when extracted data doesn't match schema
- [ ] Supports scoping extraction to a CSS selector
- [ ] Supports extracting arrays of items (`multiple: true`)
- [ ] Handles pages with dynamic content (waits for network idle before extraction)

---

## Feature 2: Session State Persistence & Restoration

**Tools:** `browser_save_state`, `browser_restore_state`

### What it does
Save cookies, localStorage, sessionStorage, and auth tokens to disk. Restore them on a subsequent browser session to resume authenticated state without re-logging in.

### Implementation requirements

| Item | Details |
|---|---|
| **New tools in** | `tools/session.ts` (extend existing file) |
| **Playwright API** | `context.storageState()` for cookies + localStorage; `page.evaluate()` for sessionStorage (not included in Playwright's storageState) |
| **Storage location** | Session artifacts directory: `.gsd/browser-state/<name>.json` |
| **Tool signatures** | `browser_save_state({ name?: string })` → `{ path, cookieCount, localStorageOrigins }` / `browser_restore_state({ name?: string })` → `{ restored, cookieCount }` |
| **Restore mechanism** | `browser.newContext({ storageState: path })` for new sessions; `context.addCookies()` + `page.evaluate()` for mid-session restore |
| **Security** | State files may contain auth tokens — add to `.gitignore` pattern, warn in tool output |
| **Dependencies** | None new — all Playwright core APIs |
| **Estimated effort** | **8–12 hours** |
| **Risk** | Low — Playwright's `storageState()` is well-tested; sessionStorage requires extra handling |

### Acceptance criteria
- [ ] Saves cookies + localStorage via `context.storageState()`
- [ ] Saves sessionStorage via `page.evaluate()` (per-origin)
- [ ] Restores state on new browser context launch
- [ ] Restores state mid-session (cookies + evaluate injection)
- [ ] State files written to `.gsd/browser-state/` and gitignored
- [ ] Tool output shows count of restored items, never displays secret values

---

## Feature 3: Test Code Generation from Session

**Tool:** `browser_generate_test`

### What it does
Record agent interactions during a browser session and emit a Playwright test script. Turns AI-driven exploration into deterministic, reproducible tests.

### Implementation requirements

| Item | Details |
|---|---|
| **New file** | `tools/codegen.ts` |
| **Data source** | Action timeline (already tracked in `state.ts`) + trace data from `browser_trace_start/stop` |
| **Code generation** | Transform timeline entries (navigate, click, type, assert) into Playwright test syntax: `await page.goto(...)`, `await page.click(...)`, `await expect(page.locator(...)).toBeVisible()` |
| **Tool signature** | `browser_generate_test({ name?: string, includeAssertions?: boolean })` → `{ path, actionCount, testCode }` |
| **Output format** | Standard Playwright test file (`*.spec.ts`) written to project's test directory or session artifacts |
| **Selector strategy** | Prefer stable selectors: `getByRole` > `getByText` > CSS selector (use ref metadata for best selectors) |
| **Dependencies** | None new — reads from existing timeline/trace infrastructure |
| **Estimated effort** | **20–30 hours** |
| **Risk** | High — generated selectors may be brittle; action timeline may not capture all nuances (hover timing, scroll position, wait conditions); output quality varies significantly by page complexity |

### Acceptance criteria
- [ ] Generates a runnable Playwright test from a recorded session
- [ ] Includes navigation, click, type, and assertion actions
- [ ] Uses stable selectors (role-based preferred over CSS)
- [ ] Generated test passes when run against the same page state
- [ ] Writes test file to configurable output path

---

## Feature 4: Network Request Interception & Mocking

**Tools:** `browser_mock_route`, `browser_block_urls`, `browser_clear_routes`

### What it does
Intercept network requests to mock API responses, block URLs (analytics, ads), simulate error conditions (500s, timeouts, slow responses).

### Implementation requirements

| Item | Details |
|---|---|
| **New file** | `tools/network-mock.ts` |
| **Playwright API** | `page.route(urlPattern, handler)` for interception; `route.fulfill()` for mock responses; `route.abort()` for blocking |
| **Tool signatures** | `browser_mock_route({ url: string, status?: number, body?: string, headers?: Record })` / `browser_block_urls({ patterns: string[] })` / `browser_clear_routes()` |
| **State tracking** | Track active routes in module state for cleanup and listing |
| **Dependencies** | None new — Playwright core API |
| **Estimated effort** | **12–16 hours** |
| **Risk** | Low — Playwright's route API is mature and well-documented |

### Acceptance criteria
- [ ] Mock API responses with custom status, body, and headers
- [ ] Block requests matching URL patterns (glob or regex)
- [ ] Simulate slow responses with configurable delay
- [ ] Clear all active routes
- [ ] List active routes for debugging
- [ ] Routes survive page navigation within the same context

---

## Feature 5: Device Emulation Presets

**Tool:** `browser_emulate_device`

### What it does
One-call device simulation: viewport + user agent + touch + device scale factor. Wraps Playwright's device descriptors.

### Implementation requirements

| Item | Details |
|---|---|
| **Extend** | `tools/interaction.ts` (alongside `browser_set_viewport`) or new `tools/device.ts` |
| **Playwright API** | `playwright.devices['iPhone 15']` → `{ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch }` applied via context recreation or page emulation |
| **Tool signature** | `browser_emulate_device({ device: string })` → `{ device, viewport, userAgent, isMobile }` |
| **Device list** | Expose Playwright's built-in device descriptors (~100 devices); accept fuzzy matching on device name |
| **Limitation** | Some properties (userAgent, isMobile) can only be set at context creation — may require context restart |
| **Dependencies** | None new — Playwright ships device descriptors |
| **Estimated effort** | **6–10 hours** |
| **Risk** | Low-Medium — context restart for full emulation changes the page state; partial emulation (viewport only) is simpler but less accurate |

### Acceptance criteria
- [ ] Accept device name (e.g., "iPhone 15", "Pixel 7") and configure full emulation
- [ ] Support fuzzy matching on device name with suggestions on no match
- [ ] Set viewport, user agent, device scale factor, touch, and mobile flag
- [ ] Warn when context restart is required and confirm with user

---

## Feature 6: Visual Diffing (Screenshot Comparison)

**Tool:** `browser_visual_diff`

### What it does
Compare two screenshots pixel-by-pixel, return a diff image and similarity score.

### Implementation requirements

| Item | Details |
|---|---|
| **New file** | `tools/visual-diff.ts` |
| **Comparison library** | `pixelmatch` (lightweight, ~200 lines, MIT) or Playwright's built-in `expect(page).toHaveScreenshot()` comparison |
| **Tool signature** | `browser_visual_diff({ baseline?: string, current?: string, threshold?: number })` → `{ match: boolean, similarity: number, diffPixels: number, diffImagePath?: string }` |
| **Baseline management** | Save baselines to `.gsd/browser-baselines/`; auto-name by URL + viewport |
| **Dependencies** | `pixelmatch` + `pngjs` (new deps, ~50KB total) or use Playwright's built-in comparator |
| **Estimated effort** | **10–14 hours** |
| **Risk** | Medium — anti-aliasing and dynamic content (timestamps, ads) cause false positives; threshold tuning needed |

### Acceptance criteria
- [ ] Compare current page screenshot against a stored baseline
- [ ] Return similarity score (0–1) and diff pixel count
- [ ] Generate diff image highlighting changed regions
- [ ] Configurable threshold for pass/fail
- [ ] Support element-scoped comparison (crop to selector)

---

## Feature 7: PDF Generation

**Tool:** `browser_save_pdf`

### What it does
Render current page as PDF artifact.

### Implementation requirements

| Item | Details |
|---|---|
| **Extend** | `tools/screenshot.ts` or new `tools/pdf.ts` |
| **Playwright API** | `page.pdf({ path, format, printBackground })` — Chromium only (already our engine) |
| **Tool signature** | `browser_save_pdf({ filename?: string, format?: string, printBackground?: boolean })` → `{ path, pageCount, sizeBytes }` |
| **Output location** | Session artifacts directory |
| **Dependencies** | None — Playwright core API |
| **Estimated effort** | **3–5 hours** |
| **Risk** | Low — straightforward Playwright wrapper |

### Acceptance criteria
- [ ] Generate PDF from current page
- [ ] Support A4/Letter/custom page formats
- [ ] Include background graphics option
- [ ] Write to session artifacts with configurable filename
- [ ] Return file path and size

---

## Feature 8: Region Zoom / Targeted High-Res Capture

**Tool:** `browser_zoom_region`

### What it does
Capture and upscale a specific rectangular region for detailed inspection of dense UIs.

### Implementation requirements

| Item | Details |
|---|---|
| **Extend** | `tools/screenshot.ts` |
| **Playwright API** | `page.screenshot({ clip: { x, y, width, height } })` for region capture; upscale via `sharp` or return at native device pixel ratio |
| **Tool signature** | `browser_zoom_region({ x, y, width, height, scale?: number })` → screenshot image |
| **Dependencies** | Optional `sharp` for upscaling, or rely on Playwright's deviceScaleFactor |
| **Estimated effort** | **4–6 hours** |
| **Risk** | Low |

### Acceptance criteria
- [ ] Capture arbitrary rectangular region by coordinates
- [ ] Support scale factor for upscaling (2x, 3x)
- [ ] Return as inline image (same as `browser_screenshot`)

---

## Feature 9: Action Caching / Replay (Lower Priority)

**Tool:** Internal optimization, not a user-facing tool

### Implementation requirements

| Item | Details |
|---|---|
| **Cache key** | URL + DOM structure hash → selector mapping |
| **Storage** | In-memory LRU cache with optional disk persistence |
| **Integration point** | `browser_find_best` / `browser_act` — check cache before LLM resolution |
| **Estimated effort** | **12–18 hours** |
| **Risk** | Medium — cache invalidation when page structure changes; stale selectors cause silent failures |

---

## Feature 10: Prompt Injection Detection (Lower Priority)

**Tool:** `browser_check_injection`

### Implementation requirements

| Item | Details |
|---|---|
| **Detection strategy** | Regex/keyword scan on screenshot OCR text or page text content for known injection patterns ("ignore previous", "system prompt", "you are now") |
| **Integration point** | Optional auto-check after `browser_screenshot` or `browser_navigate` |
| **Estimated effort** | **8–12 hours** |
| **Risk** | Medium — false positives on legitimate content; OCR adds latency; determined adversaries can evade keyword detection |

---

## Summary — Effort & Priority Matrix

| # | Feature | Priority | Effort | New Deps | Risk |
|---|---|---|---|---|---|
| 1 | Structured data extraction | High | 16–24h | None | Medium |
| 2 | Session state persistence | High | 8–12h | None | Low |
| 3 | Test code generation | High | 20–30h | None | High |
| 4 | Network interception/mocking | High | 12–16h | None | Low |
| 5 | Device emulation presets | Medium | 6–10h | None | Low-Med |
| 6 | Visual diffing | Medium | 10–14h | pixelmatch (~50KB) | Medium |
| 7 | PDF generation | Medium | 3–5h | None | Low |
| 8 | Region zoom capture | Medium | 4–6h | Optional sharp | Low |
| 9 | Action caching | Lower | 12–18h | None | Medium |
| 10 | Prompt injection detection | Lower | 8–12h | None | Medium |
| | **Total** | | **~100–150h** | | |

## Recommended Implementation Order

1. **PDF generation** (Feature 7) — smallest, zero deps, immediate utility, good warmup
2. **Session state persistence** (Feature 2) — high value, low risk, moderate effort
3. **Network interception** (Feature 4) — high value, low risk, Playwright API is mature
4. **Region zoom** (Feature 8) — small effort, extends existing screenshot tool
5. **Device emulation** (Feature 5) — moderate effort, extends existing viewport tool
6. **Structured extraction** (Feature 1) — high value but needs design iteration on extraction strategy
7. **Visual diffing** (Feature 6) — useful for UAT, needs threshold tuning
8. **Test code generation** (Feature 3) — high value but high risk, best tackled after timeline infrastructure is battle-tested
9. **Action caching** (Feature 9) — optimization, defer until intent resolution is a proven bottleneck
10. **Prompt injection** (Feature 10) — defensive, defer until production use cases mature

## Notes for Contributors

- All features wrap existing Playwright APIs — no custom browser extensions or CDP hacking needed
- Features 2, 4, 5, 7, 8 are straightforward Playwright wrappers with low implementation risk
- Features 1 and 3 involve more design work — open sub-issues for design discussion before implementation
- Each feature should be a separate PR with its own tests
- Follow the existing tool registration pattern in `index.ts` → `tools/*.ts`
- Use `Type` from `@sinclair/typebox` for tool parameter schemas (existing convention)
- Session artifacts go in the artifacts directory managed by `session.ts`
