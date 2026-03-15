# S05: Self-healing git repair — Research

**Date:** 2026-03-14

## Summary

Self-healing needs to wrap three failure points that already exist in auto-worktree.ts and auto.ts: (1) `mergeSliceToMilestone` conflicts/failures, (2) `mergeMilestoneToMain` conflicts/failures, and (3) checkout failures during worktree operations. The good news: most of the error detection and recovery infrastructure already exists in auto.ts — the mid-merge safety check block (~L1524-1580) already does MERGE_HEAD/SQUASH_MSG detection, abort, reset, and finalization. The fix-merge dispatch pattern (~L1624-1695) already handles MergeConflictError by spawning a conflict resolution session. What's missing is: (a) a reusable `withGitSelfHeal` wrapper that tries abort+reset+retry before giving up, (b) checkout failure recovery (dirty index, detached HEAD), (c) user-facing error messages that hide git jargon, and (d) wiring self-heal into auto-worktree.ts functions which currently use raw `execSync` with no error handling.

The approach should be a utility module (`git-self-heal.ts`) exporting focused repair functions, not a monolithic wrapper. The existing `buildFixMergePrompt` in auto.ts is the right pattern for truly unresolvable conflicts — self-heal handles the automatable cases, and only escalates to fix-merge or pause for real code conflicts.

## Recommendation

Create `src/resources/extensions/gsd/git-self-heal.ts` with:
1. `abortAndReset(cwd)` — detects MERGE_HEAD/SQUASH_MSG/rebase, aborts, resets to HEAD
2. `tryMergeWithHeal(cwd, mergeFn)` — wraps a merge operation: on failure, abort+reset, retry once, then throw
3. `recoverCheckout(cwd, targetBranch)` — stash dirty state, force checkout, pop stash
4. `formatUserError(gitError)` — translates git errors to non-technical messages

Wire these into `mergeSliceToMilestone` and `mergeMilestoneToMain` in auto-worktree.ts, and into the auto.ts merge guard block. The existing fix-merge dispatch in auto.ts stays as the escalation path for real conflicts that survive self-heal.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Merge conflict detection | `git diff --name-only --diff-filter=U` pattern in auto-worktree.ts | Already proven in S02/S03 |
| Merge abort | `git merge --abort` pattern in auto.ts L1555 | Already proven in mid-merge safety check |
| Hard reset | `git reset --hard HEAD` pattern in auto.ts L1559, L1675 | Already proven |
| Fix-merge dispatch | `buildFixMergePrompt` + fix-merge unit in auto.ts L1624-1695 | Already proven escalation path |
| MergeConflictError class | git-service.ts L62 | Structured error with conflictedFiles, strategy, branches |

## Existing Code and Patterns

- `auto.ts:1524-1580` — Mid-merge safety check: detects leftover MERGE_HEAD/SQUASH_MSG, finalizes or aborts+resets. This is the template for self-heal detection logic.
- `auto.ts:1624-1695` — Fix-merge dispatch: on MergeConflictError, spawns an LLM session to resolve conflicts. This is the escalation path self-heal should defer to.
- `auto.ts:1670-1690` — Non-conflict error handling: detects UU/AA/UD in status, resets, stops. This should be replaced by self-heal retry.
- `auto-worktree.ts:250-350` — `mergeSliceToMilestone`: raw execSync for checkout and merge, throws MergeConflictError on conflict, no retry logic.
- `auto-worktree.ts:410-480` — `mergeMilestoneToMain`: raw execSync for checkout and squash-merge, throws MergeConflictError, no retry.
- `git-service.ts:829` — `reset --hard HEAD` used in ensureSliceBranch error path.
- `git-service.ts:574` — `git clean -fdx` used in branch setup, documents safety rationale.

## Constraints

- All git operations use `execSync` (not async) — self-heal functions must be synchronous
- `loadEffectiveGSDPreferences` captures cwd at module load time — cannot be used reliably in worktree context (D042)
- Worktree `.gsd/` is not tracked in git — self-heal must never `git clean` the `.gsd/` directory
- `mergeSliceToMilestone` requires caller to be on milestone branch — recovery must restore this invariant
- `mergeMilestoneToMain` does `process.chdir` — recovery must handle cwd being in either worktree or project root

## Common Pitfalls

- **Resetting in wrong cwd** — `mergeMilestoneToMain` chdir to originalBasePath before merge. If merge fails, reset must happen in originalBasePath, not worktree. The cwd after chdir is the critical context.
- **Stale SQUASH_MSG without MERGE_HEAD** — squash-merge leaves SQUASH_MSG but no MERGE_HEAD. `git merge --abort` won't clear it. Must manually unlink SQUASH_MSG (already handled in auto.ts L1560-1564).
- **Retry causing duplicate commits** — if a merge partially succeeded (committed but post-merge step failed), retrying would error with "already up to date." Must check current state before retrying.
- **git clean deleting .gsd/** — `git clean -fdx` would wipe `.gsd/` in worktrees where it's untracked. Self-heal must use `git checkout -- .` or `git reset --hard`, never `git clean` without exclusions.

## Open Risks

- Self-heal retry on a real code conflict wastes time — the retry will fail identically. Need fast detection: if `git diff --diff-filter=U` returns files, skip retry and escalate immediately.
- `process.chdir` state during error recovery is fragile — if an exception occurs between chdir and merge, the cwd may be wrong for subsequent operations.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| git | N/A — git CLI operations, no specialized skill needed | none found |

## Sources

- Existing codebase analysis (auto.ts, auto-worktree.ts, git-service.ts)
- S01/S02/S03 forward intelligence sections
