---
id: S05
parent: M004
milestone: M004
provides:
  - DB copy hook in copyPlanningArtifacts (auto-worktree.ts)
  - DB reconcile hook in mergeMilestoneToMain (auto-worktree.ts)
  - DB reconcile hook in handleMerge (worktree-command.ts)
  - worktree-db-integration.test.ts — 5 cases, 10 assertions proving copy + reconcile against real git repos
requires:
  - slice: S01
    provides: copyWorktreeDb, reconcileWorktreeDb, isDbAvailable from gsd-db.ts
affects:
  - S07
key_files:
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/worktree-command.ts
  - src/resources/extensions/gsd/tests/worktree-db-integration.test.ts
key_decisions:
  - Copy guard is existsSync(srcDb), not isDbAvailable() — DB connection may not be open during worktree creation but file still exists and can be copied
  - Reconcile guard is isDbAvailable() — reconcile needs an open DB to merge rows
  - Reconcile in mergeMilestoneToMain placed between autoCommitDirtyState and process.chdir while worktreeCwd is still a valid absolute path
  - handleMerge uses dynamic import for reconcileWorktreeDb (async command handler, avoids static import)
  - All DB hooks are non-fatal — try/catch swallows, lifecycle continues on failure
patterns_established:
  - file-presence guard (existsSync) for copy path, isDbAvailable() for reconcile path
  - dynamic import pattern in async command handlers for DB operations
  - non-fatal try/catch wrapping for all DB hooks in worktree lifecycle
observability_surfaces:
  - reconcileWorktreeDb emits "gsd-db: reconciled N decisions, M requirements, K artifacts (P conflicts)" to stderr
  - reconcileWorktreeDb returns structured { decisions, requirements, artifacts, conflicts } zero-shape when worktree DB absent — not undefined, not a throw
  - post-merge DB queryable: openDatabase(join(basePath, ".gsd", "gsd.db")) + getActiveDecisions() from context-store.ts
  - copy failures are silent (non-fatal); absence of gsd.db in worktree indicates copy was skipped or failed
drill_down_paths:
  - .gsd/milestones/M004/slices/S05/tasks/T01-SUMMARY.md
  - .gsd/milestones/M004/slices/S05/tasks/T02-SUMMARY.md
duration: 30m
verification_result: passed
completed_at: 2026-03-15
---

# S05: Worktree DB Isolation

**DB copy wired into `copyPlanningArtifacts` and DB reconcile wired into both merge paths (`mergeMilestoneToMain` and `handleMerge`); proved with 10 integration assertions against real git repos.**

## What Happened

Two tasks, straightforward execution with no deviations.

**T01** added three changes to `auto-worktree.ts`: a static import of `copyWorktreeDb`, `reconcileWorktreeDb`, and `isDbAvailable` from `gsd-db.ts`; a copy block in `copyPlanningArtifacts` guarded by `existsSync(srcDb)` (file presence, not DB availability — the connection may not be open during creation but the file can still be copied); and a reconcile block in `mergeMilestoneToMain` placed between the auto-commit step and the `process.chdir` back to the project root, so `worktreeCwd` remains a valid absolute path. Both blocks are non-fatal.

**T02** wired the manual merge path and proved everything with integration tests. In `worktree-command.ts`'s `handleMerge`, a file-presence-guarded reconcile block was inserted immediately before the `mergeWorktreeToMain` call, using dynamic `await import("./gsd-db.js")` consistent with the async command handler pattern. Then `worktree-db-integration.test.ts` was created with 5 test cases using real git repo fixtures (tmpdir + git init + initial commit + .gsd/ directory, following the `auto-worktree.test.ts` scaffold pattern):

