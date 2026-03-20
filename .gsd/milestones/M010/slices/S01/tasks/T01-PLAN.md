---
estimated_steps: 2
estimated_files: 1
---

# T01: Fix auto.ts syntax error blocking test suite

**Slice:** S01 — Hardened milestone discovery and deriveState ghost rejection
**Milestone:** M010

## Description

The duplicate `const unit = const unit =` at auto.ts line 1747 prevents any test that transitively imports auto.ts from compiling. This was fixed in M009's main branch but is still present in this worktree copy. Fix the syntax error so the test suite can run.

## Steps

1. Replace the duplicated `const unit = const unit = snapshotUnitMetrics(...)` line with the correct single assignment
2. Remove the duplicate `if (unit) persistUnitMetrics(basePath, unit);` on the following line
3. Verify compilation

## Must-Haves

- [ ] auto.ts compiles without syntax errors
- [ ] No behavioral change — same metrics snapshot logic

## Verification

- `npx tsx -e "import './src/resources/extensions/gsd/auto.ts'"` exits 0

## Inputs

- `src/resources/extensions/gsd/auto.ts` — line 1747 has the duplicate declaration

## Expected Output

- `src/resources/extensions/gsd/auto.ts` — syntax error fixed, compiles cleanly
