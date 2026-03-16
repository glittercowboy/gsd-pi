# S01: Upstream merge and build stabilization

**Goal:** `npm run build` and `npm run build:web-host` succeed after merging all 398 upstream commits (v2.12→v2.21) into the fork with all 50 file conflicts resolved.
**Demo:** Run `npm run build && npm run build:web-host` — both exit 0. `rg "<<<<<<|>>>>>>|======" src/ web/ packages/` returns no matches. `git log --oneline HEAD..upstream/main | wc -l` returns 0.

## Must-Haves

- All 398 upstream commits merged (zero remaining in `git log HEAD..upstream/main`)
- All 50 file conflicts resolved with zero residual conflict markers
- Fork's web-mode code paths preserved — `cli-web-branch.ts`, `web-mode.ts`, `bridge-service.ts` imports resolve
- `npm run build` exits 0
- `npm run build:web-host` exits 0

## Proof Level

- This slice proves: contract (both build targets compile)
- Real runtime required: no (build-only gate; runtime verification is later slices)
- Human/UAT required: no

## Verification

- `rg "<<<<<<|>>>>>>|======" src/ web/ packages/ .github/` → empty (zero conflict markers)
- `npm run build` → exit 0
- `npm run build:web-host` → exit 0
- `git log --oneline HEAD..upstream/main | wc -l` → 0 (all upstream commits present)

## Observability / Diagnostics

- **Conflict marker sweep:** `rg "<<<<<<|>>>>>>|======" src/ web/ packages/ .github/` — must return empty after all tasks complete.
- **Upstream delta:** `git log --oneline HEAD..upstream/main | wc -l` — tracks how many upstream commits remain unmerged. Should reach 0.
- **Build health:** `npm run build` and `npm run build:web-host` exit codes. Non-zero means merge broke something.
- **Remaining conflicts during merge:** `git diff --name-only --diff-filter=U` — lists files still unresolved. Shrinks as tasks progress.
- **Lockfile state:** `test -f package-lock.json && echo "present" || echo "absent"` — should be absent after T01–T03, present after T04.
- **Redaction:** No secrets involved in this slice. All files are source code, configs, and prompts.

## Integration Closure

- Upstream surfaces consumed: all 398 upstream commits — new modules include `auto-dispatch.ts`, `auto-recovery.ts`, `auto-dashboard.ts`, `auto-prompts.ts`, `auto-supervisor.ts`, `auto-worktree.ts`, `forensics.ts`, `captures.ts`, `context-store.ts`, `model-router.ts`, `complexity-classifier.ts`, `context-budget.ts`, `skill-health.ts`, `quick.ts`, `history.ts`, `undo.ts`, `visualizer-data.ts`, `visualizer-views.ts`, `cache.ts`, and others
- New wiring introduced in this slice: none — preserves existing fork wiring, updates imports to match upstream's decomposed module structure where needed
- What remains before the milestone is truly usable end-to-end: S02 (command dispatch), S03-S07 (browser surfaces), S08 (parity audit), S09 (test suite green)

## Tasks

- [x] **T01: Execute merge and resolve trivial + mechanical conflicts** `est:2h`
  - Why: Initiates the merge and clears ~35 of 50 conflicts that need minimal thought — batch take-upstream files, deletions, package/CI merges, prompts, and tests. Unblocks T02/T03 to focus on the hard GSD extension conflicts.
  - Files: `package.json`, `.github/workflows/ci.yml`, `packages/pi-ai/src/env-api-keys.ts`, `packages/pi-coding-agent/src/core/settings-manager.ts`, `packages/pi-tui/src/components/editor.ts`, 7 prompt `.md` files, 11 test files, `.gitignore`, `CHANGELOG.md`, 5 native `package.json` files, `native/crates/engine/src/git.rs`, `src/resources/extensions/gsd/native-git-bridge.ts`, `src/resources/extensions/gsd/post-unit-hooks.ts`, `package-lock.json`, `src/resources/extensions/gsd/tests/orphaned-branch.test.ts`
  - Do: (1) `git merge upstream/main` — will fail with conflicts, expected. (2) Batch `git checkout upstream/main --` for 10 take-upstream files. (3) `git rm` orphaned-branch.test.ts, `rm` package-lock.json. (4) Take upstream for 11 test files. (5) Manually merge package.json — combine both sides' deps and scripts, preserving fork's web scripts. (6) Manually merge ci.yml — combine both sides' steps. (7) Resolve env-api-keys.ts, settings-manager.ts, editor.ts. (8) Resolve 7 prompt .md files — both sides made additive changes. (9) `git add` all resolved files.
  - Verify: `rg "<<<<<<|>>>>>>|======" .github/ native/ packages/ CHANGELOG.md .gitignore package.json src/resources/extensions/gsd/prompts/ src/resources/extensions/gsd/tests/ src/tests/` → empty
  - Done when: All non-GSD-extension-source and non-CLI-entry-point conflicts are resolved. ~35 files handled.

