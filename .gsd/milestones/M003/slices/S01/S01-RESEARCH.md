# S01: Upstream Merge and Build Stabilization — Research

**Date:** 2026-03-16

## Summary

The merge of 398 upstream commits into the fork touches 447 files with 79,261 insertions and 8,164 deletions. Git's `merge-tree` identifies **51 conflicted files** — every other file applies cleanly. The 138 web-only files (`web/`, `src/web/`) have **zero** upstream conflicts since upstream never touched that directory.

The conflicts cluster into clear tiers. The hardest is `auto.ts`, where upstream performed a massive decomposition (1825+/2038- lines, extracting 6 new modules) while our fork added ~263 lines (dispatch gap watchdog, hook imports, cache invalidation). Critically, **upstream independently implemented the same dispatch gap watchdog and hook imports** our fork added — so most fork additions to auto.ts are already in upstream's version, just structured differently. The second tier involves files where both sides independently created the same file (`native-git-bridge.ts`, `post-unit-hooks.ts`, `bundled-extension-paths.ts`) — in each case upstream's version is a strict superset of the fork's. The third tier is files where our fork made surgical additions (web-mode branching in `cli.ts`, `loader.ts`, `onboarding.ts`) while upstream made moderate-to-heavy changes to surrounding code. The bottom tier is mechanical: `package.json`, lockfile, native package versions, prompts, and tests.

The core strategy is: **take upstream for everything it rewrote, then re-apply our fork's web-mode additions on top**. This works because our fork's changes are almost entirely *additive* (new imports, new code paths, new exports) while upstream's changes are *structural* (refactoring, decomposition, API evolution). The two rarely touch the same lines — they touch the same files but in different regions.

## Recommendation

Execute a single `git merge upstream/main` and resolve conflicts file-by-file using a tiered approach:

1. **"Take upstream" files (20 files):** Where upstream's version is a superset of fork's work — `native-git-bridge.ts`, `post-unit-hooks.ts`, native package.json files, `CHANGELOG.md`, `.gitignore`, several tests. Use `git checkout upstream/main -- <file>`.
2. **"Take upstream + re-apply fork additions" files (15 files):** `auto.ts`, `cli.ts`, `loader.ts`, `onboarding.ts`, `index.ts`, `commands.ts`, `state.ts`, `types.ts`, `preferences.ts`, `git-service.ts`, `guided-flow.ts`, `worktree-manager.ts`, `activity-log.ts`, `files.ts`, `dashboard-overlay.ts`. Start from upstream's version, then surgically re-add fork-specific code (web imports, web code paths, cache invalidation exports).
3. **"Merge both" files (6 files):** `package.json`, `package-lock.json`, `env-api-keys.ts`, `settings-manager.ts`, `editor.ts`, `ci.yml`. Both sides added different things — combine them.
4. **"Take fork + add upstream changes" files (10 files):** Prompts where both sides made different additive changes.

After resolving all conflicts: `npm install` to regenerate lockfile, then `npm run build` and `npm run build:web-host` as the proof gate.

## Implementation Landscape

### Key Files

**Tier 1 — Hardest conflicts (structural rewrite + fork additions):**

- `src/resources/extensions/gsd/auto.ts` — Fork: 3726 lines, Upstream: 3250 lines, Base: 3463 lines. Upstream decomposed into 6 modules (auto-dispatch.ts, auto-recovery.ts, auto-dashboard.ts, auto-prompts.ts, auto-supervisor.ts, auto-worktree.ts). Fork added dispatch gap watchdog, post-unit-hooks integration, cache invalidation imports. **Key insight: upstream independently added the same dispatch gap watchdog (line 322) and the same hook imports.** Resolution: take upstream, verify fork's `clearPathCache`/`clearParseCache`/`invalidateStateCache` imports are present (they may not be — upstream uses `invalidateAllCaches` from a new `cache.ts` module instead).
- `src/cli.ts` — Fork extracted `CliDeps` interface, `RunWebCliBranchDeps`, moved arg parsing to `cli-web-branch.ts`, added `stopWebMode` import. Upstream added 63 lines (23 removed) — moderate changes. Resolution: take upstream, re-add the web-mode branching (`cli-web-branch.ts` import, `stopWebMode` import, `CliDeps`/`RunWebCliBranchDeps` integration, `getProjectSessionsDir`/`migrateLegacyFlatSessions`/`parseCliArgs`/`runWebCliBranch` imports).
- `src/resources/extensions/gsd/index.ts` — Fork added 62 lines (web bridge hooks). Upstream added 397 lines (many new command registrations). Resolution: take upstream, re-add web-mode exports/hooks.
- `src/resources/extensions/gsd/state.ts` — Fork: 130+/18-. Upstream: 164+/29-. Both enhanced state derivation. Resolution: take upstream, re-add any fork-only state fields.
- `src/resources/extensions/gsd/preferences.ts` — Fork: 232+/1-. Upstream: 747+/133-. Massive upstream rewrite. Resolution: take upstream, re-add fork's web-specific preference exports if any.

