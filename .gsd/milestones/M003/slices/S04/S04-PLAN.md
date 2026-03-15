# S04: Preferences + backwards compatibility

**Goal:** `git.isolation` and `git.merge_to_main` preferences are validated and respected. Existing branch-per-slice projects auto-detect as `"branch"` mode and work identically. New projects default to `"worktree"`.

**Demo:** Set `git.isolation: "branch"` in preferences → auto-mode skips worktree creation and uses legacy branch-per-slice. Remove the preference on a project with no `gsd/*` branches → auto-mode creates worktrees. Set `git.merge_to_main: "slice"` → slices merge directly to main even in worktree mode.

## Must-Haves

- `git.isolation: "worktree" | "branch"` preference with validation
- `git.merge_to_main: "milestone" | "slice"` preference with validation
- `shouldUseWorktreeIsolation(basePath)` resolver that checks preference then falls back to legacy detection heuristic
- All 3 worktree creation/entry sites in auto.ts gated behind the resolver
- Milestone-to-main merge gated behind `merge_to_main` preference
- `merge_to_main: "slice"` + `isolation: "worktree"` combo works (slices merge to main, not milestone branch)
- Resolve merge conflict markers in auto-worktree.ts inherited from S03 branch merge

## Proof Level

- This slice proves: contract + integration
- Real runtime required: no (preference logic is testable without a real git repo for most paths; legacy detection needs git commands but can use test repos)
- Human/UAT required: no

## Observability / Diagnostics

- `shouldUseWorktreeIsolation()` logs nothing by default -- its resolution is observable through the auto-mode notify messages ("Created auto-worktree" vs normal branch flow).
- When `isolation` or `merge_to_main` preferences are invalid, `validatePreferences()` returns clear error strings in the `errors` array; these surface in the UI during preference loading.
- Legacy detection result (branch-per-slice vs worktree) is implicit in auto-mode behavior: worktree creation messages appear only when resolver returns true.
- Failure path: invalid preference values produce structured error messages matching the pattern `"git.<field> must be one of: <values>"`.

## Verification

- `npx tsc --noEmit` — clean build
- `node --test src/resources/extensions/gsd/tests/preferences-git.test.ts` — validates new preference fields
- `node --test src/resources/extensions/gsd/tests/isolation-resolver.test.ts` — validates shouldUseWorktreeIsolation with preference override, legacy detection, and default
- Grep for `<<<<` in auto-worktree.ts returns 0 matches (conflict markers resolved)
- Verify `validatePreferences({ git: { isolation: "bad" } })` returns error containing "git.isolation" (failure-path check)

## Integration Closure

- Upstream surfaces consumed: `auto-worktree.ts` (S01 lifecycle functions), `auto.ts` (S01/S02/S03 worktree wiring), `git-service.ts` (GitPreferences interface), `preferences.ts` (validatePreferences)
- New wiring introduced: `shouldUseWorktreeIsolation()` call at 3 sites in auto.ts, `merge_to_main` check at milestone merge site
- What remains: S05 (self-healing), S06 (doctor/cleanup), S07 (full test suite)

## Tasks

- [x] **T01: Resolve auto-worktree.ts merge conflicts + add preference fields + validation + resolver + gate auto.ts** `est:45m`
  - Why: This is a single coherent unit — the interface change, validation, resolver function, and gating are all tightly coupled and small. The merge conflicts must be resolved first since we're editing the same file.
  - Files: `src/resources/extensions/gsd/auto-worktree.ts`, `src/resources/extensions/gsd/git-service.ts`, `src/resources/extensions/gsd/preferences.ts`, `src/resources/extensions/gsd/auto.ts`, `src/resources/extensions/gsd/tests/preferences-git.test.ts`, `src/resources/extensions/gsd/tests/isolation-resolver.test.ts`
  - Do:
    1. Resolve merge conflict markers in `auto-worktree.ts` — keep both sides (HEAD imports + S03's `mergeMilestoneToMain` function and its helpers)
    2. Add `isolation?: "worktree" | "branch"` and `merge_to_main?: "milestone" | "slice"` to `GitPreferences` in `git-service.ts`
    3. Add validation for both fields in `validatePreferences()` in `preferences.ts` following the `merge_strategy` Set pattern
    4. Add `shouldUseWorktreeIsolation(basePath: string): boolean` in `auto-worktree.ts` — checks `loadEffectiveGSDPreferences().preferences.git.isolation`, falls back to legacy detection (`git branch --list 'gsd/*/*'` returns branches → `false`, otherwise → `true`)
    5. Gate the 3 worktree sites in `auto.ts` (fresh start ~785, resume ~620, milestone merge ~1735) behind `shouldUseWorktreeIsolation()`
    6. For `merge_to_main: "slice"` + worktree mode: override `isInAutoWorktree()` merge routing at lines ~558 and ~1603 to use `mergeSliceToMain` instead of `mergeSliceToMilestone`
    7. Write test file `preferences-git.test.ts` — validates new fields accept valid values, reject invalid, and pass through undefined
    8. Write test file `isolation-resolver.test.ts` — tests shouldUseWorktreeIsolation with explicit preference, legacy detection, and default behavior
  - Verify: `npx tsc --noEmit && node --test src/resources/extensions/gsd/tests/preferences-git.test.ts && node --test src/resources/extensions/gsd/tests/isolation-resolver.test.ts && ! grep -l '<<<<<<' src/resources/extensions/gsd/auto-worktree.ts`
  - Done when: Both new preferences validated, resolver returns correct mode for all 3 cases (explicit pref, legacy project, new project), auto.ts gates worktree code behind preference, merge routing respects merge_to_main, all tests pass, no conflict markers remain

## Files Likely Touched

- `src/resources/extensions/gsd/auto-worktree.ts`
- `src/resources/extensions/gsd/git-service.ts`
- `src/resources/extensions/gsd/preferences.ts`
- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/tests/preferences-git.test.ts`
- `src/resources/extensions/gsd/tests/isolation-resolver.test.ts`
