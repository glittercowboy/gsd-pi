---
id: M003
provides:
  - Worktree-per-milestone git isolation as default for new projects
  - auto-worktree.ts module with lifecycle, merge, and self-heal functions
  - --no-ff slice merges preserving full commit history on milestone branches
  - Milestone squash-merge to main with rich conventional-commit messages
  - git.isolation and git.merge_to_main preferences with validation and legacy detection
  - Self-healing git repair (abort, reset, retry) for transient failures
  - Doctor git health checks for orphaned worktrees, stale branches, corrupt state
  - Full e2e test coverage for worktree-isolated flow
key_decisions:
  - D027: Worktree-per-milestone as default isolation model
  - D028: --no-ff merge for slices (preserves commit diary)
  - D029: Squash merge for milestones to main (clean changelog)
  - D030: Self-heal with immediate escalation for real conflicts
  - D031: Vibe coder first — zero git errors as default
  - D033: No forced migration — legacy detection for existing projects
  - D037: mergeSliceToMilestone in auto-worktree.ts, not git-service.ts
  - D038: No .gsd/ conflict resolution in worktree merge path
  - D044: Detect real conflicts immediately, retry only transient failures
patterns_established:
  - Atomic chdir + originalBase + basePath + gitService update in same try block (split-brain prevention)
  - milestone/<MID> branch naming for auto-worktrees vs worktree/<name> for manual
  - isInAutoWorktree() guard for conditional routing between worktree and branch modes
  - Set-based preference validation extended for git-specific fields
  - Synchronous git recovery functions with structured results
  - Git health check detect → fix → verify cycle pattern
observability_surfaces:
  - isInAutoWorktree(basePath) + getAutoWorktreeOriginalBase() — canonical worktree state signals
  - UI notifications on worktree create/enter/exit/failure
  - formatGitError translates git errors to user-friendly messages with /gsd doctor suggestion
  - 4 DoctorIssueCode values in /gsd doctor output
