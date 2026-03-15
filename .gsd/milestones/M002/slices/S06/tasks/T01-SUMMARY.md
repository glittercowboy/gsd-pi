---
id: T01
parent: S06
milestone: M002
provides:
  - Unit test infrastructure for browser-tools using jiti + node:test
  - 63 passing test cases covering pure functions, state accessors, and constrainScreenshot
key_files:
  - src/resources/extensions/browser-tools/tests/browser-tools-unit.test.cjs
  - package.json
key_decisions:
  - Used jiti for CJS-based TypeScript imports — the resolve-ts ESM hook breaks on core.js (plain .js file)
  - Test file is .cjs to avoid ESM module resolution issues with jiti
  - constrainScreenshot tested with null as _page param since S03 made it pure buffer-in/buffer-out
patterns_established:
  - jiti import pattern for browser-tools tests: `const jiti = require('jiti')(__filename, { interopDefault: true, debug: false }); const mod = jiti('../module.ts');`
  - Synthetic sharp buffers for image processing tests
observability_surfaces:
  - none
duration: 12m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T01: Unit tests for Node-side pure functions, state accessors, and constrainScreenshot

**Created browser-tools test infrastructure and 63 unit tests covering all pure Node-side functions, state accessor round-trips, and constrainScreenshot image processing.**

## What Happened

Installed jiti as a devDependency, created the `tests/` directory under browser-tools, and wrote a comprehensive CJS test file. Tests cover:

- **parseRef** (5 tests): versioned refs, legacy format, case insensitivity, whitespace handling
- **formatVersionedRef** (2 tests): basic formatting, version 0 edge case
- **staleRefGuidance** (1 test): message content verification
- **formatCompactStateSummary** (3 tests): full state, empty focus, dialog present
- **verificationFromChecks** (3 tests): pass, fail, multiple passing
- **verificationLine** (1 test): single-line format
- **sanitizeArtifactName** (7 tests): valid names, special chars, empty, whitespace, dots/underscores
- **isCriticalResourceType** (7 tests): document/fetch/xhr true, image/font/stylesheet/script false
- **getUrlHash** (3 tests): with hash, without hash, invalid URL
- **firstErrorLine** (5 tests): Error object, string, null, undefined, empty message
- **formatArtifactTimestamp** (1 test): ISO format with dash replacements
- **EVALUATE_HELPERS_SOURCE** (10 tests): parseable via `new Function()`, contains all 9 pi.* function assignments
- **State accessors** (10 tests): round-trip for all 10 accessor pairs
- **resetAllState** (1 test): clears all state back to defaults
- **constrainScreenshot** (4 tests): small JPEG passthrough, oversized JPEG resize, oversized PNG resize, height-only overflow

Added `test:browser-tools` npm script to package.json.

## Verification

- `npm run test:browser-tools` exits 0
- 63 tests pass, 0 fail, 15 suites, ~530ms total

## Diagnostics

None — pure unit tests with no runtime surfaces.

## Deviations

- Fixed test for `firstErrorLine({})` — initially expected "unknown error" but the function correctly returns "[object Object]" since `{}` is truthy and `String({})` produces that. Added a separate test for `{ message: "" }` which does return "unknown error".

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/browser-tools/tests/browser-tools-unit.test.cjs` — 63 unit tests across 15 describe blocks
- `package.json` — added `test:browser-tools` script

## Slice Verification Status

- ✅ `npm run test:browser-tools` exits 0 with all tests passing
- ✅ Unit test file exists: `src/resources/extensions/browser-tools/tests/browser-tools-unit.test.cjs`
- ⬜ Integration test file: `src/resources/extensions/browser-tools/tests/browser-tools-integration.test.mjs` (T02)