- [x] **T02: Resolve GSD extension core module conflicts** `est:2h`
  - Why: Handles the 7 hardest conflict files — the GSD extension core modules where upstream performed structural rewrites (auto.ts decomposition, preferences rewrite, git-service slimming) while the fork added web-mode integrations. Each needs "take upstream + re-apply fork additions."
  - Files: `src/resources/extensions/gsd/auto.ts`, `src/resources/extensions/gsd/index.ts`, `src/resources/extensions/gsd/commands.ts`, `src/resources/extensions/gsd/state.ts`, `src/resources/extensions/gsd/preferences.ts`, `src/resources/extensions/gsd/types.ts`, `src/resources/extensions/gsd/git-service.ts`
  - Do: For each file: (1) save fork version via `git show HEAD:<path>` for reference, (2) take upstream via `git checkout upstream/main -- <path>`, (3) diff fork version to identify fork-only additions (web imports, web code paths, web types), (4) surgically re-add fork-specific code onto upstream's version, (5) `git add`. Special attention to auto.ts: upstream already has dispatch gap watchdog and post-unit-hooks — do NOT re-add fork's duplicates. Check if upstream uses `invalidateAllCaches` from `cache.ts` vs fork's per-module cache clears.
  - Verify: `rg "<<<<<<|>>>>>>|======" src/resources/extensions/gsd/auto.ts src/resources/extensions/gsd/index.ts src/resources/extensions/gsd/commands.ts src/resources/extensions/gsd/state.ts src/resources/extensions/gsd/preferences.ts src/resources/extensions/gsd/types.ts src/resources/extensions/gsd/git-service.ts` → empty
  - Done when: All 7 files resolved with upstream's structural changes preserved and fork's web-mode additions re-applied.

- [x] **T03: Resolve remaining extension + CLI entry point conflicts, verify zero markers** `est:1.5h`
  - Why: Handles the 8 remaining conflicted files — 5 GSD extension modules with surgical fork additions, plus the 3 CLI entry points where fork's web-mode branching (cli-web-branch.ts, web-mode.ts, stopWebMode) must be re-wired onto upstream's version. Concludes with a whole-repo sweep for any residual markers.
  - Files: `src/resources/extensions/gsd/files.ts`, `src/resources/extensions/gsd/activity-log.ts`, `src/resources/extensions/gsd/dashboard-overlay.ts`, `src/resources/extensions/gsd/guided-flow.ts`, `src/resources/extensions/gsd/worktree-manager.ts`, `src/cli.ts`, `src/loader.ts`, `src/onboarding.ts`
  - Do: For each GSD extension file: take upstream, re-add fork additions (clearParseCache export in files.ts, etc.). For cli.ts: take upstream, re-add CliDeps interface, cli-web-branch.ts import, stopWebMode import, web-mode routing logic. For loader.ts: take upstream, re-add `delimiter` import, `serializeBundledExtensionPaths` import, dynamic extension path discovery. For onboarding.ts: take upstream, re-add web-mode onboarding path. After all files: `rg "<<<<<<|>>>>>>|======" .` across entire repo.
  - Verify: `rg "<<<<<<|>>>>>>|======" .` → empty (zero conflict markers in entire repo). `git diff --check` → clean.
  - Done when: All 50 file conflicts resolved. Zero residual conflict markers anywhere in the repository.

- [ ] **T04: Build stabilization — npm install, compile, fix TypeScript errors** `est:2h`
  - Why: The proof gate for S01. Regenerates the lockfile from the merged package.json, then runs both build targets. Upstream's interface changes (types.ts, state.ts, preferences.ts, git-service.ts) may break web code that imports from these modules. This task fixes any TypeScript compilation errors to achieve green builds.
  - Files: `package-lock.json` (regenerated), plus any web/src files with broken imports — likely candidates: `src/web/bridge-service.ts`, `src/web/git-summary-service.ts`, `web/src/stores/gsd-workspace-store.tsx`, `web/src/lib/command-surface-contract.ts`, `src/resources/extensions/gsd/cache.ts` (may need import updates)
  - Do: (1) `npm install` to regenerate lockfile. (2) `npm run build` — capture errors. (3) Fix TypeScript errors: update import paths, align type references with upstream's new interfaces, update web code that references changed upstream exports. (4) Re-run `npm run build` until clean. (5) `npm run build:web-host` — capture errors. (6) Fix any Next.js build errors. (7) Re-run until clean. (8) Commit the merge.
  - Verify: `npm run build` → exit 0. `npm run build:web-host` → exit 0.
  - Done when: Both `npm run build` and `npm run build:web-host` exit 0. The merge commit is created.

## Files Likely Touched

- All 50 conflicted files (listed per-task above)
- `package-lock.json` (deleted and regenerated)
- Web source files with broken imports after merge (identified during T04 build)
- Potentially: `src/web/bridge-service.ts`, `src/web/git-summary-service.ts`, `web/src/stores/gsd-workspace-store.tsx`, `web/src/lib/command-surface-contract.ts`