requirement_outcomes:
  - id: R029
    from_status: active
    to_status: validated
    proof: S01 createAutoWorktree creates worktree with milestone/<MID> branch, chdir, dispatches from within. S07 e2e lifecycle test (5 assertions) proves full create-execute-merge-teardown.
  - id: R030
    from_status: active
    to_status: validated
    proof: S03 mergeMilestoneToMain squash-merges milestone branch to main, tears down worktree, chdir back. 23 assertions in auto-worktree-milestone-merge.test.ts. S07 e2e verifies single squash commit.
  - id: R031
    from_status: active
    to_status: validated
    proof: S02 mergeSliceToMilestone uses --no-ff merge. 21 assertions prove merge commit boundaries, rich messages, branch deletion. S07 e2e verifies both slice titles in squash commit.
  - id: R032
    from_status: active
    to_status: validated
    proof: S03 builds conventional-commit message listing all slices. Test verifies feat(MID) format with slice listing. S07 e2e confirms both slice titles in final main commit.
  - id: R035
    from_status: active
    to_status: validated
    proof: S05 git-self-heal.ts with abortAndReset, withMergeHeal, recoverCheckout, formatGitError. 14 assertions against real broken git repos. Wired into auto-worktree.ts merge/checkout paths.
  - id: R036
    from_status: active
    to_status: validated
    proof: S02 mergeSliceToMilestone has zero .gsd/ conflict resolution code. S06 annotated branch-mode-only on git-service.ts conflict resolution. D038 documents structural impossibility.
  - id: R037
    from_status: active
    to_status: validated
    proof: S05 formatGitError translates all git errors to non-technical messages with /gsd doctor suggestion. Self-heal handles transient failures silently. Only real code conflicts surface to user.
  - id: R038
    from_status: active
    to_status: validated
    proof: S04 shouldUseWorktreeIsolation detects legacy gsd/* branches and defaults to branch mode. S07 291 unit tests pass with zero regressions. mergeSliceToMain in git-service.ts untouched.
  - id: R039
    from_status: active
    to_status: validated
    proof: S01 uses milestone/<MID> branches for auto-worktrees, worktree/<name> for manual. Integration test proves coexistence. No branch naming collisions.
duration: 3h 23m
verification_result: passed
completed_at: 2026-03-14
---

# M003: Worktree-Isolated Git Architecture

**Zero-friction git isolation — auto-worktree per milestone with --no-ff slice merges, milestone squash to main, self-healing repair, doctor health checks, and full backwards compatibility**

## What Happened

Built a complete worktree-isolated git architecture that makes git invisible to auto-mode users. S01 created the `auto-worktree.ts` module with 6 lifecycle functions (create, teardown, detect, path, enter, getOriginalBase) and wired them into auto.ts's startAuto/resume/stop state machine with atomic chdir + state update to prevent split-brain. Worktree creation is non-fatal — auto-mode degrades gracefully to project root on failure.

S02 added `mergeSliceToMilestone` with `--no-ff` merge strategy, preserving full commit history as a diary of agent work. The function was co-located in auto-worktree.ts (not git-service.ts) to keep worktree logic isolated. Both auto.ts merge call sites were guarded with `isInAutoWorktree()` to route between worktree and branch modes. Zero `.gsd/` conflict resolution code in the worktree path — structurally unnecessary.

S03 implemented `mergeMilestoneToMain` — squash-merge the milestone branch to main with a rich conventional-commit message listing all completed slices. Handles dirty worktree state (auto-commit), auto-push, worktree removal, and branch cleanup. Fixed two bugs during testing: nothing-to-commit detection and worktree/branch deletion ordering.

S04 added `git.isolation` ("worktree" | "branch") and `git.merge_to_main` ("milestone" | "slice") preferences with Set-based validation. `shouldUseWorktreeIsolation` uses three-tier resolution: explicit pref → legacy branch detection → default to worktree. All 5 worktree/merge sites in auto.ts gated behind preferences.

S05 built self-healing git repair with 4 recovery functions: `abortAndReset` (clears MERGE_HEAD/SQUASH_MSG/rebase state), `withMergeHeal` (detects real vs transient conflicts), `recoverCheckout` (resets dirty index), and `formatGitError` (user-friendly messages with `/gsd doctor` suggestion). Wired into all merge and checkout paths.

S06 extended `/gsd doctor` with 4 git health checks: orphaned auto-worktrees, stale milestone branches, corrupt merge state, and tracked runtime files — all with detection and fix logic, wrapped in try/catch for non-git repo safety.

S07 capped the milestone with `worktree-e2e.test.ts` — 20 assertions across 5 groups covering the full lifecycle, preference gating, merge modes, self-heal, and doctor integration. 291 unit tests pass with zero regressions.

## Cross-Slice Verification

| Success Criterion | Evidence |
|---|---|
| Auto-mode executes through milestone without git errors | S07 e2e lifecycle test: createAutoWorktree → 2 slices → mergeMilestoneToMain → verify single squash commit, worktree removed, branch deleted (5 assertions) |
| Main only receives commits on milestone complete | S03 mergeMilestoneToMain squash-merges (23 assertions); S07 e2e verifies `git log main` shows one commit |
| Full commit history via --no-ff slice merges | S02 mergeSliceToMilestone verified with 21 assertions showing merge commits, distinct boundaries, branch deletion |
| Existing branch-per-slice works identically | S04 legacy detection + preference gating; S07 291 unit tests pass; mergeSliceToMain untouched |
| Self-healing resolves common git failures | S05 abortAndReset/withMergeHeal/recoverCheckout tested against real broken repos (14 assertions); wired into auto-worktree.ts |
| /gsd doctor detects and fixes git issues | S06 4 issue codes with detect/fix/verify cycle (17 assertions in doctor-git.test.ts) |
| git.isolation and git.merge_to_main preferences work | S04 Set-based validation, three-tier resolver, 25 test assertions |
| Full test suite passes for both modes | S07 worktree-e2e.test.ts (20 assertions) + 291 unit tests zero regressions |

## Requirement Changes

- R029: active → validated — S01 auto-worktree lifecycle wired into auto.ts, S07 e2e proves full create-execute-merge-teardown
- R030: active → validated — S03 mergeMilestoneToMain with 23 assertions, S07 e2e verifies single squash commit on main
- R031: active → validated — S02 mergeSliceToMilestone with --no-ff, 21 assertions prove merge boundaries
- R032: active → validated — S03 rich conventional-commit message with slice listing, verified in tests
- R033: already validated in S04 — no change
- R034: already validated in S04 — no change
- R035: active → validated — S05 self-heal module with 4 recovery functions, 14 assertions against real broken repos
- R036: active → validated — S02 zero .gsd/ conflict resolution in worktree path, S06 annotated branch-mode-only
- R037: active → validated — S05 formatGitError translates errors to user-friendly messages with /gsd doctor suggestion
- R038: active → validated — S04 legacy detection defaults existing projects to branch mode, 291 unit tests pass
- R039: active → validated — S01 milestone/ vs worktree/ branch naming prevents collisions, coexistence tested
- R040: already validated in S06 — no change
- R041: already validated in S07 — no change

## Forward Intelligence

### What the next milestone should know
- `loadEffectiveGSDPreferences` computes `PROJECT_PREFERENCES_PATH` at module load time from `process.cwd()`. Any code that needs prefs in a different cwd (tests, worktrees) will get the wrong path. Consider lazy resolution.
- `originalBasePath` in auto.ts is set on startAuto and cleared on stopAuto. If a code path bypasses stopAuto (crash, SIGKILL), the variable is lost but the worktree persists on disk and can be re-entered on resume.
- The rich commit message format is duplicated between `mergeSliceToMilestone` (auto-worktree.ts) and `buildRichCommitMessage` (git-service.ts) — divergence is possible.

### What's fragile
- Node's `--experimental-strip-types` chokes on Unicode characters in JSDoc comments — any new functions with non-ASCII chars in `/** */` comments will break tests
- Nothing-to-commit detection in mergeMilestoneToMain relies on parsing git error output strings — fragile against git version changes
- Integration test suite times out at 180s — pre-existing, not caused by M003

### Authoritative diagnostics
- `isInAutoWorktree(basePath)` + `getAutoWorktreeOriginalBase()` — canonical worktree state signals; if these disagree with `process.cwd()`, there's a split-brain bug
- `git worktree list` — ground truth for what worktrees exist
- `git log --oneline --graph milestone/<MID>` — ground truth for --no-ff merge topology

### What assumptions changed
- Worktree removal must happen before branch deletion (git won't delete a branch checked out in a worktree) — reversed from initial plan
- `recoverCheckout` doesn't need stash — worktree changes are expendable, `git reset --hard HEAD` suffices
- `getMergeToMainMode` doesn't accept overridePrefs — tested through `shouldUseWorktreeIsolation` instead

## Files Created/Modified

- `src/resources/extensions/gsd/auto-worktree.ts` — new module: 6 lifecycle functions, mergeSliceToMilestone, mergeMilestoneToMain, shouldUseWorktreeIsolation, getMergeToMainMode
- `src/resources/extensions/gsd/auto.ts` — wired auto-worktree lifecycle into startAuto/resume/stop, gated 5 merge/worktree sites behind preferences
- `src/resources/extensions/gsd/worktree-manager.ts` — generalized createWorktree/removeWorktree with optional branch param
- `src/resources/extensions/gsd/git-self-heal.ts` — new module: abortAndReset, withMergeHeal, recoverCheckout, formatGitError
- `src/resources/extensions/gsd/git-service.ts` — added isolation/merge_to_main to GitPreferences, annotated branch-mode-only on conflict resolution
- `src/resources/extensions/gsd/preferences.ts` — added validation for git.isolation and git.merge_to_main, exported validatePreferences
- `src/resources/extensions/gsd/doctor.ts` — 4 new DoctorIssueCode values, checkGitHealth function
- `src/resources/extensions/gsd/tests/auto-worktree.test.ts` — 21 assertions: lifecycle, re-entry, coexistence, split-brain prevention
- `src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — 21 assertions: --no-ff merge, conflicts, .gsd/ safety
- `src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — 23 assertions: squash merge, rich commit, auto-push
- `src/resources/extensions/gsd/tests/preferences-git.test.ts` — 21 assertions: git preference validation
- `src/resources/extensions/gsd/tests/isolation-resolver.test.ts` — 4 assertions: resolver logic
- `src/resources/extensions/gsd/tests/git-self-heal.test.ts` — 14 assertions: recovery against real broken repos
- `src/resources/extensions/gsd/tests/doctor-git.test.ts` — 17 assertions: git health check detect/fix/verify
- `src/resources/extensions/gsd/tests/worktree-e2e.test.ts` — 20 assertions: full e2e across 5 groups
