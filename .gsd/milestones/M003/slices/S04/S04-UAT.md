# S04: Preferences + backwards compatibility — UAT

**Milestone:** M003
**Written:** 2026-03-14

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: Preferences are configuration logic — validation and routing are fully testable through automated tests and CLI inspection. No live runtime or visual verification needed.

## Preconditions

- Project checked out with current S04 changes
- Node.js available with `--experimental-strip-types` support
- The resolve-ts.mjs loader is present at `src/resources/extensions/gsd/tests/resolve-ts.mjs`

## Smoke Test

Run `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/preferences-git.test.ts` — should show 21 assertions passing.

## Test Cases

### 1. git.isolation accepts valid values

1. Run: `node -e "const {validatePreferences} = require('./dist/preferences.js'); console.log(JSON.stringify(validatePreferences({git:{isolation:'worktree'}})))"`
   (Or use the test: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/preferences-git.test.ts`)
2. **Expected:** errors array is empty, `preferences.git.isolation` is `"worktree"`. Same for `"branch"`.

### 2. git.isolation rejects invalid values

1. Call `validatePreferences({ git: { isolation: "invalid" } })`
2. **Expected:** errors array contains a string mentioning `"isolation"` and listing valid values.

### 3. git.merge_to_main accepts valid values

1. Call `validatePreferences({ git: { merge_to_main: "milestone" } })`
2. **Expected:** errors array is empty, value preserved. Same for `"slice"`.

### 4. git.merge_to_main rejects invalid values

1. Call `validatePreferences({ git: { merge_to_main: "invalid" } })`
2. **Expected:** errors array contains a string mentioning `"merge_to_main"`.

### 5. shouldUseWorktreeIsolation with explicit preference

1. Call `shouldUseWorktreeIsolation("/tmp/test", { git: { isolation: "branch" } })`
2. **Expected:** returns `false`
3. Call with `{ git: { isolation: "worktree" } }`
4. **Expected:** returns `true`

### 6. shouldUseWorktreeIsolation with legacy detection

1. In a git repo with `gsd/M001/S01` branch, call `shouldUseWorktreeIsolation(repoPath)`
2. **Expected:** returns `false` (legacy project detected)

### 7. shouldUseWorktreeIsolation default (new project)

1. In a git repo with no `gsd/*` branches, call `shouldUseWorktreeIsolation(repoPath)`
2. **Expected:** returns `true` (new project defaults to worktree)

### 8. No merge conflict markers remain

1. Run: `grep -c '<<<<<<' src/resources/extensions/gsd/auto-worktree.ts`
2. **Expected:** returns 0

### 9. TypeScript compiles clean

1. Run: `npx tsc --noEmit`
2. **Expected:** zero errors

## Edge Cases

### Both fields invalid simultaneously

1. Call `validatePreferences({ git: { isolation: "bad", merge_to_main: "bad" } })`
2. **Expected:** errors array contains two entries, one for each field.

### Undefined fields pass through

1. Call `validatePreferences({ git: { auto_push: true } })` (no isolation or merge_to_main)
2. **Expected:** errors array is empty, isolation and merge_to_main are undefined.

### Non-string type for preference values

1. Call `validatePreferences({ git: { isolation: 42 } })`
2. **Expected:** errors array is non-empty (rejects non-string types).

## Failure Signals

- Any test assertion failure in preferences-git.test.ts or isolation-resolver.test.ts
- TypeScript compilation errors
- Merge conflict markers (`<<<<<<`) found in auto-worktree.ts
- Auto-mode creating worktrees when `git.isolation: "branch"` is set

## Requirements Proved By This UAT

- R033 — git.isolation preference validated and respected
- R034 — git.merge_to_main preference validated and respected
- R038 — Backwards compatibility: legacy detection defaults existing projects to branch mode

## Not Proven By This UAT

- R038 full integration — running a complete auto-mode session in branch mode vs worktree mode (deferred to S07)
- merge_to_main: "slice" + isolation: "worktree" end-to-end merge behavior (logic is wired but not integration-tested)

## Notes for Tester

- The automated tests are the primary verification. Run them with the resolve-ts loader as shown in the smoke test.
- The shouldUseWorktreeIsolation tests use the `overridePrefs` parameter to avoid filesystem setup for preference loading.
