# S06: Doctor + cleanup + code simplification — Research

**Date:** 2026-03-14

## Summary

S06 has two jobs: (1) extend the existing `doctor.ts` with git health checks, and (2) remove dead `.gsd/` conflict resolution code from worktree-mode paths. Both are straightforward additions to well-established patterns.

The doctor system (`doctor.ts`, 766 lines) already has a mature architecture: `DoctorIssueCode` union type, `DoctorIssue` interface with severity/fixable flags, `runGSDDoctor` function that collects issues and optionally fixes them. Adding git health checks means extending this pattern with new issue codes and detection logic. The self-heal module (`git-self-heal.ts`) provides `abortAndReset` which already detects MERGE_HEAD/SQUASH_MSG/rebase state — doctor can reuse this for detection and fix.

For dead code removal: `git-service.ts` lines ~768-863 contain ~95 lines of `.gsd/` conflict auto-resolution in `mergeSliceToMain` (runtime conflict resolution via `--theirs`, `.gsd/` planning conflict resolution, post-merge runtime file stripping). In worktree mode, `mergeSliceToMilestone` in `auto-worktree.ts` handles merges instead — this code is only needed for branch-per-slice mode. The code should stay but could be annotated/commented for clarity. Per D038, worktree merges skip `.gsd/` conflict resolution entirely.

## Recommendation

**Extend `doctor.ts` with git-specific issue codes and checks.** Add detection for: orphaned auto-worktrees (worktree on disk but no matching milestone/branch), stale milestone branches (branch exists but milestone completed), corrupt merge state (MERGE_HEAD/SQUASH_MSG present), and tracked runtime files. Reuse `listWorktrees` from `worktree-manager.ts` and `abortAndReset` from `git-self-heal.ts`. Keep fixes non-destructive (remove worktrees, delete branches, abort merges — never lose data).

**Do NOT remove the `.gsd/` conflict resolution code from `mergeSliceToMain`.** It's still needed for `git.isolation: "branch"` users. Instead, add a code comment clarifying it's branch-mode-only. The "dead code removal" in the slice description refers to worktree-mode paths — and those paths (`mergeSliceToMilestone`) already have zero conflict resolution code (D038 confirmed).

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Worktree listing | `listWorktrees()` in worktree-manager.ts | Already parses `git worktree list --porcelain`, returns structured data |
| Merge state detection | `abortAndReset()` in git-self-heal.ts | Already checks MERGE_HEAD, SQUASH_MSG, rebase-apply/merge dirs |
| Doctor issue reporting | `DoctorIssue` / `DoctorIssueCode` types in doctor.ts | Established pattern with severity, fixable flags, scope, and formatting |
| Git command execution | `runGit()` in git-service.ts | Consistent error handling, SVN noise filtering |
| Runtime path list | `RUNTIME_EXCLUSION_PATHS` in git-service.ts | Canonical list of paths that shouldn't be tracked |

## Existing Code and Patterns

- `src/resources/extensions/gsd/doctor.ts` — Issue detection + fix pattern: detect issue → push to `issues[]` → if `shouldFix(code)` → apply fix → push to `fixesApplied[]`. New git checks follow this exact pattern.
- `src/resources/extensions/gsd/git-self-heal.ts` — `abortAndReset(cwd)` detects and cleans MERGE_HEAD/SQUASH_MSG/rebase state. Doctor fix for corrupt merge state can call this directly.
- `src/resources/extensions/gsd/worktree-manager.ts` — `listWorktrees(basePath)` returns `WorktreeInfo[]` with path, branch, head, bare, main fields. `removeWorktree(basePath, name, opts)` handles cleanup.
- `src/resources/extensions/gsd/git-service.ts:705-870` — `mergeSliceToMain` contains the `.gsd/` conflict resolution code. This is branch-mode-only code and should NOT be removed — just annotated.
- `src/resources/extensions/gsd/git-service.ts:101-108` — `RUNTIME_EXCLUSION_PATHS` array lists paths that should never be committed. Doctor can check if any are tracked.
- `src/resources/extensions/gsd/auto-worktree.ts` — `autoWorktreeBranch(milestoneId)` returns `milestone/<MID>` — the branch naming convention for detecting auto-worktree branches vs manual `worktree/<name>` branches.

## Constraints

- Doctor must work from the main project root, not from within a worktree. Git commands for worktree detection run against the main `.git` dir.
- `DoctorIssueCode` is a string union type — adding new codes requires extending the union (type-checked at compile time).
- `listWorktrees` returns all worktrees including the main one (marked with `main: true`). Must filter to auto-worktrees only (branch matches `milestone/`).
- The `fixLevel` mechanism (`"task"` vs `"all"`) in `runGSDDoctor` controls which fixes are auto-applied. Git fixes should probably be in the `"all"` level since they're infrastructure repair, not completion transitions.

## Common Pitfalls

- **Deleting a worktree that's in use** — If auto-mode is running in a worktree, doctor must not remove it. Check if the worktree path matches `process.cwd()` before removal.
- **Branch deletion of checked-out branch** — git refuses to delete a branch checked out in any worktree. Must remove worktree first, then delete branch (D040).
- **False positive "stale" branches** — A `milestone/<MID>` branch is only stale if the milestone is marked complete in the roadmap. An in-progress milestone's branch is expected.
- **Runtime file tracking detection** — `git ls-files` against `RUNTIME_EXCLUSION_PATHS` may produce false positives if paths use glob patterns. The current list uses directory prefixes, so `git ls-files --error-unmatch .gsd/activity/` will work.

## Open Risks

- Doctor currently has no git-aware checks at all — this is entirely new territory. The first implementation should be conservative (detect + report) with fixes gated behind `fix: true`.
- If `listWorktrees` fails (not a git repo, git not installed), doctor should degrade gracefully rather than crash. Wrap in try/catch.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Git | N/A — standard git CLI operations | none needed |

## Sources

- S01-SUMMARY: Auto-worktree lifecycle and naming conventions
- S02-SUMMARY: mergeSliceToMilestone location and .gsd/ conflict elimination (D037, D038)
- S03-SUMMARY: Milestone merge and worktree teardown ordering (D040)
- S05-SUMMARY: Self-heal patterns (abortAndReset, formatGitError)
- doctor.ts source: Existing issue detection and fix patterns
- git-service.ts source: .gsd/ conflict resolution code location (lines 768-863)
