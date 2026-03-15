# M003: Worktree-Isolated Git Architecture

**Vision:** Overhaul GSD's git system so that auto-mode is automagical — zero git errors, zero merge conflicts, zero user intervention required. Each milestone gets its own isolated worktree. Main is always clean. The system just runs.

## Success Criteria

- Auto-mode on a fresh project executes through an entire milestone without any git errors or halts
- Main branch only receives commits when milestones complete (one squash commit per milestone)
- Full commit history preserved within milestone worktree branches via `--no-ff` slice merges
- Existing branch-per-slice projects continue working identically — zero regressions
- Self-healing resolves common git failures (merge conflict, checkout issue, corrupt state) without user intervention
- `/gsd doctor` detects and fixes git health issues (orphaned worktrees, stale branches, corrupt merge state)

## Key Risks / Unknowns

- **`process.chdir` coherence in auto-mode** — all tool calls must resolve against the worktree path after chdir. The worktree-command.ts has proven this works, but auto-mode's `basePath` variable and `process.cwd()` must stay in sync.
- **Worktree `.gsd/` inheritance** — creating a worktree copies project files from the base branch. `.gsd/` planning files (CONTEXT, ROADMAP) must carry through; runtime files (STATE.md, metrics, activity) must not cause conflicts.
- **State machine re-entry on resume** — pausing and resuming auto-mode must re-enter the worktree if it exists. The current pause/resume logic doesn't handle this.

## Proof Strategy

- `process.chdir` coherence → retire in S01 by proving auto-mode dispatches and executes a unit inside the worktree with all file operations resolving correctly
- Worktree `.gsd/` inheritance → retire in S01 by proving planning files are available after worktree creation and runtime files don't conflict
- State machine re-entry → retire in S01 by proving pause/resume correctly re-enters the worktree

## Verification Classes

- Contract verification: git operations produce expected branch state, file layout, and commit history in temp repos
- Integration verification: full auto-mode lifecycle (create worktree → execute slices → merge milestone → teardown) in a real git repo
- Operational verification: existing branch-per-slice projects continue working; manual `/worktree` coexists
- UAT / human verification: run auto-mode on a real project and confirm zero git errors

## Milestone Definition of Done

This milestone is complete only when all are true:

- Auto-worktree lifecycle works end-to-end (create, execute, merge, teardown)
- `--no-ff` slice merges produce correct history on milestone branch
- Milestone squash to main produces clean single commit
- `git.isolation` and `git.merge_to_main` preferences work with validation
- Self-healing recovers from common git failures without user intervention
- Existing branch-per-slice projects pass all existing tests
- `/gsd doctor` detects and fixes git health issues
- Full test suite passes for both worktree and branch isolation modes
- Success criteria re-checked against live behavior

## Requirement Coverage

- Covers: R029, R030, R031, R032, R033, R034, R035, R036, R037, R038, R039, R040, R041
- Partially covers: none
- Leaves for later: R042 (parallel milestones), R043 (native libgit2 writes)
- Orphan risks: none

## Slices

- [x] **S01: Auto-worktree lifecycle in auto-mode** `risk:high` `depends:[]`
  > After this: `startAuto()` on a new milestone creates a worktree under `.gsd/worktrees/M003/`, `chdir`s into it, and dispatches units inside the worktree. Pause/resume re-enters the worktree. Progress widget shows the worktree branch. Verified via running auto-mode unit dispatch in a temp repo worktree.

- [x] **S02: --no-ff slice merges + conflict elimination** `risk:high` `depends:[S01]`
  > After this: completed slices merge into the milestone branch via `--no-ff` instead of squash. The `.gsd/` auto-resolve conflict code in `mergeSliceToMain` is bypassed in worktree mode. `git log` on the milestone branch shows full commit history with merge commit boundaries per slice. Verified in temp repo.

- [x] **S03: Milestone-to-main squash merge + worktree teardown** `risk:high` `depends:[S01,S02]`
  > After this: `complete-milestone` squash-merges the milestone branch to main with a rich commit message listing all slices, removes the worktree, `chdir`s back to the main project root. `git log main` shows one clean commit. Auto-push works if enabled. Verified in temp repo with remote.

- [x] **S04: Preferences + backwards compatibility** `risk:medium` `depends:[S01]`
  > After this: `git.isolation: "worktree"` (default for new projects) / `"branch"` (existing projects) and `git.merge_to_main: "milestone"` / `"slice"` preferences are validated and respected. An existing project with `gsd/*` branches defaults to branch mode and works identically to today. Verified by running tests in both modes.

