---
estimated_steps: 4
estimated_files: 2
---

# T02: Add rebuildState regression guard

**Slice:** S02 — Doctor lineage audit and STATE.md regression guard
**Milestone:** M010

## Description

Add an advisory guard in `rebuildState` that detects when the derived active milestone doesn't match the current worktree's branch lineage. If a mismatch is detected, log a warning. This prevents silent regression where STATE.md is overwritten with an incorrect active milestone.

## Steps

1. In `doctor.ts` `rebuildState()`, after `deriveState()` returns, detect the current git branch name (check for `milestone/<MID>` pattern).
2. If the branch implies milestone X but `deriveState` returned milestone Y (where Y is numerically earlier), log a warning: "rebuildState: derived active milestone {Y} differs from worktree lineage {X} — possible regression".
3. Write a diagnostic comment into STATE.md when a mismatch is detected.
4. Add a unit test simulating the mismatch scenario.

## Must-Haves

- [ ] Warning logged when derived active milestone differs from worktree branch lineage
- [ ] STATE.md still written (guard is advisory, not blocking)
- [ ] Unit test covers the mismatch detection

## Verification

- Unit test with mocked branch name passes
- `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — regression guard test passes

## Observability Impact

**Runtime signals:** When `rebuildState` detects a lineage mismatch, it logs a warning to stderr with format: `rebuildState: derived active milestone {Y} differs from worktree lineage {X} — possible regression`.

**STATE.md diagnostic comment:** When a mismatch is detected, the written STATE.md includes a comment block documenting the detected regression:
```markdown
> ⚠️ **Regression Guard:** Worktree branch implies milestone M010 but derived state shows M001 as active.
```

**Inspection:** A future agent can inspect STATE.md to see if a regression guard warning was written. If the comment block is present, it indicates the state derivation may have returned an incorrect active milestone.

**Failure visibility:** The warning is advisory (not blocking) — STATE.md is still written, but with the diagnostic comment. This allows recovery while preserving evidence of potential corruption.

## Expected Output

- `src/resources/extensions/gsd/doctor.ts` — regression guard in rebuildState
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — guard test
