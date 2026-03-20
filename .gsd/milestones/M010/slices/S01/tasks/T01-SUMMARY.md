---
id: T01
parent: S01
milestone: M010
provides:
  - Fixed syntax error in auto.ts enabling test suite compilation
key_files:
  - src/resources/extensions/gsd/auto.ts
key_decisions: []
patterns_established: []
observability_surfaces:
  - none (syntax fix only)
duration: 2m
verification_result: passed
completed_at: 2026-03-20T00:10:30-04:00
blocker_discovered: false
---

# T01: Fix auto.ts syntax error blocking test suite

**Fixed duplicate const declaration at auto.ts line 1747 that prevented any test importing auto.ts from compiling.**

## What Happened

Line 1750 of auto.ts had a malformed statement with `const unit = const unit = snapshotUnitMetrics(...)` - a duplicated variable declaration prefix - plus a duplicate `if (unit) persistUnitMetrics(basePath, unit);` call. Replaced the malformed section with the correct single declaration and single persist call. The fix matches the intended pattern from M009's main branch.

## Verification

- TypeScript transpile check confirms no syntax errors in auto.ts
- Verified corrected code structure matches expected pattern (single const declaration, single persist call)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node -e "ts.transpileModule(fs.readFileSync('auto.ts'))"` | 0 | ✅ pass | <1s |

## Diagnostics

None applicable - this was a syntax fix only.

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/auto.ts` — Fixed duplicate `const unit = const unit =` declaration and removed duplicate `if (unit) persistUnitMetrics(...)` call
