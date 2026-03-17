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

## Node --experimental-strip-types Cannot Handle .tsx Files

Node v25's `--experimental-strip-types` handles `.ts` but NOT `.tsx`. Even `module-typescript` format fails because `.tsx` files may contain actual JSX syntax (not just TypeScript types). The test resolver's load hook must use TypeScript's `transpileModule` with `jsx: ReactJSX` to fully transpile `.tsx` → JS before serving to the runtime. Additionally, transpiled `.tsx` files emit extensionless imports (Next.js convention) which need a resolve guard to try `.ts`/`.tsx` extensions.

## dist-redirect.mjs /dist/ Guard

The test resolver's `.js→.ts` rewrite must NOT apply to imports containing `/dist/` — those `.js` files are real compiled artifacts from package builds. The guard `!specifier.includes('/dist/')` in the else-if condition is the minimal fix. Don't over-restrict by blocking all `../` paths since many legitimate `.js→.ts` rewrites use `../` prefixes.

## Auto-Commit May Not Include Code Changes

GSD auto-commit runs after task summaries are written. If the executor writes a summary but doesn't actually modify the source files (e.g., T02 in M006/S01), the commit only captures the summary markdown. Always verify prior task outputs exist in the actual codebase, not just in the summary file. Use `git diff <commit>..HEAD --stat` to check what was actually committed.

## GSD TUI Select Option Detection Must Precede isPromptLine

GSD's shared UI uses `›` as the cursor glyph (`INDENT.cursor = "› "`). After ANSI stripping, a selected option renders as `  › N. Label`. The `›` character is also a `PROMPT_MARKER` in PtyChatParser. If you run `isPromptLine` before TUI option detection, selected option lines get mishandled as prompt boundaries. Always check `SELECT_OPTION_SELECTED_RE` before `isPromptLine` in any PTY line handler.

## GSD Test Fixtures in web/lib/ Break tsc --noEmit

The `web/tsconfig.json` includes `**/*.ts`, so any test fixture or scratch file in `web/lib/` that uses top-level `await` or `.ts` import extensions will produce tsc errors. Either exclude test files from tsconfig or run fixtures with `npx tsx` directly and delete them after use. The fixture is for manual verification only — it's not part of the permanent test suite.

## StreamingCursor Keyframe Must Use Inline Style, Not Tailwind animate-[]

The Tailwind `animate-[chat-cursor_...]` arbitrary value syntax does NOT work for custom keyframes defined in `globals.css` unless they are also registered in the Tailwind config's `keyframes` block. Use `style={{ animation: "chat-cursor 1s ease-in-out infinite" }}` to reference a keyframe defined in CSS directly. This avoids having to add the keyframe to `tailwind.config.ts`.

## MarkdownContent Streaming Update Pattern: Single useEffect([content])

For streaming chat bubbles where content updates frequently, use a single `useEffect([content])` that re-runs the full dynamic import chain. After the first render, all imports resolve instantly from the module cache (no network hit), so re-running is cheap. The two-effect approach (one for module loading, one for content updates) introduces a stale-closure risk where the first effect's `cancelled` flag remains `true` after cleanup and suppresses subsequent updates.
