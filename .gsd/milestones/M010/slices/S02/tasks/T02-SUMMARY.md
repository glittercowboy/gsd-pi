---
id: T02
parent: S02
milestone: M010
provides:
  - Regression guard in rebuildState that detects branch/milestone mismatches
  - STATE.md diagnostic comment when potential regression is detected
  - Console warning when derived active milestone differs from worktree branch lineage
key_files:
  - src/resources/extensions/gsd/doctor.ts
  - src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts
key_decisions:
  - Chose to write the warning to STATE.md as a diagnostic comment (not block the write)
  - Used numeric comparison of milestone IDs (M010 → 10) to detect regressions
  - Only trigger warning when branch is milestone/<MID> and derived milestone is numerically earlier
patterns_established:
  - rebuildState now inspects git branch context to detect potential state derivation regressions
  - Advisory guards that preserve write semantics while surfacing diagnostics
observability_surfaces:
  - STATE.md contains `> ⚠️ **Regression Guard:** ...` comment when mismatch detected
  - Console warning: `rebuildState: derived active milestone {Y} differs from worktree lineage {X} — possible regression`
duration: 20m
verification_result: passed
completed_at: 2026-03-20T04:30:00Z
blocker_discovered: false
---

# T02: Add rebuildState regression guard

**Added advisory regression guard in rebuildState that detects and warns when derived active milestone differs from worktree branch lineage.**

## What Happened

The task implemented a regression guard in the `rebuildState()` function that:

1. **Detects milestone branch context**: After `deriveState()` returns, the function checks if the current git branch matches the `milestone/<MID>` pattern (e.g., `milestone/M010`, `milestone/M010-abc123`).

2. **Compares numeric milestone IDs**: Extracts numeric values from milestone IDs (M010 → 10, M001 → 1) and compares them. A warning is triggered when the derived active milestone is numerically earlier than the branch's implied milestone.

3. **Logs warning to console**: Uses `console.warn()` to output a message like: `rebuildState: derived active milestone M010 differs from worktree lineage M020 — possible regression`

4. **Writes diagnostic comment to STATE.md**: When a mismatch is detected, the STATE.md file includes a warning comment block:
   ```markdown
   > ⚠️ **Regression Guard:** Worktree branch implies milestone M020 but derived state shows M010 as active.
   ```

5. **Preserves write semantics**: The guard is advisory, not blocking — STATE.md is always written, even when a regression is detected.

Three unit tests were added covering:
- Mismatch scenario (branch M020, derived M010) — warning emitted
- Match scenario (branch M010, derived M010) — no warning
- Non-milestone branch (main) — no warning

## Verification

- All 56 tests in `ghost-milestone-regression.test.ts` pass including the 3 new regression guard tests
- All 42 tests in `factcheck-*.test.ts` pass with no regressions
- Console warning output verified in test run

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` | 0 | ✅ pass | 2.1s |
| 2 | `npx tsx --test 'src/resources/extensions/gsd/tests/factcheck-*.test.ts'` | 0 | ✅ pass | 2.1s |

## Diagnostics

To inspect the regression guard diagnostics after this change:
- Run `gsd doctor` or any command that triggers `rebuildState`
- Check STATE.md for a `> ⚠️ **Regression Guard:**` comment block
- Look for console warning output: `rebuildState: derived active milestone ... differs from worktree lineage ... — possible regression`
- The warning only appears when branch implies a later milestone than deriveState returns

## Deviations

None. Implementation followed the task plan exactly.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/doctor.ts` — Added `nativeGetCurrentBranch` import, modified `buildStateMarkdown()` to accept optional `regressionWarning` parameter, modified `rebuildState()` to detect branch/milestone mismatches and log warnings
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — Added imports for `readFileSync`, `execSync`, `nativeInit`, `nativeGetCurrentBranch`, `nativeIsRepo`, and `rebuildState`; added 3 test cases for regression guard scenarios