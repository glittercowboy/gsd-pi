---
estimated_steps: 6
estimated_files: 3
---

# T01: Add git health checks to doctor.ts

**Slice:** S06 — Doctor + cleanup + code simplification
**Milestone:** M003

## Description

Extend `runGSDDoctor` with 4 new git health checks: orphaned auto-worktrees, stale milestone branches, corrupt merge state, and tracked runtime files. Add code annotation to branch-mode-only `.gsd/` conflict resolution in `git-service.ts`.

## Steps

1. Add 4 new values to `DoctorIssueCode` union type: `orphaned_auto_worktree`, `stale_milestone_branch`, `corrupt_merge_state`, `tracked_runtime_files`
2. Import `listWorktrees` from `worktree-manager.ts`, `autoWorktreeBranch` from `auto-worktree.ts`, `abortAndReset` from `git-self-heal.ts`, `RUNTIME_EXCLUSION_PATHS` from `git-service.ts`, and `execSync` for direct git commands
3. Create `checkGitHealth(basePath, issues, fixesApplied, shouldFix)` async function:
   - Wrap all git operations in try/catch (degrade gracefully if not a git repo)
   - **Orphaned worktrees:** Call `listWorktrees(basePath)`, filter to branches starting with `milestone/`. For each, extract milestone ID, load roadmap, check if milestone is complete via `isMilestoneComplete`. If complete → orphaned. Skip fix if worktree path === `process.cwd()`.
   - **Stale branches:** Run `git branch --list 'milestone/*'`, cross-reference against completed milestones. A branch is stale if its milestone is complete AND no worktree points to it (worktree check already handles the overlap case).
   - **Corrupt merge state:** Check for MERGE_HEAD, SQUASH_MSG, rebase-apply/, rebase-merge/ in `.git/` dir. If found, report. Fix via `abortAndReset(basePath)`.
   - **Tracked runtime files:** Run `git ls-files` for each `RUNTIME_EXCLUSION_PATHS` entry. If any returned, report. Fix via `git rm --cached -r --ignore-unmatch`.
4. Call `checkGitHealth` from `runGSDDoctor` after the preferences validation block
5. Add a block comment above the `.gsd/` conflict resolution code in `git-service.ts` (~line 768) explaining it's branch-mode-only and not used in worktree isolation mode (D038)

## Must-Haves

- [ ] 4 new DoctorIssueCode values compile
- [ ] Git health checks run inside `runGSDDoctor`
- [ ] Non-git repos don't crash doctor
- [ ] Active worktrees (cwd match) are never removed
- [ ] `.gsd/` conflict code annotated

## Verification

- `npx tsc --noEmit` — zero errors
- Existing `npx tsx tests/doctor.test.ts` and `doctor-fixlevel.test.ts` still pass

## Inputs

- `src/resources/extensions/gsd/doctor.ts` — existing doctor pattern
- `src/resources/extensions/gsd/git-self-heal.ts` — `abortAndReset` for corrupt merge state detection/fix
- `src/resources/extensions/gsd/worktree-manager.ts` — `listWorktrees` for orphaned worktree detection
- `src/resources/extensions/gsd/auto-worktree.ts` — `autoWorktreeBranch` for milestone branch naming
- `src/resources/extensions/gsd/git-service.ts` — `RUNTIME_EXCLUSION_PATHS` for tracked file detection
- S05-SUMMARY: abortAndReset patterns, formatGitError

## Expected Output

- `src/resources/extensions/gsd/doctor.ts` — 4 new issue codes, `checkGitHealth` function, called from `runGSDDoctor`
- `src/resources/extensions/gsd/git-service.ts` — block comment on `.gsd/` conflict resolution code

## Observability Impact

- **New issue codes visible in doctor report:** `orphaned_auto_worktree`, `stale_milestone_branch`, `corrupt_merge_state`, `tracked_runtime_files` — all appear in `formatDoctorReport` output and `summarizeDoctorIssues` byCode breakdown.
- **Fix actions logged:** Each fix records a human-readable string in `fixesApplied[]`, surfaced in doctor report under "Fixes applied".
- **Failure degradation:** All git checks wrap in try/catch — failures are silent (no issue emitted) rather than crashing doctor. This means a broken git repo won't block non-git doctor checks.
