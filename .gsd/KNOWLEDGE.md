# Knowledge Base

## Git Merge: Duplicate Conflict Hunks in Large Files

When a file has the same pattern repeated (e.g., a type definition and its usage both diverged identically), git produces multiple conflict hunks with nearly identical marker content. `edit` tool matches on exact text, so if you edit the first hunk, a second identical hunk may remain. After resolving conflicts in any file, always run `rg "^<<<<<<<|^>>>>>>>|^=======$" <file>` to catch duplicates before staging.

## Git Index Lock from Parallel Commands

Running multiple `git` commands in parallel (e.g., `git checkout` and `git add` simultaneously) causes `index.lock` contention. Always run git commands sequentially in the same repo. If you hit `index.lock`, `rm -f .git/index.lock` and retry.

## Conflict Marker Search: Use Anchored Patterns

`rg "<<<<<<|>>>>>>|======" packages/` matches comment divider lines (`// ====...`). Use anchored patterns `rg "^<<<<<<<|^>>>>>>>|^=======$"` to match only real conflict markers.

## GSD Extension Web Import Graph

Web code (`src/web/`) only imports from `native-git-bridge.ts` — NOT from auto.ts, index.ts, commands.ts, state.ts, preferences.ts, types.ts, or git-service.ts. When resolving merge conflicts in GSD extension core modules, check `rg 'from.*extensions/gsd/' src/web/` to verify whether fork additions actually have web consumers before spending time re-adding them.

## Upstream Cache API Consolidation

Upstream replaced per-module cache clears (`clearParseCache` from files.ts, `clearPathCache` from paths.ts, `invalidateStateCache` from state.ts) with `invalidateAllCaches()` from `cache.ts`. The individual exports may no longer exist. Any code importing them needs migration to the centralized API.

## Clean dist/ Before Rebuilding After Merge

After a large upstream merge, stale `.d.ts` files in `packages/*/dist/` can trigger TS5055 ("Cannot write file ... would overwrite input file"). Always `rm -rf packages/*/dist/` before the first build after a merge. The build chain recreates dist/ from source.

## Fork Files Must Not Import from dist/

Fork-only files in `packages/pi-ai/src/` (like `web-runtime-oauth.ts`) that import from `../dist/` create circular build dependencies — dist doesn't exist until the build runs, but the build can't run without dist. Change to source-relative imports (`./oauth.js` instead of `../dist/oauth.js`).

## Conflict Marker Scanning — Use Anchored Patterns

`rg "======"` matches JavaScript strict equality operators (`===`). Always use anchored patterns for conflict marker scans: `rg "^<<<<<<<|^>>>>>>>|^=======$"` to avoid false positives.

## Parity Contract Test — EXPECTED_BUILTIN_OUTCOMES Drift

`EXPECTED_BUILTIN_OUTCOMES` in `web-command-parity-contract.test.ts` must stay in sync with upstream's `BUILTIN_SLASH_COMMANDS`. As of M003/S02, upstream added `provider` (21 commands total) but the map only has 20. The size assertion at the top of the test catches this. When updating the test, check for new builtins first.

## Turbopack Cannot Resolve .js→.ts Extension Imports

Extension modules under `src/resources/extensions/gsd/` use Node ESM `.js` import extensions (e.g. `import { deriveState } from './state.js'`) which work at runtime with `--experimental-strip-types` but fail in Turbopack bundling because the actual files are `.ts`. Any web service that needs to call extension code must use the child-process pattern (`execFile` + `resolve-ts.mjs` loader) instead of direct imports. See `auto-dashboard-service.ts`, `recovery-diagnostics-service.ts`, and `visualizer-service.ts` for examples.
