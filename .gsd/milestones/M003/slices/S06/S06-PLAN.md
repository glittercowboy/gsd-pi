# S06: Doctor + cleanup + code simplification

**Goal:** `/gsd doctor` detects and fixes git health issues (orphaned worktrees, stale branches, corrupt merge state, tracked runtime files). Branch-mode-only `.gsd/` conflict resolution code annotated for clarity.
**Demo:** Run `/gsd doctor` on a repo with an orphaned worktree and stale milestone branch → both detected and fixed.

## Must-Haves

- 4 new DoctorIssueCode values: `orphaned_auto_worktree`, `stale_milestone_branch`, `corrupt_merge_state`, `tracked_runtime_files`
- Detection logic for each using existing `listWorktrees`, `abortAndReset`, `RUNTIME_EXCLUSION_PATHS`
- Fix logic for each (remove worktree, delete branch, abort merge, untrack files) gated behind `shouldFix`
- Doctor runs from main project root, never crashes if not a git repo
- Never removes a worktree matching `process.cwd()`
- `.gsd/` conflict resolution code in `git-service.ts` annotated as branch-mode-only

## Verification

- `npx tsx src/resources/extensions/gsd/tests/doctor-git.test.ts` — all pass
- `npx tsc --noEmit` — zero errors
- Existing `doctor.test.ts` and `doctor-fixlevel.test.ts` still pass

## Tasks

- [x] **T01: Add git health checks to doctor.ts** `est:30m`
  - Why: R040 — doctor needs git-aware checks. The existing pattern (DoctorIssueCode + detection + fix) is well-established; this extends it with 4 new codes.
  - Files: `src/resources/extensions/gsd/doctor.ts`, `src/resources/extensions/gsd/git-service.ts`
  - Do: Add 4 new codes to `DoctorIssueCode` union. Add `checkGitHealth` async function that: (1) lists worktrees via `listWorktrees`, filters to `milestone/` branches, cross-references against roadmap completion status — orphaned if milestone complete or branch gone; (2) lists branches matching `milestone/*`, flags stale if milestone complete; (3) checks for MERGE_HEAD/SQUASH_MSG/rebase dirs via `abortAndReset` detection logic; (4) runs `git ls-files` against `RUNTIME_EXCLUSION_PATHS` entries. Each pushes to `issues[]`. Fixes: removeWorktree (skip if cwd match), branch -D, abortAndReset, git rm --cached. Wrap entire block in try/catch for non-git repos. Add `checkGitHealth` call in `runGSDDoctor` after preferences check. Also annotate the `.gsd/` conflict resolution block in `git-service.ts` (lines ~768-863) with a comment block explaining it's branch-mode-only.
  - Verify: `npx tsc --noEmit` — zero errors
  - Done when: DoctorIssueCode has 4 new values, `runGSDDoctor` calls git health checks, `git-service.ts` conflict block annotated

- [x] **T02: Integration tests for doctor git health checks** `est:25m`
  - Why: Prove detection and fixes work against real git repos with deliberate broken state. Without tests, the doctor checks are unverified.
  - Files: `src/resources/extensions/gsd/tests/doctor-git.test.ts`
  - Do: Create test file with temp git repos. Tests: (1) orphaned worktree detected and fixed (create worktree, mark milestone complete in roadmap, run doctor); (2) stale milestone branch detected and fixed (create branch, complete milestone, run doctor); (3) corrupt merge state detected and fixed (create MERGE_HEAD, run doctor); (4) tracked runtime files detected and fixed (git add .gsd/activity/foo, run doctor); (5) non-git directory doesn't crash (run doctor in /tmp); (6) active worktree NOT flagged as orphaned (worktree exists, milestone in-progress). Use `node:test` runner consistent with other test files.
  - Verify: `npx tsx src/resources/extensions/gsd/tests/doctor-git.test.ts` — all pass, existing `doctor.test.ts` still passes
  - Done when: 6+ test cases pass, covering detection and fix for all 4 issue codes plus safety guards

## Files Likely Touched

## Observability / Diagnostics

- **Doctor report output:** 4 new issue codes (`orphaned_auto_worktree`, `stale_milestone_branch`, `corrupt_merge_state`, `tracked_runtime_files`) appear in `/gsd doctor` output with severity, scope, and fix status.
- **Fix audit trail:** All auto-fixes log to `fixesApplied[]`, visible in doctor report "Fixes applied" section.
- **Graceful degradation:** Non-git directories produce no git-related issues (silent skip). Git failures within checks are caught and don't block other checks.
- **Inspection:** Run `/gsd doctor --fix` to see detection + remediation. Run without `--fix` for detection-only mode.

## Files Likely Touched

- `src/resources/extensions/gsd/doctor.ts`
- `src/resources/extensions/gsd/git-service.ts`
- `src/resources/extensions/gsd/tests/doctor-git.test.ts`
