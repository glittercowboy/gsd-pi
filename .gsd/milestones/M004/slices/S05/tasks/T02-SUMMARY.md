---
id: T02
parent: S05
milestone: M004
provides:
  - reconcile hook in handleMerge (worktree-command.ts) — covers manual /worktree merge path
  - worktree-db-integration.test.ts with 5 assertions (copy, copy-skip, reconcile, reconcile-skip, reconcile-zero-shape)
key_files:
  - src/resources/extensions/gsd/worktree-command.ts
  - src/resources/extensions/gsd/tests/worktree-db-integration.test.ts
key_decisions:
  - Dynamic import used for reconcileWorktreeDb in handleMerge (async command handler — static import not needed)
  - 5th test case added beyond plan's 4 to cover the structured zero-result shape (failure path observability)
patterns_established:
  - file-presence guard (existsSync wtDbPath && existsSync mainDbPath) before dynamic import reconcile block
  - all DB hooks in command handlers are non-fatal (try/catch swallows)
observability_surfaces:
  - gsd-db: stderr prefix emitted on reconcile failure — grep-able via `node ... 2>&1 | grep "gsd-db:"`
  - reconcileWorktreeDb returns structured { decisions, requirements, artifacts, conflicts } zero-shape on skip
  - post-merge DB queryable via openDatabase(join(basePath, ".gsd", "gsd.db")) + getActiveDecisions()
duration: 20m
verification_result: passed
completed_at: 2026-03-15T22:15:00-06:00
blocker_discovered: false
---

# T02: Wire reconcile into worktree-command.ts + write integration tests

**Wired reconcileWorktreeDb into handleMerge (manual /worktree merge path) and proved copy + reconcile hooks with 10 integration assertions across 5 test cases using real git repos.**

## What Happened

Two pieces of work completed in sequence:

**1. handleMerge reconcile hook (`worktree-command.ts`)**

In the deterministic merge path inside `handleMerge`, inserted a file-presence-guarded reconcile block immediately before the `mergeWorktreeToMain(basePath, name, commitMessage)` call. Uses dynamic `await import("./gsd-db.js")` (appropriate for async command handlers — no static import needed). Guarded by `existsSync(wtDbPath) && existsSync(mainDbPath)`, wrapped in non-fatal try/catch. Pattern is consistent with the T01 reconcile hook in `mergeMilestoneToMain`.

**2. Integration test file (`worktree-db-integration.test.ts`)**

Created with 5 test cases (10 total assertions), following the `auto-worktree.test.ts` scaffold pattern: `createTempRepo()` helper, `savedCwd` saved and restored in finally, temp dir cleanup. The plan specified 4 cases; a 5th was added to explicitly cover the structured zero-result return shape when the worktree DB is absent — this is the key observable failure-path signal.

Test cases:
1. **Copy on create**: seeds `gsd.db` in source, calls `createAutoWorktree`, asserts DB exists in worktree `.gsd/`
2. **Copy skip**: no source DB, `createAutoWorktree` completes without throw, no DB in worktree
3. **Reconcile merges rows**: inserts decision in worktree DB via `upsertDecision`, calls `reconcileWorktreeDb`, opens main DB and asserts row present
4. **Reconcile non-fatal**: calls `reconcileWorktreeDb` with two nonexistent paths — no throw
5. **Zero-result shape**: calls `reconcileWorktreeDb` with absent worktree DB, asserts all four fields (`decisions`, `requirements`, `artifacts`, `conflicts`) are zero — confirms structured return, not undefined/throw

**S05-PLAN.md pre-flight fix**: Added failure-path/diagnostic verification block to the slice Verification section as required.

## Verification

```
# Integration tests — 10 passed, 0 failed
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/worktree-db-integration.test.ts
→ Results: 10 passed, 0 failed

# Existing worktree-db unit tests — 36 passed, 0 failed
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/worktree-db.test.ts
→ Results: 36 passed, 0 failed

# TypeScript — clean
npx tsc --noEmit
→ (no output)

# Full suite — 367 test files pass; pack-install.test.ts fails (pre-existing: dist/ not built in worktree)
npm test
→ 367 pass, 1 pre-existing fail (pack-install.test.ts requires dist/)
```

## Diagnostics

- Reconcile failures in `handleMerge` are silent (swallowed by try/catch) — non-fatal by design
- Reconcile writes to stderr with `gsd-db:` prefix: `gsd-db: reconciled N decisions, M requirements, K artifacts (P conflicts)`
- Inspect post-merge state: `openDatabase(join(basePath, ".gsd", "gsd.db"))` + `getActiveDecisions()` from `context-store.ts`
- `reconcileWorktreeDb` returns structured zero-shape `{ decisions:0, requirements:0, artifacts:0, conflicts:[] }` when worktree DB absent — not undefined, not a throw

## Deviations

Added Test 5 (reconcile returns zero-shape) beyond the plan's 4 test cases. The plan said "≥4 assertions" — this extends it for observability coverage without changing any existing behavior.

## Known Issues

`pack-install.test.ts` fails in the worktree because `dist/` is not built here — pre-existing condition, not introduced by this task.

## Files Created/Modified

- `src/resources/extensions/gsd/worktree-command.ts` — added reconcile block before `mergeWorktreeToMain` in `handleMerge`
- `src/resources/extensions/gsd/tests/worktree-db-integration.test.ts` — new: 5 integration test cases, 10 assertions
- `.gsd/milestones/M004/slices/S05/S05-PLAN.md` — T02 marked done; failure-path diagnostic block added to Verification section
