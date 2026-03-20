---
id: S02
parent: M010
milestone: M010
---

# S02: Doctor lineage audit and STATE.md regression guard — UAT

**Milestone:** M010
**Test Mode:** Artifact-driven (tests verify code contracts, no live runtime)
**Written:** 2026-03-20

## UAT Type

- UAT mode: **artifact-driven**
- Why this mode is sufficient: The slice adds diagnostic outputs and regression guards that are verified through unit tests. No live runtime (server, database, UI) is required — the GSD extension tests verify the contracts.

## Preconditions

- Node.js with tsx installed (`npx tsx`)
- Git repository initialized
- GSD extension source code at `src/resources/extensions/gsd/`

## Smoke Test

```bash
npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts
```

**Expected:** All 77 tests pass, including doctor diagnostic tests, regression guard tests, and e2e test.

## Test Cases

### 1. Doctor diagnostic includes directory contents for empty ghost

1. Create an empty milestone directory `.gsd/milestones/M001/` (no files)
2. Run `runGSDDoctor()` on the project
3. **Expected:** Issue with code `orphaned_milestone_directory` includes message "Directory is empty" and remediation guidance

### 2. Doctor diagnostic includes directory contents for ghost with files

1. Create a milestone directory `.gsd/milestones/M002/` with files `NOTES.md` and `TODO.txt`
2. Run `runGSDDoctor()` on the project
3. **Expected:** Issue with code `orphaned_milestone_directory` includes "Contents: NOTES.md, TODO.txt" and remediation guidance

### 3. Doctor diagnostic truncates long file lists

1. Create a milestone directory `.gsd/milestones/M003/` with 10 files
2. Run `runGSDDoctor()` on the project
3. **Expected:** Issue shows first 5 files followed by "+5 more" overflow indicator

### 4. rebuildState warns when branch implies different milestone

1. Set up a git repo with branch `milestone/M020`
2. Call `deriveState()` which returns M010 as active (simulated via test fixture)
3. Call `rebuildState()` which inspects the branch
4. **Expected:** Console warning logged: `rebuildState: derived active milestone M010 differs from worktree lineage M020 — possible regression`
5. **Expected:** STATE.md contains `> ⚠️ **Regression Guard:**` comment

### 5. rebuildState does NOT warn when branch matches derived milestone

1. Set up a git repo with branch `milestone/M010`
2. Call `deriveState()` which returns M010 as active
3. Call `rebuildState()`
4. **Expected:** No console warning
5. **Expected:** STATE.md has no regression guard comment

### 6. rebuildState does NOT warn when not on milestone branch

1. Set up a git repo with branch `main` or `develop`
2. Call `deriveState()` which returns any milestone
3. Call `rebuildState()`
4. **Expected:** No console warning (non-milestone branches are ignored)

### 7. End-to-end: damaged-state recovery with ghost milestones

1. Create fixture: ghost M001 (empty), ghost M002 (empty), ghost M003 (CONTEXT.md only), real M010 (ROADMAP.md with slices)
2. Initialize git worktree on branch `milestone/M010`
3. Run `runGSDDoctor()`, verify ghost warnings for M001/M002/M003 but NOT for M010
4. Call `deriveState()`, verify M010 is returned as active
5. Call `rebuildState()`, read STATE.md
6. **Expected:** STATE.md shows M010 as active milestone
7. **Expected:** No regression guard warning (branch matches derived)

## Edge Cases

### Edge Case: Non-milestone branch with similar pattern

- Branch named `milestone-fixes` should NOT trigger regression guard (regex requires `milestone/<MID>`)
- **Verification:** Test with branch `milestone-fixes` → no warning expected

### Edge Case: Milestone ID with suffix

- Branch named `milestone/M010-abc123` should extract M010 and compare correctly
- **Verification:** Test with branch M010-abc123 → compare numeric part only

### Edge Case: Very large milestone number

- Branch `milestone/M999` vs derived `M100` should trigger warning
- **Verification:** Numeric comparison handles multi-digit numbers correctly

## Failure Signals

- **Test failure:** If any of the 77 tests fail, the slice is not complete
- **Missing diagnostic:** If `orphaned_milestone_directory` issue lacks file inventory, T01 is broken
- **Missing regression warning:** If console shows no warning when branch M020 vs derived M010, T02 is broken
- **STATE.md missing guard:** If STATE.md doesn't contain regression guard comment when expected, T02 output is broken

## Not Proven By This UAT

- **Live gsd doctor command:** The UAT runs test fixtures, not the actual CLI command. The CLI should work identically but isn't explicitly tested.
- **Performance under load:** The regression guard adds git branch inspection — performance impact is minimal (<50ms) but not benchmarked.
- **Cross-platform git behavior:** Tests run on the current platform; Windows line endings or git variations aren't tested.

## Notes for Tester

- All tests use `npx tsx --test` because the GSD extension has no dist/ build output and uses `.js` imports internally
- The test file `ghost-milestone-regression.test.ts` contains 77 tests — run the full suite to verify
- The console warnings during test execution are intentional and verify the regression guard is working
- The e2e test creates temporary directories that are cleaned up automatically
