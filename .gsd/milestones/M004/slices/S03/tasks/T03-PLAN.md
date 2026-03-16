---
estimated_steps: 4
estimated_files: 1
---

# T03: Port prompt-db tests and run full verification

**Slice:** S03 — Surgical Prompt Injection + Dual-Write
**Milestone:** M004

## Description

Port the `prompt-db.test.ts` test file from the memory-db reference worktree and run the full verification suite to confirm all S03 work is correct and no regressions.

## Steps

1. **Copy `prompt-db.test.ts` from memory-db reference.** Source: `.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/prompt-db.test.ts` (385 lines). Destination: `src/resources/extensions/gsd/tests/prompt-db.test.ts`. The file uses `createTestContext` from `test-helpers.ts` and imports from `gsd-db.ts` and `context-store.ts` — both already present from S01.

2. **Verify import paths.** The reference file imports with `.ts` extensions (e.g., `from '../gsd-db.ts'`, `from './test-helpers.ts'`). These should work with the `resolve-ts.mjs` loader that strips type annotations. Confirm the test-helpers import path matches the actual file location.

3. **Run the new test file:**
   ```bash
   node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/prompt-db.test.ts
   ```
   Expected: all assertions pass (the test exercises query+format+wrap patterns at the DB layer level, not the full prompt builders).

4. **Run the full test suite** to verify zero regressions:
   ```bash
   node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-db.test.ts src/resources/extensions/gsd/tests/context-store.test.ts src/resources/extensions/gsd/tests/worktree-db.test.ts src/resources/extensions/gsd/tests/md-importer.test.ts src/resources/extensions/gsd/tests/db-writer.test.ts src/resources/extensions/gsd/tests/prompt-db.test.ts
   ```
   And TypeScript: `npx tsc --noEmit`

   If any test fails, investigate and fix — the most likely cause would be import path differences between the memory-db worktree and current M004 layout.

## Must-Haves

- [ ] `prompt-db.test.ts` ported and all assertions pass
- [ ] Tests cover: scoped decisions queries, scoped requirements queries, project query, formatted output wrapping, fallback when DB unavailable
- [ ] All S01+S02 tests still pass (zero regressions)
- [ ] `npx tsc --noEmit` clean

## Verification

- `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/prompt-db.test.ts` — all pass
- `npx tsc --noEmit` — clean
- Full DB test suite (S01+S02+S03 tests): all pass

## Inputs

- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/prompt-db.test.ts` — reference test file (385 lines)
- `src/resources/extensions/gsd/tests/test-helpers.ts` — existing test helper with `createTestContext()`
- `src/resources/extensions/gsd/gsd-db.ts` — S01 output, provides `openDatabase`, `closeDatabase`, `isDbAvailable`, `insertDecision`, `insertRequirement`, `insertArtifact`
- `src/resources/extensions/gsd/context-store.ts` — S01 output, provides query and format functions
- T01 output (DB-aware helpers in `auto-prompts.ts`) and T02 output (lifecycle wiring in `auto.ts`) — the tests validate the helper pattern, not the wiring directly

## Observability Impact

- **Test coverage signal**: 52 assertions across 7 test sections validate the DB-aware helper pattern (scoped queries, formatting, wrapping, fallback, re-import). Test failure count serves as the primary regression indicator.
- **Inspection**: Run `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/prompt-db.test.ts` — output shows pass/fail per section with `=== prompt-db: <section> ===` headers.
- **Failure state**: Test failures produce `FAIL: <message>` on stderr with expected vs actual values. Exit code 1 on any failure.

## Expected Output

- `src/resources/extensions/gsd/tests/prompt-db.test.ts` — new test file, ~385 lines, proving DB-aware helper patterns work correctly