**Tier 2 — Both-sides-created files (fork is subset of upstream):**

- `src/resources/extensions/gsd/native-git-bridge.ts` — Fork: 181 lines, 8 exports. Upstream: 1017 lines, 15+ exports (strict superset). **Take upstream.**
- `src/resources/extensions/gsd/post-unit-hooks.ts` — Fork: 449 lines, 10 exports. Upstream: 519 lines, 13 exports (strict superset + `formatHookStatus` which fork put in auto.ts). **Take upstream.** Fork's `formatHookStatus` in auto.ts must be removed since upstream moved it here.
- `src/bundled-extension-paths.ts` — Both sides created. Fork has dynamic discovery. Upstream likely has similar. Need line-by-line comparison.
- `src/resources/extensions/shared/bundled-extension-paths.ts` — Same pattern, compare and take the more complete version.

**Tier 3 — Surgical fork additions to files upstream moderately changed:**

- `src/loader.ts` — Fork changed NODE_PATH joining to use `delimiter`, added `serializeBundledExtensionPaths` import, rewrote GSD_BUNDLED_EXTENSION_PATHS to dynamic discovery. Upstream likely made different loader changes. Re-apply fork's dynamic extension path discovery.
- `src/onboarding.ts` — Fork: 104+/1-. Upstream: 182+/30-. Fork added web-mode onboarding path. Upstream enhanced onboarding flow. Take upstream, re-add web-mode path.
- `src/resources/extensions/gsd/commands.ts` — Fork added `hooks` subcommand. Upstream added ~15 new subcommands. Take upstream (which likely includes hooks or a superset).
- `src/resources/extensions/gsd/git-service.ts` — Fork: 46+/41-. Upstream: 94+/476- (massive slimming, moved to native-git-bridge). Take upstream, verify web git-summary-service.ts imports still resolve.
- `src/resources/extensions/gsd/types.ts` — Fork: 109+ (web types). Upstream: 179+/1-. Both additive. Take upstream, re-add fork's web-specific types.
- `src/resources/extensions/gsd/guided-flow.ts` — Fork: 40+/9-. Upstream: 506+/34-. Take upstream, re-add fork changes.
- `src/resources/extensions/gsd/worktree-manager.ts` — Fork: 72+/13-. Upstream: 184+/134-. Take upstream, re-add fork additions.
- `src/resources/extensions/gsd/dashboard-overlay.ts` — Both sides changed. Take upstream, re-add fork additions.
- `src/resources/extensions/gsd/files.ts` — Both sides changed. Take upstream, re-add fork additions (clearParseCache export, etc.).
- `src/resources/extensions/gsd/activity-log.ts` — Both sides changed. Take upstream, re-add fork additions.

**Tier 4 — Mechanical merges:**

