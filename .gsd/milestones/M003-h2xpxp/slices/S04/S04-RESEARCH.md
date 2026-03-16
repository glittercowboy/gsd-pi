# S04: Preferences + backwards compatibility — Research

**Date:** 2026-03-14

## Summary

This slice adds two new git preferences (`git.isolation` and `git.merge_to_main`) and gates all worktree-mode code behind them. The codebase is well-structured for this: `GitPreferences` interface in `git-service.ts` already has 9 fields, `validatePreferences()` in `preferences.ts` already validates each field with error messages, and `auto.ts` already uses `isInAutoWorktree()` to branch between worktree and legacy merge paths. The main work is: (1) extend the interface, (2) add validation, (3) add a `shouldUseWorktreeIsolation()` resolver with legacy detection heuristic, (4) gate worktree creation/entry in auto.ts behind the preference, (5) gate milestone-to-main merge behind `merge_to_main`.

The legacy detection heuristic is straightforward: if the repo has `gsd/*/*` branches (checked via `git branch --list 'gsd/*/*'`), it's a legacy project → default to `"branch"`. Otherwise → default to `"worktree"`. This aligns with D033.

## Recommendation

Implement in this order:
1. Add `isolation` and `merge_to_main` to `GitPreferences` interface
2. Add validation in `validatePreferences()` following the existing pattern (Set of valid values, string check, cast)
3. Add `shouldUseWorktreeIsolation(basePath)` function in `auto-worktree.ts` — resolves effective mode from preference + legacy detection
4. Gate the 3 worktree creation/entry sites in `auto.ts` (lines ~785-800, ~620-637, ~794) behind `shouldUseWorktreeIsolation()`
5. Gate `mergeMilestoneToMain` call (line ~1739) behind `merge_to_main` preference
6. Ensure `isInAutoWorktree()` branch checks in merge paths (lines ~558, ~1603) continue working — they already handle both modes correctly since they check runtime state, not preference

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Preference validation | `validatePreferences()` in preferences.ts | Established pattern with error accumulation, type narrowing, and Set-based enum validation |
| Preference loading | `loadEffectiveGSDPreferences()` | Already merges global + project prefs with override semantics |
| Legacy branch detection | `git branch --list 'gsd/*/*'` | Already used in `mergeOrphanedSliceBranches()` at auto.ts:506 |
| Worktree state detection | `isInAutoWorktree()` | Already gates merge strategy selection at runtime |

## Existing Code and Patterns

- `src/resources/extensions/gsd/git-service.ts:31-39` — `GitPreferences` interface. Add `isolation?: "worktree" | "branch"` and `merge_to_main?: "milestone" | "slice"` here.
- `src/resources/extensions/gsd/preferences.ts:860-912` — git preference validation block. Follow the `merge_strategy` pattern (Set + string check + cast) for new fields.
- `src/resources/extensions/gsd/auto.ts:558,1603` — `isInAutoWorktree(base)` already gates merge strategy at runtime. These don't need preference changes — they check actual worktree state.
- `src/resources/extensions/gsd/auto.ts:785-800` — worktree creation/entry on fresh milestone start. Gate with `shouldUseWorktreeIsolation()`.
- `src/resources/extensions/gsd/auto.ts:620-637` — worktree re-entry on resume. Gate with same check.
- `src/resources/extensions/gsd/auto.ts:1739` — `mergeMilestoneToMain()` call. Gate with `merge_to_main` preference.
- `src/resources/extensions/gsd/auto.ts:506` — `git branch --list 'gsd/*/*'` already used for orphan detection. Reuse same pattern for legacy detection.

## Constraints

- `GitPreferences` is exported from `git-service.ts` and imported by `preferences.ts` — the interface lives in git-service, validation lives in preferences. Follow this split.
- `shouldUseWorktreeIsolation()` needs both the preference value AND a basePath for legacy detection. It should live in `auto-worktree.ts` since that module owns worktree lifecycle.
- The `merge_to_main: "slice"` + `isolation: "worktree"` combination is valid per R034 — slices squash-merge to main from within worktree. The existing `mergeSliceToMain()` path handles this.
- Existing `merge_strategy` preference ("squash" | "merge") is per-slice merge strategy, separate from the new `merge_to_main` preference. Don't confuse them.

## Common Pitfalls

- **Gating resume path but not fresh-start path** — Both auto.ts:785-800 (fresh start) AND auto.ts:620-637 (resume) must be gated. Missing either causes inconsistent behavior.
- **Legacy detection on worktree basePath** — Legacy branch detection (`git branch --list 'gsd/*/*'`) must run against the main repo, not a worktree path. Use `originalBasePath` if available, fall back to `basePath`.
- **merge_to_main: "slice" in worktree mode** — When `isolation: "worktree"` + `merge_to_main: "slice"`, the slice merge path at auto.ts:1603 should use `mergeSliceToMain` (not `mergeSliceToMilestone`). Currently `isInAutoWorktree()` gates this — need to override when `merge_to_main: "slice"`.
- **Preference loading timing** — `loadEffectiveGSDPreferences()` reads from disk. In worktree mode, `.gsd/preferences.md` might not exist in the worktree. Preference loading should happen BEFORE entering the worktree, or fall back to the main tree's preferences.

## Open Risks

- The `merge_to_main: "slice"` + `isolation: "worktree"` combination needs the slice merge to go to main, not the milestone branch. This means `isInAutoWorktree()` alone is no longer sufficient to decide merge target — the preference must also be consulted. This is a behavioral change in the merge decision logic.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Git worktrees | N/A | No relevant skill — this is internal architecture |

## Sources

- All findings from direct codebase exploration of preferences.ts, git-service.ts, auto.ts, and auto-worktree.ts
