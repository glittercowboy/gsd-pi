---
id: T01
parent: S06
milestone: M003
provides:
  - 4 git health check issue codes in DoctorIssueCode union
  - checkGitHealth function detecting orphaned worktrees, stale branches, corrupt merge state, tracked runtime files
  - branch-mode-only annotation on .gsd/ conflict resolution code
key_files:
  - src/resources/extensions/gsd/doctor.ts
  - src/resources/extensions/gsd/git-service.ts
key_decisions:
  - checkGitHealth is a standalone async function called from runGSDDoctor, not inlined
  - autoWorktreeBranch import skipped — milestone branch pattern extracted inline via string replace
patterns_established:
  - git health checks wrap all operations in try/catch for graceful degradation in non-git repos
  - fix actions record descriptive strings in fixesApplied for audit trail
observability_surfaces:
  - 4 new issue codes in doctor report output (orphaned_auto_worktree, stale_milestone_branch, corrupt_merge_state, tracked_runtime_files)
  - fixesApplied strings for each remediation action
duration: 12m
verification_result: passed
completed_at: 2026-03-14T22:16:00-06:00
blocker_discovered: false
---

# T01: Add git health checks to doctor.ts

**Added 4 git health checks (orphaned worktrees, stale branches, corrupt merge state, tracked runtime files) to runGSDDoctor with detection and fix logic.**

## What Happened

Added `checkGitHealth` async function to doctor.ts with 4 checks:
1. **Orphaned auto-worktrees:** Uses `listWorktrees` to find `milestone/*` branches, cross-references against roadmap completion via `isMilestoneComplete`. Skips removal if worktree path matches `process.cwd()`.
2. **Stale milestone branches:** Lists `milestone/*` branches, flags those for completed milestones that have no associated worktree. Fix deletes with `git branch -D`.
3. **Corrupt merge state:** Checks for MERGE_HEAD, SQUASH_MSG, rebase-apply/, rebase-merge/ in .git/. Fix calls `abortAndReset`.
4. **Tracked runtime files:** Runs `git ls-files` against each `RUNTIME_EXCLUSION_PATHS` entry. Fix runs `git rm --cached -r --ignore-unmatch`.

Added 4 new values to `DoctorIssueCode` union type. Imported `listWorktrees`, `abortAndReset`, `RUNTIME_EXCLUSION_PATHS`, and `execSync`. Called `checkGitHealth` from `runGSDDoctor` after preferences validation.

Annotated the `.gsd/` conflict resolution block in git-service.ts (~line 770) with a block comment explaining it's branch-mode-only (D038).

## Verification

- `npx tsc --noEmit` — zero errors
- `npx tsx src/resources/extensions/gsd/tests/doctor.test.ts` — 59 passed, 0 failed
- `npx tsx src/resources/extensions/gsd/tests/doctor-fixlevel.test.ts` — all passed
- Slice-level `doctor-git.test.ts` does not exist yet (T02 will create it)

## Diagnostics

Run `/gsd doctor` to see git health issues. Run `/gsd doctor --fix` to auto-remediate. Issue codes appear in `summarizeDoctorIssues` byCode breakdown. Non-git repos produce no git-related output.

## Deviations

- Skipped importing `autoWorktreeBranch` — the branch naming pattern (`milestone/${milestoneId}`) is trivial enough to inline as a string replace, avoiding an unnecessary import.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/doctor.ts` — 4 new DoctorIssueCode values, checkGitHealth function, called from runGSDDoctor
- `src/resources/extensions/gsd/git-service.ts` — block comment on .gsd/ conflict resolution code (branch-mode-only, D038)