- `package.json` — Both sides added dependencies and scripts. Fork added web scripts (`stage:web-host`, `gsd`, `gsd:web`, etc.). Upstream added new deps. **Merge both, run `npm install`.**
- `package-lock.json` — **Delete and regenerate** with `npm install` after package.json is resolved.
- `packages/pi-ai/src/env-api-keys.ts` — Both sides changed. Likely additive.
- `packages/pi-coding-agent/src/core/settings-manager.ts` — Both sides changed. Likely additive.
- `packages/pi-tui/src/components/editor.ts` — Both sides changed.
- `.github/workflows/ci.yml` — Both sides changed. Merge both.
- `native/npm/*/package.json` (5 files) — Version bumps. Take upstream.
- `native/crates/engine/src/git.rs` — Both sides created. Take upstream (fork didn't modify Rust code meaningfully).
- `CHANGELOG.md` — Take upstream, our entries are in git history.

**Tier 5 — Prompts and tests:**

- 7 prompt `.md` files — Both sides edited. Content additions are independent. Merge both.
- 11 test files — Upstream rewrote tests to match new APIs. **Take upstream** for tests that test upstream code. Keep fork tests that test web features.
- `src/tests/integration/pack-install.test.ts` — Both sides changed. Take upstream, re-add web assertions.

**Files that won't conflict (safe):**

- 138 web-only files (`web/`, `src/web/`) — fork additions, zero upstream changes
- Fork-only `src/` files: `cli-web-branch.ts`, `web-mode.ts`, `project-sessions.ts`, `src/web/*`, web test files — all new, no conflicts
- 120+ new upstream files — auto-applied cleanly (new modules, new tests, new features)

### Build Order

1. **Execute `git merge upstream/main`** — creates conflict markers in 51 files
2. **Resolve Tier 2 first** (take-upstream files) — fastest wins, ~20 files cleared immediately
3. **Resolve Tier 4** (mechanical: package.json, native packages, CI, changelog) — clears ~12 files
4. **Resolve Tier 5** (prompts + tests) — clears ~18 files
5. **Resolve Tier 3** (surgical re-additions) — ~10 files, moderate effort
6. **Resolve Tier 1 last** (auto.ts, cli.ts, index.ts, state.ts, preferences.ts) — hardest, needs most care
7. **Run `npm install`** — regenerate lockfile from resolved package.json
8. **Run `npm run build`** — first proof gate
9. **Fix any TypeScript errors** — likely from changed upstream interfaces that web code references
10. **Run `npm run build:web-host`** — second proof gate

### Verification Approach

- **Primary:** `npm run build` succeeds (compiles entire TypeScript codebase)
- **Secondary:** `npm run build:web-host` succeeds (compiles Next.js web host)
- **Tertiary:** `npm run test:unit` passes (catches runtime contract breaks)
- **Spot-check:** `git diff --check` confirms no leftover conflict markers
- **Import verification:** `rg "<<<<<<|>>>>>>|======" src/ web/ packages/` confirms zero residual markers

## Constraints

- The merge must be done on the `main` branch of the fork (not in a worktree) since it's a merge commit, not a rebase.
- `package-lock.json` should be deleted and regenerated rather than manually resolved — it's a generated file.
- Fork's `cli-web-branch.ts` and `web-mode.ts` are not in upstream and won't conflict, but the *import sites* in `cli.ts` and `loader.ts` are in conflict zones.
- Upstream deleted `src/resources/extensions/browser-tools/core.d.ts` and `tests/orphaned-branch.test.ts` — these deletions should be accepted.
- The fork's `src/resources/extensions/gsd/milestone-id-utils.ts` is fork-only and not in any conflict — safe.

## Common Pitfalls

- **Forgetting to remove fork's `formatHookStatus` from `auto.ts`** — upstream moved it to `post-unit-hooks.ts`. If both copies survive, you get a duplicate export error. The fork imports it from `post-unit-hooks.ts` in `commands.ts`, and upstream exports it from there too, so the fix is: take upstream's `auto.ts` which doesn't have it.
- **Assuming fork's cache invalidation imports still work** — fork imports `clearParseCache`, `clearPathCache`, `invalidateStateCache` from individual modules. Upstream introduced a centralized `invalidateAllCaches` in `cache.ts`. If the individual functions were removed upstream, the fork's imports will break. Check whether upstream still exports them individually or only via the cache module.
- **Lockfile merge hell** — never manually resolve `package-lock.json`. Delete it, resolve `package.json`, run `npm install`.
- **TypeScript errors in web code after merge** — upstream changed interfaces in `types.ts`, `state.ts`, `preferences.ts`. Web code (`gsd-workspace-store.tsx`, `bridge-service.ts`, `command-surface-contract.ts`) imports types from these. The web code doesn't *directly* import from `src/resources/extensions/gsd/` (it uses its own type definitions), but `src/web/bridge-service.ts` imports from `packages/pi-coding-agent/`, and `src/web/git-summary-service.ts` imports from `native-git-bridge.ts`. These import paths must still resolve after merge.
- **ci.yml merge** — fork added web build steps, upstream added new test steps. Both are additive but the YAML structure may create false conflicts at list boundaries.

## Open Risks

- **auto.ts cache invalidation pattern divergence** — Fork uses per-module cache clear functions (`clearParseCache`, `clearPathCache`, `invalidateStateCache`). Upstream may have replaced these with `invalidateAllCaches()` from `cache.ts`. If so, the fork's fine-grained invalidation in web bridge code needs updating to use the new centralized function.
- **Upstream worktree architecture changes** — Upstream's branchless worktree architecture (auto-worktree.ts) changes assumptions about branch names and worktree paths. The web bridge's session/cwd resolution (`bridge-service.ts`) may need minor updates if the path conventions changed.
- **Build order dependencies** — `npm run build` builds packages in order (pi-tui → pi-ai → pi-agent-core → pi-coding-agent → tsc). If upstream added new package dependencies, the build chain may break at an intermediate step requiring package-level fixes first.
- **Test breakage from interface changes** — Even after build succeeds, unit tests may fail because upstream changed mock shapes, test helpers, or assertion patterns in the 11 conflicted test files. This is expected and should be fixed in S09, not S01 — S01's gate is build success, not test suite green.

## Sources

- Conflict analysis via `git merge-tree --write-tree HEAD upstream/main`
- Diffstat analysis via `git diff --stat HEAD...upstream/main` (447 files, 79261+/8164-)
- Fork-vs-upstream change comparison via `git diff $(git merge-base)..HEAD` and `git diff $(git merge-base)..upstream/main` per file
- Both-sides-added file detection via `comm -12` on fork-added and upstream-added file lists
