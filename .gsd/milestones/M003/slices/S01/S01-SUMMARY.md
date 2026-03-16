---
id: S01
parent: M003
milestone: M003
provides:
  - All 415 upstream commits (v2.12→v2.22.0) merged into fork — zero remaining delta
  - All 50 file conflicts resolved with zero residual conflict markers
  - npm run build exits 0 (5 workspace packages + main tsc)
  - npm run build:web-host exits 0 (Next.js production build + standalone staging)
  - package-lock.json regenerated from merged package.json
  - Fork web-mode code paths preserved — cli-web-branch.ts, web-mode.ts, bridge-service.ts imports resolve
requires: []
affects:
  - S02
  - S03
  - S04
  - S05
  - S06
  - S07
key_files:
  - src/cli.ts
  - src/loader.ts
  - src/onboarding.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/index.ts
  - src/resources/extensions/gsd/commands.ts
  - src/resources/extensions/gsd/state.ts
  - src/resources/extensions/gsd/preferences.ts
  - src/resources/extensions/gsd/types.ts
  - src/resources/extensions/gsd/git-service.ts
  - src/resources/extensions/gsd/files.ts
  - src/resources/extensions/gsd/activity-log.ts
  - src/resources/extensions/gsd/dashboard-overlay.ts
  - src/resources/extensions/gsd/guided-flow.ts
  - src/resources/extensions/gsd/worktree-manager.ts
  - src/web-mode.ts
  - packages/pi-ai/src/web-runtime-oauth.ts
  - src/resources/extensions/gsd/paths.ts
  - packages/pi-tui/src/components/editor.ts
  - package.json
  - package-lock.json
key_decisions:
  - "D046: Use upstream's centralized invalidateAllCaches() from cache.ts — fork's individual cache clears are obsolete"
  - "D047: Take upstream for all 7 GSD extension core modules without fork re-additions — no web code imports from these files"
  - "D048: Keep upstream's procedural cli.ts structure, add web-mode as early-exit routing via cli-web-branch.ts imports"
  - "D049: Take upstream for all 5 remaining extension modules — no fork re-additions needed"
  - "D050: Add local openBrowser() in web-mode.ts rather than exporting from onboarding.ts — avoids modifying upstream's private API"
patterns_established:
  - "Web code (src/web/) only imports from native-git-bridge.ts — not from GSD extension core modules. Verify import graph before assuming fork additions need preservation."
  - "Web-mode entry points live in separate modules (cli-web-branch.ts, web-mode.ts, project-sessions.ts) that never conflict with upstream — only import sites in cli.ts need rewiring."
  - "After large merges, always rm -rf packages/*/dist/ before first build to avoid TS5055 stale .d.ts conflicts."
  - "Fork files must use source-relative imports, never ../dist/ — dist doesn't exist until build runs."
  - "Take-upstream for test files — upstream rewrote tests for new APIs; fork-specific web tests live in separate non-conflicting files."
  - "Use anchored patterns for conflict marker scans: ^<<<<<<<|^>>>>>>>|^=======$ — unanchored ====== matches JS strict equality operators."
observability_surfaces:
  - "`npm run build` exit code — non-zero indicates regression"
  - "`npm run build:web-host` exit code — non-zero indicates web host regression"
  - "`rg '^<<<<<<<|^>>>>>>>|^=======$' src/ web/ packages/ .github/` — must return empty"
  - "`git log --oneline HEAD..upstream/main | wc -l` — must be 0"
drill_down_paths:
  - .gsd/milestones/M003/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M003/slices/S01/tasks/T02-SUMMARY.md
  - .gsd/milestones/M003/slices/S01/tasks/T03-SUMMARY.md
  - .gsd/milestones/M003/slices/S01/tasks/T04-SUMMARY.md
duration: ~67min
verification_result: passed
completed_at: 2026-03-16
---

# S01: Upstream merge and build stabilization

**Merged 415 upstream commits (v2.12→v2.22.0), resolved all 50 file conflicts, and achieved green builds for both `npm run build` and `npm run build:web-host`.**

## What Happened

The merge brought upstream from v2.12 to v2.22.0 (415 commits — 17 more than the 398 estimated during research, since upstream released v2.22.0 in the interim). All 50 file conflicts were resolved across 4 tasks:

**T01 (35 files):** Initiated the merge and cleared the mechanical conflicts — batch take-upstream for .gitignore, CHANGELOG, native crates, native package.json files, native-git-bridge.ts, post-unit-hooks.ts. Deleted orphaned-branch.test.ts per upstream. Deleted package-lock.json (regenerated in T04). Manually merged package.json preserving fork's web scripts (`stage:web-host`, `build:web-host`, `gsd:web`, `gsd:web:stop`, `gsd:web:stop:all`) while adopting upstream's copy-*.cjs scripts and v2.22.0 version. Resolved ci.yml, env-api-keys.ts, settings-manager.ts, editor.ts. Took upstream for all 8 prompt files and 11 test files.

