---
id: T01
parent: S04
milestone: M003
provides:
  - git.isolation and git.merge_to_main preference validation
  - shouldUseWorktreeIsolation resolver with legacy detection
  - getMergeToMainMode helper
  - All worktree sites in auto.ts gated behind preferences
key_files:
  - src/resources/extensions/gsd/git-service.ts
  - src/resources/extensions/gsd/preferences.ts
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/tests/preferences-git.test.ts
  - src/resources/extensions/gsd/tests/isolation-resolver.test.ts
key_decisions:
  - shouldUseWorktreeIsolation accepts optional overridePrefs parameter for testability (loadEffectiveGSDPreferences uses module-level cwd constant)
  - validatePreferences exported (was private) so tests can call it directly
  - Replaced Unicode arrows/dashes in auto-worktree.ts JSDoc comments to fix Node --experimental-strip-types parser
patterns_established:
  - Set-based validation pattern extended for isolation and merge_to_main fields
  - Preference override parameter pattern for functions that load preferences internally
observability_surfaces:
  - Preference validation errors surface as structured strings in errors array
  - Worktree creation/skip observable through auto-mode notify messages
duration: 30m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T01: Resolve merge conflicts + add git preferences + resolver + gate auto.ts

**Added git.isolation and git.merge_to_main preferences with validation, resolver, and gating across all worktree sites in auto.ts**

## What Happened

1. Resolved all merge conflict markers in `auto-worktree.ts` (3 conflict regions from S03 merge) and `auto.ts` (1 conflict in imports). Kept both HEAD and S03 content: imports for `parseRoadmap`/`loadEffectiveGSDPreferences` and the full `mergeMilestoneToMain` function with helpers.

2. Extended `GitPreferences` interface with `isolation?: "worktree" | "branch"` and `merge_to_main?: "milestone" | "slice"`.

3. Added Set-based validation blocks for both new fields in `validatePreferences()`, following the existing `merge_strategy` pattern. Also exported `validatePreferences` (was private) for direct test access.

4. Implemented `shouldUseWorktreeIsolation(basePath, overridePrefs?)` in `auto-worktree.ts` with three-tier resolution: explicit preference > legacy branch detection (`gsd/*/*` branches) > default to worktree. Added `getMergeToMainMode()` helper.

5. Gated 5 sites in `auto.ts`:
   - Fresh-start worktree creation (~785): `shouldUseWorktreeIsolation(base)`
   - Resume worktree re-entry (~620): `shouldUseWorktreeIsolation(originalBasePath)`
   - Milestone merge (~1735): `getMergeToMainMode() === "milestone"`
   - Two slice merge routing sites (~558, ~1603): `getMergeToMainMode() !== "slice"` controls whether `mergeSliceToMilestone` or `mergeSliceToMain` is called

6. Fixed Unicode characters (`→`, `—`, backtick-quoted `gsd/*/*`) in JSDoc comments that caused Node's `--experimental-strip-types` parser to fail.

## Verification

- `npx tsc --noEmit` — zero errors
- `node --test preferences-git.test.ts` — 21 assertions, all pass (valid/invalid/undefined for both fields)
- `node --test isolation-resolver.test.ts` — 4 assertions, all pass (default/legacy/explicit worktree/explicit branch)
- `grep -c '<<<<<<' auto-worktree.ts` — returns 0

Slice-level verification status (this is the only task):
- [x] `npx tsc --noEmit` — clean build
- [x] `node --test preferences-git.test.ts` — pass
- [x] `node --test isolation-resolver.test.ts` — pass
- [x] Grep for `<<<<` in auto-worktree.ts — 0 matches

## Diagnostics

- Invalid preference values produce errors matching `"git.<field> must be one of: <values>"` pattern
- Worktree vs branch mode observable through auto-mode notify messages (presence/absence of "Created auto-worktree" or "Entered auto-worktree")
- `shouldUseWorktreeIsolation` can be tested with `overridePrefs` parameter without filesystem setup

## Deviations

- Made `validatePreferences` exported (was module-private) — needed for direct test access without going through the full file-loading pipeline.
- Added `overridePrefs` parameter to `shouldUseWorktreeIsolation` — `loadEffectiveGSDPreferences` computes paths at module load time from `process.cwd()`, making chdir-based test fixtures unreliable.
- Replaced Unicode box-drawing and arrow characters in auto-worktree.ts JSDoc comments — Node's `--experimental-strip-types` parser incorrectly interprets `/*` inside backtick-quoted strings within `/** */` comments.

## Known Issues

- `auto-worktree.test.ts` (pre-existing, not part of this task) was already broken by S03's merge adding content that triggers the same strip-types parser bug. The Unicode fix in this task only covers auto-worktree.ts; other files may have similar issues.

## Files Created/Modified

- `src/resources/extensions/gsd/git-service.ts` — added isolation and merge_to_main fields to GitPreferences
- `src/resources/extensions/gsd/preferences.ts` — added validation for both new fields, exported validatePreferences
- `src/resources/extensions/gsd/auto-worktree.ts` — resolved conflicts, added shouldUseWorktreeIsolation + getMergeToMainMode, fixed Unicode chars
- `src/resources/extensions/gsd/auto.ts` — resolved import conflict, gated 5 worktree/merge sites behind preferences
- `src/resources/extensions/gsd/tests/preferences-git.test.ts` — new: validates git.isolation and git.merge_to_main preference fields
- `src/resources/extensions/gsd/tests/isolation-resolver.test.ts` — new: validates shouldUseWorktreeIsolation resolver logic
- `.gsd/milestones/M003/slices/S04/S04-PLAN.md` — added observability section, marked T01 done