1. **Copy on create** — seeds `gsd.db` in source, calls `createAutoWorktree`, asserts DB exists in worktree `.gsd/`
2. **Copy skip** — no source DB, `createAutoWorktree` completes without throw, no DB in worktree
3. **Reconcile merges rows** — inserts decision in worktree DB via `upsertDecision`, calls `reconcileWorktreeDb` into fresh main DB, opens main DB and asserts row present
4. **Reconcile non-fatal** — calls `reconcileWorktreeDb` with two nonexistent paths, no throw
5. **Zero-result shape** (beyond plan's 4) — calls `reconcileWorktreeDb` with absent worktree DB, asserts all four return fields are zero — confirms structured return, not undefined/throw

## Verification

```
# Integration tests — 10 passed, 0 failed
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/worktree-db-integration.test.ts
→ 10 passed, 0 failed

# S01 worktree-db unit tests — 36 passed, 0 failed
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/worktree-db.test.ts
→ 36 passed, 0 failed

# TypeScript — clean
npx tsc --noEmit → (no output)

# Full suite — 27 passed, 1 pre-existing fail (pack-install requires dist/)
npm test → 27 pass, 1 pre-existing fail unchanged
```

## Requirements Advanced

- R053 — DB copy on worktree creation wired and proved: `copyPlanningArtifacts` copies `gsd.db` when present; integration test case 1 (copy on create) confirms DB appears in worktree. Integration test case 2 (copy skip) confirms no error when source has no DB.
- R054 — DB merge reconciliation wired and proved: `reconcileWorktreeDb` called in both `mergeMilestoneToMain` (auto path) and `handleMerge` (manual path). Integration test case 3 confirms rows inserted in worktree appear in main DB after reconcile.

## Requirements Validated

- R053 — Evidence complete: copy hook wired in `copyPlanningArtifacts` with file-presence guard and non-fatal try/catch; integration tests prove copy and copy-skip behavior against real git repos. Promoting to validated.
- R054 — Evidence complete: reconcile hook wired in both merge paths with appropriate guards and non-fatal try/catch; integration tests prove row propagation and non-fatal skip behavior. Promoting to validated.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

Test 5 (reconcile returns zero-result shape) added beyond the plan's 4 test cases. The plan said "4 integration test assertions" — this extends coverage for observability without changing any existing behavior. T02 summary documents this explicitly.

## Known Limitations

The `handleMerge` reconcile hook covers the manual `/worktree merge` command path. The auto-mode merge path (`mergeMilestoneToMain`) reconciles during milestone-level teardown only — if a future slice merge step needs per-slice reconciliation, that would need a separate hook. Not a gap for current architecture since worktree DBs persist until milestone merge.

## Follow-ups

- S07 will do end-to-end integration verification of the full lifecycle including worktree DB copy and reconcile as part of the complete auto-mode cycle.

## Files Created/Modified

- `src/resources/extensions/gsd/auto-worktree.ts` — added static import of copyWorktreeDb/reconcileWorktreeDb/isDbAvailable; copy hook in copyPlanningArtifacts; reconcile hook in mergeMilestoneToMain
- `src/resources/extensions/gsd/worktree-command.ts` — added reconcile block before mergeWorktreeToMain in handleMerge
- `src/resources/extensions/gsd/tests/worktree-db-integration.test.ts` — new: 5 integration test cases, 10 assertions

## Forward Intelligence

### What the next slice should know
- Both merge paths now reconcile automatically. S07's e2e lifecycle test should verify that a decision written in a worktree DB shows up in the main DB after `mergeMilestoneToMain` — this is the complete observable contract.
- `reconcileWorktreeDb` returns a structured result `{ decisions, requirements, artifacts, conflicts }`. The conflicts array contains `{ table, id, field }` entries when both main and worktree modified the same row. S07 should consider testing conflict detection if testing realistic concurrent-write scenarios.
- The copy path uses `existsSync` directly on the source file path — it does not go through `isDbAvailable()`. This is intentional (see D046). Don't add an `isDbAvailable()` guard to the copy path.

### What's fragile
- `handleMerge` reconcile uses dynamic import — it fires before `mergeWorktreeToMain` but after the file-presence check. If the worktree DB is deleted between check and import (very unlikely in practice), the try/catch swallows silently. This is fine for the non-fatal contract.
- The reconcile in `mergeMilestoneToMain` depends on `worktreeCwd` being captured at function entry as an absolute path. If that variable ever gets refactored to lazy evaluation, the path after `process.chdir` would be wrong.

### Authoritative diagnostics
- `gsd-db:` stderr prefix — reconcile logs here. `2>&1 | grep "gsd-db:"` gives the full reconcile trace.
- `openDatabase(join(basePath, ".gsd", "gsd.db"))` + `getActiveDecisions()` — the definitive post-merge state check.

### What assumptions changed
- Plan said guard with `isDbAvailable()` for the copy path. Execution clarified: `isDbAvailable()` reflects whether the DB connection is currently open, not whether the file exists. For file copy during worktree creation, `existsSync` is the correct guard. The plan note "Guard with `isDbAvailable()`" in T01 description was superseded by the actual implementation decision (D046).