**T02 (7 files):** Resolved the GSD extension core modules — the hardest conflicts where upstream performed structural rewrites (auto.ts decomposition, preferences rewrite, git-service slimming to ~94 lines). Key discovery: **no web code imports from any of these 7 modules** (`src/web/` only imports from `native-git-bridge.ts`). Fork's additions were internal optimizations that upstream independently implemented or superseded. All 7 taken from upstream with zero re-additions needed.

**T03 (8 files):** Resolved the remaining 5 extension modules (files.ts, activity-log.ts, dashboard-overlay.ts, guided-flow.ts, worktree-manager.ts — all take-upstream) plus the 3 CLI entry points. `cli.ts` required the most care: took upstream's procedural structure and re-wired fork's web-mode routing via imports from `cli-web-branch.ts`, `web-mode.ts`, and `project-sessions.ts`. `loader.ts` auto-resolved (fork additions were outside conflict region). `onboarding.ts` taken from upstream — no web-mode onboarding code existed (plan's description was inaccurate). Whole-repo conflict marker sweep confirmed zero markers.

**T04 (build stabilization):** Regenerated package-lock.json via `npm install`. Fixed 4 TypeScript errors: stale closing braces in editor.ts (merge detritus), stale `.d.ts` files in packages/*/dist/ (TS5055), circular import in web-runtime-oauth.ts (`../dist/oauth.js` → `./oauth.js`), duplicate cache declarations in paths.ts, and missing `openBrowser` function in web-mode.ts (added local copy). Both `npm run build` and `npm run build:web-host` exit 0.

## Verification

| Check | Result |
|---|---|
| `rg "^<<<<<<<\|^>>>>>>>\|^=======$" src/ web/ packages/ .github/` | ✅ Empty — zero conflict markers |
| `npm run build` | ✅ Exit 0 |
| `npm run build:web-host` | ✅ Exit 0 |
| `git log --oneline HEAD..upstream/main \| wc -l` | ✅ 0 — all upstream commits present |
| `test -f package-lock.json` | ✅ Present |

## Requirements Advanced

- R100 — All 415 upstream commits merged, all 50 conflicts resolved, both builds pass. Fully satisfied.

## Requirements Validated

- R100 — `npm run build` exit 0, `npm run build:web-host` exit 0, zero conflict markers, zero upstream delta. All four verification criteria from the requirement are met.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- **415 commits instead of 398**: Upstream released v2.22.0 between research and execution, adding 17 commits. No impact on conflict count or resolution strategy.
- **No fork re-additions needed for 12 of 12 extension modules**: Plan anticipated needing to re-add fork web hooks, web types, and web bridge code to several extension files. Investigation proved web code has no import dependencies on any of them — only `native-git-bridge.ts` (resolved in T01 as take-upstream).
- **onboarding.ts had no web-mode code**: Plan expected ~104 lines of web-mode onboarding to re-add. The fork's additions were `loadStoredEnvKeys` (env hydration, not web-mode) which already exists in `wizard.ts`.
- **cli.ts dropped runCli() export**: Plan suggested preserving the CliDeps DI pattern. Dropped because nothing imports `runCli` — upstream's procedural approach is simpler.
- **Merge commit auto-created**: T01's auto-commit absorbed the `git merge upstream/main`. No separate T04 commit was needed.

## Known Limitations

- `@gsd/native` warning in web-host build — expected and harmless (dynamic require guarded by try/catch at runtime).
- 1 pre-existing moderate npm vulnerability — not introduced by this merge.
- Runtime behavior not yet verified — S01 is build-only; runtime correctness is S02+ scope.

## Follow-ups

- none — all planned work completed within the 4 tasks.

## Files Created/Modified

- `package.json` — merged: upstream v2.22.0 + fork web scripts + upstream copy-*.cjs scripts
- `package-lock.json` — regenerated from merged package.json
- `.github/workflows/ci.yml` — added upstream's typecheck:extensions step
- `src/cli.ts` — upstream code + fork's web-mode routing (imports, --web flag, early-exit routing)
- `src/loader.ts` — upstream's fast-path for --version/--help; fork's delimiter/extension discovery preserved
- `src/onboarding.ts` — upstream's version with ollama-cloud support
- `src/web-mode.ts` — added local openBrowser(), merged child_process imports
- `src/resources/extensions/gsd/auto.ts` — took upstream (decomposed auto module)
- `src/resources/extensions/gsd/index.ts` — took upstream (pauseAutoForProviderError)
- `src/resources/extensions/gsd/commands.ts` — took upstream (15+ subcommands including hooks)
- `src/resources/extensions/gsd/state.ts` — took upstream (DB-first loading, debug instrumentation)
- `src/resources/extensions/gsd/preferences.ts` — took upstream (major rewrite)
- `src/resources/extensions/gsd/types.ts` — took upstream (expanded types)
- `src/resources/extensions/gsd/git-service.ts` — took upstream (slimmed, moved to native-git-bridge)
- `src/resources/extensions/gsd/files.ts` — took upstream (native parser fast-paths)
- `src/resources/extensions/gsd/activity-log.ts` — took upstream (#611 memory/IO optimizations)
- `src/resources/extensions/gsd/dashboard-overlay.ts` — took upstream (disposed cleanup guard)
- `src/resources/extensions/gsd/guided-flow.ts` — took upstream (pendingAutoStart + workingDirectory)
- `src/resources/extensions/gsd/worktree-manager.ts` — took upstream (native git bridge calls)
- `packages/pi-tui/src/components/editor.ts` — removed stale closing braces (merge detritus)
- `packages/pi-ai/src/web-runtime-oauth.ts` — changed import to source-relative (circular dependency fix)
- `packages/pi-ai/src/env-api-keys.ts` — added ollama-cloud API key mapping
- `packages/pi-coding-agent/src/core/settings-manager.ts` — added ModelDiscovery interface + accessors
- `src/resources/extensions/gsd/paths.ts` — removed duplicate cache declaration block
- `.gitignore` — taken from upstream
- `CHANGELOG.md` — taken from upstream
- `native/crates/engine/src/git.rs` — taken from upstream
- `native/npm/*/package.json` (5 files) — taken from upstream
- `src/resources/extensions/gsd/native-git-bridge.ts` — taken from upstream
- `src/resources/extensions/gsd/post-unit-hooks.ts` — taken from upstream
- `src/resources/extensions/gsd/tests/orphaned-branch.test.ts` — deleted (upstream deletion)
- `src/resources/extensions/gsd/prompts/*.md` (8 files) — taken from upstream
- `src/resources/extensions/gsd/tests/*.test.ts` (10 files) + resolve-ts-hooks.mjs — taken from upstream
- `src/tests/integration/pack-install.test.ts` — taken from upstream

## Forward Intelligence

### What the next slice should know
- Web code (`src/web/`, `web/`) has **zero import dependencies** on GSD extension core modules. It only imports from `native-git-bridge.ts`. New browser surfaces for upstream features (S02–S07) will need to create their own API routes and bridge methods rather than importing upstream modules directly.
- Upstream decomposed `auto.ts` into 6+ focused modules: `auto-dispatch.ts`, `auto-recovery.ts`, `auto-dashboard.ts`, `auto-prompts.ts`, `auto-supervisor.ts`, `auto-worktree.ts`. The new command handlers (`forensics.ts`, `captures.ts`, `quick.ts`, `history.ts`, `undo.ts`, `visualizer-data.ts`, `visualizer-views.ts`, `model-router.ts`, `complexity-classifier.ts`, `context-budget.ts`, `skill-health.ts`) are all available as separate modules.
- Upstream's `commands.ts` now registers 15+ subcommands including `hooks`, `forensics`, `doctor`, `skill-health`, `captures`, `quick`, `history`, `undo`, `visualize`, `export`, `config`, `steer`, `mode`, `inspect`, `cleanup`. These are the authoritative command names for S02 dispatch wiring.

### What's fragile
- `web-mode.ts` has a local copy of `openBrowser()` instead of importing from `onboarding.ts` — if upstream changes the browser-opening logic, both copies need updating.
- `@gsd/native` produces a warning during web-host build — this is expected but could mask a real native module issue if it changes character.

### Authoritative diagnostics
- `npm run build && npm run build:web-host` — the primary health signal. Non-zero exit on either indicates regression.
- `rg "^<<<<<<<|^>>>>>>>|^=======$" src/ web/ packages/` — conflict marker sweep. Must always be empty.

### What assumptions changed
- Research estimated 398 upstream commits (v2.12→v2.21) — actual was 415 commits to v2.22.0. No material impact.
- Plan assumed fork had web-mode hooks in `index.ts` and web types in `types.ts` that needed re-adding — neither existed. The web import graph is much more isolated than expected.
- Plan assumed `onboarding.ts` had web-mode onboarding code — it didn't. Fork's onboarding changes were env hydration only.
