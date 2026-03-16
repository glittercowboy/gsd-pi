---
estimated_steps: 6
estimated_files: 8
---

# T03: Resolve remaining extension + CLI entry point conflicts, verify zero markers

**Slice:** S01 — Upstream merge and build stabilization
**Milestone:** M003

## Description

Resolve the final 8 conflicted files: 5 GSD extension modules with surgical fork additions, plus the 3 CLI entry points (cli.ts, loader.ts, onboarding.ts) where the fork's web-mode branching logic must be re-wired onto upstream's version. These files are simpler than T02's core modules but the CLI entry points are critical — they contain the imports and routing that make `gsd --web` work.

**Critical knowledge for the executor:**
- `cli.ts` is where the fork routes `--web` flag to `cli-web-branch.ts` and imports `stopWebMode`. These fork-only files are NOT in any conflict and exist untouched — only the import sites in cli.ts need re-wiring.
- `loader.ts` is where the fork changed `NODE_PATH` joining to use `delimiter` (cross-platform fix) and added dynamic extension path discovery via `serializeBundledExtensionPaths`. The fork also created `src/bundled-extension-paths.ts` (may or may not conflict separately).
- `onboarding.ts` is where the fork added a web-mode onboarding code path. Upstream enhanced the normal onboarding flow.

## Steps

1. **Save fork versions of the 8 remaining conflicted files:**
   ```bash
   mkdir -p /tmp/fork-ref
   git show HEAD:src/resources/extensions/gsd/files.ts > /tmp/fork-ref/files.ts 2>/dev/null || true
   git show HEAD:src/resources/extensions/gsd/activity-log.ts > /tmp/fork-ref/activity-log.ts 2>/dev/null || true
   git show HEAD:src/resources/extensions/gsd/dashboard-overlay.ts > /tmp/fork-ref/dashboard-overlay.ts 2>/dev/null || true
   git show HEAD:src/resources/extensions/gsd/guided-flow.ts > /tmp/fork-ref/guided-flow.ts 2>/dev/null || true
   git show HEAD:src/resources/extensions/gsd/worktree-manager.ts > /tmp/fork-ref/worktree-manager.ts 2>/dev/null || true
   git show HEAD:src/cli.ts > /tmp/fork-ref/cli.ts 2>/dev/null || true
   git show HEAD:src/loader.ts > /tmp/fork-ref/loader.ts 2>/dev/null || true
   git show HEAD:src/onboarding.ts > /tmp/fork-ref/onboarding.ts 2>/dev/null || true
   ```

2. **Resolve 5 GSD extension modules — take upstream + re-add fork additions:**

   For each of these files, take upstream's version then diff against the fork version to re-add fork-only code:

   - **`files.ts`** — Fork added `clearParseCache` export and possibly other cache-related exports. Take upstream, re-add fork's exports if they still exist in upstream's API. If upstream consolidated cache functions into `cache.ts`, the export may need to re-export from there instead.
   - **`activity-log.ts`** — Fork made additive changes. Take upstream, re-add fork additions.
   - **`dashboard-overlay.ts`** — Fork made additive changes. Take upstream, re-add fork additions.
   - **`guided-flow.ts`** — Fork: 40+/9-. Upstream: 506+/34-. Massive upstream rewrite. Take upstream, re-add fork changes (likely minimal web-specific additions).
   - **`worktree-manager.ts`** — Fork: 72+/13-. Upstream: 184+/134-. Take upstream, re-add fork additions.

   For each: `git checkout upstream/main -- <file>`, compare, re-add, `git add`.

3. **Resolve `cli.ts` — take upstream + re-wire web-mode branching:**
   ```bash
   git checkout upstream/main -- src/cli.ts
   ```
   Then re-add the fork's web-mode code. From the fork version, identify and re-add:
   - Import of `runWebCliBranch` from `./cli-web-branch.js` (or `.ts` depending on import style)
   - Import of `stopWebMode` from `./web-mode.js`
   - Import of `parseCliArgs` if it was refactored out
   - Import of `getProjectSessionsDir`, `migrateLegacyFlatSessions` from `./project-sessions.js`
   - The `CliDeps` interface and `RunWebCliBranchDeps` type (if defined in cli.ts)
   - The web-mode routing logic: the code path that checks for `--web` flag and routes to `runWebCliBranch` instead of the normal TUI path
   
   **Important:** These imports reference files that exist in the fork and are NOT conflicted. The import paths must match exactly what's on disk.

