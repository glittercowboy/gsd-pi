---
id: S04
parent: M003
milestone: M003
provides:
  - git.isolation preference ("worktree" | "branch") with validation
  - git.merge_to_main preference ("milestone" | "slice") with validation
  - shouldUseWorktreeIsolation resolver with legacy detection heuristic
  - getMergeToMainMode helper
  - All worktree/merge sites in auto.ts gated behind preferences
requires:
  - slice: S01
    provides: auto-worktree lifecycle functions (createAutoWorktree, enterAutoWorktree, isInAutoWorktree)
affects:
  - S05
  - S06
  - S07
key_files:
  - src/resources/extensions/gsd/git-service.ts
  - src/resources/extensions/gsd/preferences.ts
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/tests/preferences-git.test.ts
  - src/resources/extensions/gsd/tests/isolation-resolver.test.ts
key_decisions:
  - D042: shouldUseWorktreeIsolation accepts optional overridePrefs for testability
  - D043: validatePreferences exported for direct test access
patterns_established:
  - Set-based validation pattern extended for isolation and merge_to_main fields
  - Preference override parameter pattern for functions that load preferences internally
observability_surfaces:
  - Preference validation errors as structured strings in errors array
  - Worktree vs branch mode observable through auto-mode notify messages
drill_down_paths:
  - .gsd/milestones/M003/slices/S04/tasks/T01-SUMMARY.md
duration: 30m
verification_result: passed
completed_at: 2026-03-14
---

# S04: Preferences + backwards compatibility

**Added git.isolation and git.merge_to_main preferences with validation, resolver, and auto.ts gating for full backwards compatibility**

## What Happened

Extended GitPreferences with `isolation` ("worktree" | "branch") and `merge_to_main` ("milestone" | "slice") fields. Added Set-based validation for both in validatePreferences(). Implemented `shouldUseWorktreeIsolation(basePath)` with three-tier resolution: explicit preference → legacy branch detection (gsd/*/* branches) → default to worktree. Added `getMergeToMainMode()` helper.

Gated 5 sites in auto.ts: fresh-start worktree creation, resume worktree re-entry, milestone merge, and two slice merge routing sites. When `merge_to_main: "slice"`, slices merge to main via mergeSliceToMain instead of mergeSliceToMilestone, even in worktree mode.

Resolved 3 merge conflict regions in auto-worktree.ts and 1 in auto.ts from S03 merge. Fixed Unicode characters in JSDoc comments that broke Node's --experimental-strip-types parser.

## Verification

- `npx tsc --noEmit` — zero errors
- `preferences-git.test.ts` — 21 assertions pass (valid/invalid/undefined for both fields, combined)
- `isolation-resolver.test.ts` — 4 assertions pass (default/legacy/explicit worktree/explicit branch)
- `grep '<<<<<<' auto-worktree.ts` — 0 matches (all conflicts resolved)

## Requirements Advanced

- R033 — git.isolation preference implemented with validation and three-tier resolver
- R034 — git.merge_to_main preference implemented with validation and auto.ts merge routing
- R038 — Backwards compatibility ensured: legacy detection defaults existing projects to branch mode

## Requirements Validated

- R033 — git.isolation preference validated: Set-based validation rejects invalid values, resolver correctly handles explicit pref, legacy detection, and default. 25 test assertions cover all paths.
- R034 — git.merge_to_main preference validated: validation rejects invalid values, auto.ts routes slice merges to main or milestone branch based on preference. Tested alongside isolation.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- Exported `validatePreferences` (was module-private) for direct test access — no downstream impact.
- Added `overridePrefs` parameter to `shouldUseWorktreeIsolation` — loadEffectiveGSDPreferences uses module-level path constant, making chdir-based test fixtures unreliable.
- Fixed Unicode characters in JSDoc comments — Node's strip-types parser misinterprets `/*` inside backtick-quoted strings within `/** */` comments.

## Known Limitations

- `auto-worktree.test.ts` (pre-existing) may still have Unicode issues from S03 merge content — not in scope for this slice.
- The legacy detection heuristic (`git branch --list 'gsd/*/*'`) requires git CLI — won't work in environments without git.

## Follow-ups

- S07 should add integration tests verifying the full preference → behavior flow (set isolation: "branch" → confirm no worktree created).
- Other test files may need the same Unicode fix applied in auto-worktree.ts.

## Files Created/Modified

- `src/resources/extensions/gsd/git-service.ts` — added isolation and merge_to_main to GitPreferences
- `src/resources/extensions/gsd/preferences.ts` — added validation for both fields, exported validatePreferences
- `src/resources/extensions/gsd/auto-worktree.ts` — resolved conflicts, added shouldUseWorktreeIsolation + getMergeToMainMode, fixed Unicode
- `src/resources/extensions/gsd/auto.ts` — resolved import conflict, gated 5 worktree/merge sites
- `src/resources/extensions/gsd/tests/preferences-git.test.ts` — new: 21 assertions for git preference validation
- `src/resources/extensions/gsd/tests/isolation-resolver.test.ts` — new: 4 assertions for resolver logic

## Forward Intelligence

### What the next slice should know
- The preference system is fully wired. `shouldUseWorktreeIsolation()` and `getMergeToMainMode()` are the two entry points all downstream code should use.

### What's fragile
- Node's `--experimental-strip-types` chokes on Unicode in JSDoc comments — any new functions with fancy chars in comments will break tests.

### Authoritative diagnostics
- `validatePreferences({ git: { isolation: "bad" } }).errors` — structured error messages for invalid prefs
- Auto-mode notify messages ("Created auto-worktree" vs absence) indicate which mode is active

### What assumptions changed
- None — the plan was accurate.
