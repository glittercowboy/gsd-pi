---
estimated_steps: 8
estimated_files: 5
---

# S05: Worktree DB Isolation

**Goal:** Wire `copyWorktreeDb` into `copyPlanningArtifacts` so new worktrees start with a seeded DB, and wire `reconcileWorktreeDb` into both `mergeMilestoneToMain` (auto path) and `handleMerge` (manual `/worktree merge` path) so worktree DB rows fold back into main on merge.

**Demo:** After `createAutoWorktree`, `.gsd/gsd.db` exists in the worktree when the source had one. After `mergeMilestoneToMain`, rows inserted in the worktree DB appear in the main DB. Both operations are non-fatal and skip silently when no DB is present.

## Must-Haves

- `copyPlanningArtifacts` copies `gsd.db` when `existsSync(srcDb)` is true (file-presence guard, not `isDbAvailable()`)
- `mergeMilestoneToMain` reconciles worktree DB into main DB before `process.chdir(originalBasePath_)`
- `handleMerge` in `worktree-command.ts` reconciles worktree DB before `mergeWorktreeToMain` squash call
- All hooks are non-fatal (try/catch)
- Integration tests prove copy and reconcile against real git repos

## Proof Level

- This slice proves: integration
- Real runtime required: yes (git repo fixture for integration tests)
- Human/UAT required: no

## Verification

```bash
# New integration tests
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/worktree-db-integration.test.ts

# Existing S01 worktree-db tests — must stay green
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/worktree-db.test.ts

# TypeScript clean
npx tsc --noEmit

# Full suite — zero regressions
npm test
```

Observable behaviors:
- `existsSync(join(worktreePath, ".gsd", "gsd.db"))` is true after `createAutoWorktree` when main has `gsd.db`
- After `mergeMilestoneToMain`, decision rows inserted in worktree appear in main DB
- When source has no `gsd.db`: copy skips silently, no error
- When worktree DB absent at merge time: reconcile skips silently, no error

Failure-path / diagnostic checks:
- `reconcileWorktreeDb(mainDbPath, "/nonexistent/path.db")` returns `{ decisions:0, requirements:0, artifacts:0, conflicts:[] }` — no throw (verified by Test 4 + Test 5 in integration suite)
- On reconcile failure: `gsd-db:` prefix is emitted to stderr — observable via `node --experimental-sqlite ... 2>&1 | grep "gsd-db:"`
- Post-merge DB state queryable: `openDatabase(join(basePath, ".gsd", "gsd.db"))` + `getActiveDecisions()` from `context-store.ts`

## Observability / Diagnostics

- Runtime signals: existing `gsd-db:` stderr prefix for reconcile failures; copy errors non-fatal (caught silently)
- Inspection surfaces: `isDbAvailable()`, `getDbProvider()`, DB tables queryable after merge
- Failure visibility: try/catch swallows hook failures — failures are intentionally non-fatal. DB state before/after reconcile is queryable via context-store query functions.

## Integration Closure

- Upstream surfaces consumed: `copyWorktreeDb`, `reconcileWorktreeDb`, `isDbAvailable` from `gsd-db.ts` (S01); `migrateFromMarkdown` from `md-importer.ts` (S02, for fallback reference only — not wired in S05)
- New wiring introduced: copy hook in `copyPlanningArtifacts`, reconcile hook in `mergeMilestoneToMain`, reconcile hook in `handleMerge`
- What remains before milestone usable end-to-end: S06 (structured LLM tools + /gsd inspect), S07 (integration verification)

## Tasks

- [x] **T01: Wire DB copy/reconcile into auto-worktree.ts** `est:30m`
  - Why: Closes R053 (DB copy on worktree creation) and R054 (DB reconcile on milestone merge) for the auto-mode path
  - Files: `src/resources/extensions/gsd/auto-worktree.ts`
  - Do: Add static imports of `copyWorktreeDb`, `reconcileWorktreeDb`, `isDbAvailable` from `./gsd-db.js`. In `copyPlanningArtifacts`, after the top-level planning files loop, add a `gsd.db` copy block guarded by `existsSync(srcDb)` (not `isDbAvailable()` — DB may not be open during creation). In `mergeMilestoneToMain`, add a reconcile block between step 1 (auto-commit) and step 3 (process.chdir) — while `worktreeCwd` is still valid. Guard with `isDbAvailable()`. Both blocks: try/catch, non-fatal.
  - Verify: `npx tsc --noEmit` clean; existing tests pass (`npm test`)
  - Done when: TypeScript compiles clean, zero regressions in existing test suite

- [x] **T02: Wire reconcile into worktree-command.ts + write integration tests** `est:45m`
  - Why: Closes the manual `/worktree merge` path (R054) and proves both hooks with real git fixtures
  - Files: `src/resources/extensions/gsd/worktree-command.ts`, `src/resources/extensions/gsd/tests/worktree-db-integration.test.ts`
  - Do: In `handleMerge` (worktree-command.ts), before the `mergeWorktreeToMain(basePath, name, commitMessage)` call in the deterministic path, add a dynamic import reconcile block: `const wtDbPath = join(worktreePath(basePath, name), ".gsd", "gsd.db")` and `const mainDbPath = join(basePath, ".gsd", "gsd.db")`, guard with `existsSync(wtDbPath) && existsSync(mainDbPath)`, dynamic import `reconcileWorktreeDb` from `./gsd-db.js`, non-fatal try/catch. Then write `worktree-db-integration.test.ts` with real git repo fixtures (follow `auto-worktree.test.ts` pattern: tmpdir + git init + initial commit + .gsd/). Test cases: (1) copy — create worktree after seeding `gsd.db` in source, assert DB appears in worktree; (2) copy skip — no `gsd.db` in source, assert no error and no DB in worktree; (3) reconcile — open DB in worktree, insert a decision row, call `reconcileWorktreeDb` into a fresh main DB, assert row present in main; (4) reconcile skip — absent worktree DB, assert reconcile call does not throw.
  - Verify: integration test suite passes (see Verification commands above); `npx tsc --noEmit` clean; `npm test` zero regressions
  - Done when: All 4 integration test assertions pass, TypeScript clean, full suite green

## Files Likely Touched

- `src/resources/extensions/gsd/auto-worktree.ts`
- `src/resources/extensions/gsd/worktree-command.ts`
- `src/resources/extensions/gsd/tests/worktree-db-integration.test.ts` (new)