4. **Resolve `loader.ts` — take upstream + re-add dynamic extension discovery:**
   ```bash
   git checkout upstream/main -- src/loader.ts
   ```
   Then re-add fork-specific changes:
   - Import of `delimiter` from `node:path` (cross-platform NODE_PATH joining)
   - Import of `serializeBundledExtensionPaths` from the bundled-extension-paths module
   - Replacement of hardcoded `NODE_PATH` joining with `delimiter`-based joining
   - Dynamic extension path discovery via `GSD_BUNDLED_EXTENSION_PATHS`
   
   **Note:** If upstream already uses `delimiter` for NODE_PATH, no re-addition needed. Check first.

5. **Resolve `onboarding.ts` — take upstream + re-add web-mode path:**
   ```bash
   git checkout upstream/main -- src/onboarding.ts
   ```
   Re-add the fork's web-mode onboarding code path. The fork added ~104 lines that handle onboarding when running in web mode (different UI flow, browser-based credential entry). Find the fork's web-mode branching point and re-add it.

6. **Full-repo conflict marker sweep:**
   ```bash
   rg "<<<<<<|>>>>>>|======" . --type-add 'all:*' -g '!node_modules' -g '!.git' -g '!package-lock.json'
   ```
   Also run:
   ```bash
   git diff --check
   ```
   If ANY conflict markers remain anywhere, resolve them before marking this task done.

## Must-Haves

- [ ] `cli.ts` has upstream's code AND fork's `--web` flag routing, `cli-web-branch` import, `stopWebMode` import
- [ ] `loader.ts` has upstream's code AND fork's `delimiter`-based NODE_PATH joining and dynamic extension discovery
- [ ] `onboarding.ts` has upstream's enhanced onboarding AND fork's web-mode onboarding path
- [ ] All 5 GSD extension modules resolved with fork additions re-applied
- [ ] Zero conflict markers in the entire repository (`rg "<<<<<<|>>>>>>|======"` returns empty)
- [ ] `git diff --check` is clean

## Verification

- `rg "<<<<<<|>>>>>>|======" . -g '!node_modules' -g '!.git' -g '!package-lock.json'` → empty
- `git diff --check` → clean
- `grep "cli-web-branch" src/cli.ts` → confirms web branch import present
- `grep "stopWebMode" src/cli.ts` → confirms web mode stop import present
- `grep "delimiter" src/loader.ts` → confirms cross-platform fix present (if applicable)
- `grep "web" src/onboarding.ts` → confirms web-mode onboarding path present

## Inputs

- Merge in progress with only these 8 files still conflicted (T01 and T02 resolved the other 42)
- Fork versions accessible via `git show HEAD:<path>` or from `/tmp/fork-ref/`
- Fork-only files that must be importable: `src/cli-web-branch.ts`, `src/web-mode.ts`, `src/project-sessions.ts`

## Expected Output

- All 50 file conflicts fully resolved
- Zero conflict markers anywhere in the repository
- All resolved files staged with `git add`
- Merge is ready for lockfile regeneration and build (T04)

## Observability Impact

- **Conflict marker scan**: `rg "^<<<<<<<|^>>>>>>>|^=======$" src/ web/ packages/ .github/` — must return empty (exit 1) after this task. Any match indicates an unresolved conflict.
- **Unmerged file check**: `git diff --name-only --diff-filter=U` — must return empty. Any output indicates files still in conflict state.
- **Web-mode routing**: `grep "cli-web-branch\|stopWebMode\|runWebCliBranch" src/cli.ts` — confirms fork's web-mode entry points are wired into upstream's cli.ts.
- **Cross-platform loader**: `grep "delimiter\|serializeBundledExtensionPaths\|GSD_BUNDLED_EXTENSION_PATHS" src/loader.ts` — confirms fork's dynamic extension discovery and cross-platform NODE_PATH joining are preserved.
- **Merge readiness**: `git status` should show "All conflicts fixed but you are still merging" — merge is staged but not committed, ready for T04 to regenerate lockfile and build.
