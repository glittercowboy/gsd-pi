---
id: T02
parent: S02
milestone: M001
provides:
  - collectOneSecret() accepts optional guidance parameter and renders numbered dim guidance steps
  - execute() threads item.guidance through to collectOneSecret()
  - collectOneSecretWithGuidance exported wrapper for test access
key_files:
  - src/resources/extensions/get-secrets-from-user.ts
  - src/resources/extensions/gsd/tests/collect-from-manifest.test.ts
key_decisions:
  - Exported collectOneSecretWithGuidance as a const alias of the private collectOneSecret for test access rather than making collectOneSecret itself public
  - Fixed test scaffolding static import of files.ts to use dynamic loadFilesExports() to avoid cascading failure from paths.js resolution
  - Added terminal mock ({rows, columns}) to all test mockTui objects since Editor.render accesses tui.terminal.rows
patterns_established:
  - wrapTextWithAnsi returns string[] (not string) — no .split("\n") needed
  - loadFilesExports() async helper pattern for tests needing formatSecretsManifest/parseSecretsManifest without static import chain
observability_surfaces:
  - none (TUI-only change)
duration: 12min
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T02: Enhance collectOneSecret with guidance and thread through execute

**Added optional guidance parameter to collectOneSecret(), rendering numbered dim-styled guidance steps with line wrapping, and threaded item.guidance from execute() call site.**

## What Happened

1. Added `wrapTextWithAnsi` to the `@mariozechner/pi-tui` import in `get-secrets-from-user.ts`.
2. Added `guidance?: string[]` as the sixth optional parameter to `collectOneSecret()`.
3. In the `render()` function, added guidance rendering between the hint and preview sections. Each step renders as `  N. step text` styled with `theme.fg("dim", ...)`. Long steps wrap using `wrapTextWithAnsi(step, width - 4)` — continuation lines get the same indent as the first line's content.
4. Updated the `execute()` call site to pass `item.guidance` as the sixth argument.
5. Exported `collectOneSecretWithGuidance` as a const alias of `collectOneSecret` for test access.
6. Fixed test scaffolding: converted static `import { formatSecretsManifest, parseSecretsManifest }` to async `loadFilesExports()` helper to avoid cascading failure from `files.ts → paths.js` module resolution. Made `writeManifestFile` async. Added `terminal: { rows: 24, columns: 80 }` to all mock tui objects since `Editor.render` accesses `tui.terminal.rows`.

## Verification

- `npm run build` — exits 0, no errors
- `node --test src/resources/extensions/gsd/tests/secure-env-collect.test.ts` — 12/12 pass (no regressions)
- `node --test src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — 3/9 pass (guidance tests 6-8 pass; tests 1-5, 9 are T03 orchestrator tests that expectedly fail with "not exported" messages)
- `grep "item.guidance"` in execute confirms threading at line 324

### Slice-level verification status (intermediate task — partial pass expected):
- ✅ `npm run build` passes
- ✅ `node --test src/resources/extensions/gsd/tests/secure-env-collect.test.ts` — 12/12 pass
- ✅ Guidance lines included in collectOneSecret render output (test 6)
- ✅ Long guidance wraps not truncates (test 7)
- ✅ No guidance = no guidance section (test 8)
- ⬜ Orchestrator categorization tests (T03)
- ⬜ Existing keys excluded from collection (T03)
- ⬜ Manifest status update after collection (T03)
- ⬜ showSecretsSummary render tests (T03)
- ⬜ Structured result shape test (T03)

## Diagnostics

Read `collectOneSecret()` signature (line ~150) to confirm guidance parameter. Check render function (~line 215) for guidance rendering block. Grep `item.guidance` to confirm execute threading.

## Deviations

- Fixed test scaffolding static import issue: `files.ts` statically imports `paths.js` which doesn't resolve when running raw .ts test files. Converted to dynamic `loadFilesExports()` helper. This was a pre-existing issue in the T01 scaffolding that blocked all 9 tests from running.
- Added `terminal: { rows: 24, columns: 80 }` to mock tui objects — `Editor.render()` requires `tui.terminal.rows` which the original mocks lacked.
- `wrapTextWithAnsi` returns `string[]` not `string` — adjusted implementation accordingly (no `.split("\n")` needed).

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/get-secrets-from-user.ts` — Added `wrapTextWithAnsi` import, `guidance` parameter to `collectOneSecret()`, guidance rendering in render function, threading in execute(), exported `collectOneSecretWithGuidance` alias
- `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — Fixed static import to dynamic `loadFilesExports()`, made `writeManifestFile` async, added terminal mock to all mockTui objects