- [x] **S05: Self-healing git repair** `risk:medium` `depends:[S01,S02,S03]`
  > After this: when a merge fails or checkout breaks during auto-mode, the system aborts the failed operation, resets working tree state, and retries. Only truly unresolvable conflicts (real code conflicts between human-edited files) pause auto-mode. Users see non-technical messages, not raw git errors. Verified by deliberately introducing failures and confirming auto-recovery.

- [x] **S06: Doctor + cleanup + code simplification** `risk:low` `depends:[S01,S02,S03,S05]`
  > After this: `/gsd doctor` detects orphaned auto-worktrees, stale milestone branches, corrupt merge state (MERGE_HEAD/SQUASH_MSG), and tracked runtime files — and fixes them. Dead `.gsd/` conflict resolution code removed from worktree-mode paths in git-service.ts. Verified via doctor test cases.

- [x] **S07: Test suite for worktree-isolated flow** `risk:low` `depends:[S01,S02,S03,S04,S05,S06]`
  > After this: full test coverage for auto-worktree create/teardown, `--no-ff` slice merge, milestone squash, preference switching, self-heal scenarios, doctor checks. All existing git tests still pass. Both isolation modes tested. Verified via `npm run test:unit && npm run test:integration`.

<!--
  Format rules (parsers depend on this exact structure):
  - Checkbox line: - [ ] **S01: Title** `risk:high|medium|low` `depends:[S01,S02]`
  - Demo line:     >  After this: one sentence showing what's demoable
  - Mark done:     change [ ] to [x]
  - Order slices by risk (highest first)
  - Each slice must be a vertical, demoable increment — not a layer
  - If all slices are completed exactly as written, the milestone's promised outcome should actually work at the stated proof level
  - depends:[X,Y] means X and Y must be done before this slice starts
-->

## Boundary Map

### S01 → S02, S03, S04, S05

Produces:
- `createAutoWorktree(basePath, milestoneId)` — creates worktree, returns worktree path
- `teardownAutoWorktree(basePath, milestoneId)` — removes worktree, returns to main tree
- `isInAutoWorktree(basePath)` → boolean — detects if currently in an auto-worktree
- `getAutoWorktreePath(basePath, milestoneId)` → string | null — resolves worktree path
- `enterAutoWorktree(basePath, milestoneId)` — `process.chdir` into existing worktree
- Updated `startAuto()` in auto.ts that creates/enters worktree on milestone start
- Updated pause/resume logic that re-enters worktree on resume

Consumes:
- nothing (first slice)

### S01 → S02

Produces:
- The worktree infrastructure that S02 merges slices within

Consumes:
- nothing (first slice)

### S02 → S03

Produces:
- `mergeSliceToMilestone(basePath, milestoneId, sliceId, sliceTitle)` — `--no-ff` merge of slice branch into milestone branch within worktree
- Simplified merge path that skips `.gsd/` conflict resolution in worktree mode

Consumes from S01:
- `isInAutoWorktree()` to determine which merge strategy to use

### S02 → S06

Produces:
- Knowledge of which conflict resolution code is dead in worktree mode

Consumes from S01:
- Worktree detection functions

### S03 → S05

Produces:
- `mergeMilestoneToMain(basePath, milestoneId)` — squash-merge milestone branch to main
- `buildMilestoneCommitMessage(milestoneId, milestoneTitle, slices)` — rich squash commit

Consumes from S01:
- `teardownAutoWorktree()` for worktree removal after merge
- `isInAutoWorktree()` for detection

Consumes from S02:
- Merged milestone branch with `--no-ff` slice history

### S04 → S01, S02, S03

Produces:
- `git.isolation` preference — `"worktree"` | `"branch"`
- `git.merge_to_main` preference — `"milestone"` | `"slice"`
- `shouldUseWorktreeIsolation(basePath)` — resolves effective isolation mode
- Preference validation in `preferences.ts`

Consumes from S01:
- Auto-worktree functions (gated by isolation preference)

### S05 → S06

Produces:
- Structured git error handling patterns (try/abort/reset/retry)
- User-facing error message formatting

Consumes from S01:
- Worktree detection (to scope repair to correct working tree)
Consumes from S02:
- Merge operations that may fail
Consumes from S03:
- Milestone merge that may fail

### S06 → S07

Produces:
- Doctor git health check functions
- Simplified git-service.ts with dead code removed

Consumes from S05:
- Error handling patterns for doctor fix operations
