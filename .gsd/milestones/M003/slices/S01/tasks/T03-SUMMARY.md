---
id: T03
parent: S01
milestone: M003
provides:
  - All 50 file conflicts fully resolved and staged
  - Zero conflict markers in entire repository
  - Fork's web-mode CLI routing wired into upstream's cli.ts
  - Fork's cross-platform loader features preserved in loader.ts
  - Merge ready for lockfile regeneration and build (T04)
key_files:
  - src/cli.ts
  - src/loader.ts
  - src/onboarding.ts
  - src/resources/extensions/gsd/files.ts
  - src/resources/extensions/gsd/activity-log.ts
  - src/resources/extensions/gsd/dashboard-overlay.ts
  - src/resources/extensions/gsd/guided-flow.ts
  - src/resources/extensions/gsd/worktree-manager.ts
key_decisions:
  - "D048: Keep upstream's procedural cli.ts structure, add web-mode as early-exit routing via imports from cli-web-branch.ts"
  - "D049: Take upstream for all 5 extension modules — no fork re-additions needed"
patterns_established:
  - "Web-mode entry points live in separate modules (cli-web-branch.ts, web-mode.ts, project-sessions.ts) that never conflict with upstream — only import sites in cli.ts need rewiring"
observability_surfaces:
  - "rg '^<<<<<<<|^>>>>>>>|^=======$' src/ web/ packages/ .github/" → empty (zero conflict markers)
  - "git diff --name-only --diff-filter=U" → empty (no unmerged files)
  - "grep 'cli-web-branch\\|stopWebMode' src/cli.ts" → confirms web-mode wiring
duration: 12m
verification_result: passed
completed_at: 2026-03-16
blocker_discovered: false
---

# T03: Resolve remaining extension + CLI entry point conflicts, verify zero markers

**Resolved final 8 conflicted files (5 extension modules + 3 CLI entry points), achieving zero conflict markers across the entire repository.**

## What Happened

Resolved the last 8 files from the upstream merge:

**5 GSD extension modules** — all took upstream with no fork re-additions needed:
- `files.ts` (3 conflicts): upstream added native parser fast-paths with `debugTime`/`nativeParse*`; fork had nothing at those locations
- `activity-log.ts` (6 conflicts): upstream optimized memory/IO (#611) — streaming writes, lightweight dedup fingerprints, atomic file creation; fork had older simpler code
- `dashboard-overlay.ts` (4 conflicts): upstream added `disposed` flag for cleanup safety; fork had nothing
- `guided-flow.ts` (2 conflicts): upstream added `pendingAutoStart` and `workingDirectory` field; fork had nothing
- `worktree-manager.ts` (5 conflicts): upstream replaced `execSync` shell-outs with native git bridge calls; fork had older `runGit`/`GIT_NO_PROMPT_ENV` pattern

**3 CLI entry points** — took upstream + re-wired fork's web-mode additions:
- `cli.ts` (6 conflicts): Took upstream's procedural top-level structure. Added imports for `parseWebCliArgs`/`runWebCliBranch`/`migrateLegacyFlatSessions` from `cli-web-branch.ts`, `stopWebMode` from `web-mode.ts`, `getProjectSessionsDir` from `project-sessions.ts`. Added `--web` flag to CliFlags and parseCliArgs. Added web-mode routing (web stop + web launch) as early-exit checks before interactive mode. Replaced inline session migration with extracted module calls. Added `--web` hint in TTY error message. Removed unused `existsSync`/`readdirSync`/`renameSync` imports.
- `loader.ts` (1 conflict): upstream added fast-path for `--version`/`--help` before heavy imports; fork had nothing there. All fork additions (delimiter, serializeBundledExtensionPaths, dynamic extension discovery) were outside the conflict region and preserved.
- `onboarding.ts` (3 conflicts): upstream added `ollama-cloud` provider support; fork added `loadStoredEnvKeys` which already lives in `wizard.ts`. Took upstream — no web-mode onboarding code existed (plan's description was inaccurate; the fork's "web" references in onboarding were about web *search* configuration, not web *mode*).

## Verification

- `rg "^<<<<<<<|^>>>>>>>|^=======$" src/ web/ packages/ .github/` → empty (exit 1) ✅
- `git diff --check` → clean ✅
- `git diff --name-only --diff-filter=U` → empty (no unmerged files) ✅
- `grep "cli-web-branch" src/cli.ts` → confirms web branch import present ✅
- `grep "stopWebMode" src/cli.ts` → confirms web mode stop import present ✅
- `grep "delimiter" src/loader.ts` → confirms cross-platform fix present ✅
- `grep "web" src/onboarding.ts` → web search onboarding present ✅

**Slice-level checks (T03 is intermediate — not all expected to pass yet):**
- Zero conflict markers: ✅ PASS
- `npm run build`: ⏳ Not run yet (T04 responsibility — needs lockfile first)
- `npm run build:web-host`: ⏳ Not run yet (T04)
- Upstream delta: ⏳ Merge not yet committed

## Diagnostics

- **Conflict markers**: `rg "^<<<<<<<|^>>>>>>>|^=======$" .` with git/node_modules exclusions — must return empty
- **Merge status**: `git status` — should show merge in progress with all conflicts resolved
- **Web-mode wiring**: `grep -n "runWebCliBranch\|stopWebMode\|parseWebCliArgs\|getProjectSessionsDir\|migrateLegacyFlatSessions" src/cli.ts` — all 5 fork modules should appear
- **Fork ref files**: saved at `/tmp/fork-ref/` for post-hoc comparison if needed

## Deviations

- **onboarding.ts**: Plan expected ~104 lines of web-mode onboarding code to re-add. In reality, the fork's additions were `loadStoredEnvKeys` (env hydration, not web-mode) which already exists in `wizard.ts`. No web-mode onboarding path existed. Took upstream cleanly.
- **cli.ts**: Plan suggested re-adding `runCli` export with `CliDeps` DI pattern. Dropped it since nothing imports `runCli` — upstream's procedural top-level is simpler and reduces future merge friction.

## Known Issues

None — all 50 conflicts resolved, zero markers, merge is ready for T04.

## Files Created/Modified

- `src/cli.ts` — upstream code + fork's web-mode routing (imports, --web flag, early-exit routing, extracted session helpers)
- `src/loader.ts` — upstream's fast-path for --version/--help added; fork's delimiter/extension discovery preserved
- `src/onboarding.ts` — upstream's version with ollama-cloud support
- `src/resources/extensions/gsd/files.ts` — upstream's native parser fast-paths resolved
- `src/resources/extensions/gsd/activity-log.ts` — upstream's #611 memory/IO optimizations
- `src/resources/extensions/gsd/dashboard-overlay.ts` — upstream's disposed cleanup guard
- `src/resources/extensions/gsd/guided-flow.ts` — upstream's pendingAutoStart + workingDirectory
- `src/resources/extensions/gsd/worktree-manager.ts` — upstream's native git bridge calls
- `.gsd/milestones/M003/slices/S01/tasks/T03-PLAN.md` — added Observability Impact section
