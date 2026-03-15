---
id: T04
parent: S02
milestone: M002
provides:
  - A real browser-native current-project Git summary surface for the sidebar Git affordance, backed by on-demand repo truth with explicit not-a-repo and load-error visibility
key_files:
  - src/web/git-summary-service.ts
  - web/app/api/git/route.ts
  - web/lib/git-summary-contract.ts
  - web/lib/command-surface-contract.ts
  - web/lib/gsd-workspace-store.tsx
  - web/components/gsd/command-surface.tsx
  - web/components/gsd/sidebar.tsx
  - src/tests/web-session-parity-contract.test.ts
  - src/tests/web-state-surfaces-contract.test.ts
key_decisions:
  - Keep Git parity on a dedicated on-demand `/api/git` route and shared `git` command-surface section instead of widening `/api/boot` or importing the full git service into the web host bundle
patterns_established:
  - Shared browser parity surfaces can add read-only current-project contracts with explicit `pending`/`result`/`error` state in `commandSurface` and stable `data-testid` markers, while keeping build-sensitive server logic behind narrow route-local helpers
observability_surfaces:
  - /api/git
  - commandSurface.gitSummary
  - data-testid markers: sidebar-git-button, command-surface-git-summary, command-surface-git-state, command-surface-git-meta, command-surface-git-not-repo, command-surface-git-error, command-surface-git-files
  - built-host browser verification at http://127.0.0.1:3000
duration: 2h
verification_result: passed
completed_at: 2026-03-15T12:33:00Z
# Set blocker_discovered: true only if execution revealed the remaining slice plan
# is fundamentally invalid (wrong API, missing capability, architectural mismatch).
# Do NOT set true for ordinary bugs, minor deviations, or fixable issues.
blocker_discovered: false
---

# T04: Turn the sidebar Git button into a real browser-native repo surface

**Shipped a real browser-native Git surface behind the sidebar Git button, using current-project repo truth from `/api/git` with explicit repo/not-a-repo/error rendering on the shared command surface.**

## What Happened

I added a dedicated read-only current-project Git summary contract and route instead of widening `/api/boot`. The new `src/web/git-summary-service.ts` resolves the current project from the existing web runtime config, detects repo/not-a-repo state, reads branch/main-branch truth through the native read helpers, and parses raw Git porcelain so the browser gets an explicit changed/staged/dirty/untracked/conflict summary plus a bounded changed-file list.

On the browser side, I extended the shared command-surface contract/store with a `gitSummary` state object and a `loadGitSummary()` action, added a `git` surface/section to the shared command-surface flow, and rendered a real Git card with stable markers for the summary, state text, repo metadata, changed files, not-a-repo state, and load-error state. The sidebar Git button now opens that surface through the same store-driven path instead of remaining inert.

While implementing the service, I fixed two real correctness/build issues instead of papering them over:
- repo-relative scoping now uses Git’s own `rev-parse --show-prefix` truth so macOS `/var` vs `/private/var` aliasing cannot break current-project filtering
- porcelain parsing now uses a local raw git exec helper instead of the trimmed `runGit()` output, because trimming removed leading spaces from the first status line and caused unstaged-first files to disappear from the summary

I also kept the route bundle-safe by using local read-only git exec helpers in `git-summary-service.ts` instead of importing the broader `git-service.ts`, which pulled non-web-safe dependencies into the Next route build.

## Verification

Passed task-level verification:

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-state-surfaces-contract.test.ts`
  - proved `/api/git` is current-project scoped
  - proved `/api/git` returns an explicit `not_repo` state instead of silently failing
  - proved the shared command-surface/store/sidebar source contracts expose non-inert Git wiring and browser-visible repo/not-a-repo/error markers
- `npm run build:web-host`
  - passed after replacing the non-bundle-safe `git-service.ts` import with local read-only git helpers in the new summary service
  - Next emitted the existing optional `@gsd/native` warning path from `native-git-bridge.ts`, but the build completed successfully and staged the standalone host
- Real browser smoke on the built host:
  - started `PORT=3000 GSD_WEB_PROJECT_CWD=/Users/sn0w/Documents/dev/GSD-2 node dist/web/standalone/server.js`
  - navigated to `http://127.0.0.1:3000`
  - asserted `[data-testid='sidebar-git-button']` was visible
  - clicked the sidebar Git button
  - asserted `[data-testid='command-surface-git-summary']` and `[data-testid='command-surface-git-state']` became visible
  - inspected the rendered Git surface HTML and confirmed it showed branch `gsd/M002/S02`, main branch `main`, current-project scope, changed-file counts, and changed-file entries from the working tree

Slice-level verification was not fully rerun in this timeout-recovery pass; the task-level verification above passed and the required host build passed.

## Diagnostics

Later inspection points:

- `GET /api/git` — current-project repo summary or explicit `not_repo` state
- browser store: `commandSurface.gitSummary` for `pending` / `loaded` / `result` / `error`
- UI markers in `web/components/gsd/command-surface.tsx`
  - `command-surface-git-summary`
  - `command-surface-git-state`
  - `command-surface-git-meta`
  - `command-surface-git-not-repo`
  - `command-surface-git-error`
  - `command-surface-git-files`
- sidebar affordance marker in `web/components/gsd/sidebar.tsx`
  - `sidebar-git-button`
- source-contract coverage
  - `src/tests/web-session-parity-contract.test.ts`
  - `src/tests/web-state-surfaces-contract.test.ts`

## Deviations

None.

## Known Issues

- `npm run build:web-host` still emits the existing optional `@gsd/native` module warning from `src/resources/extensions/gsd/native-git-bridge.ts`, but the build completed successfully and the Git route works through its fallback path.
- During browser smoke, the overall shell still showed an existing boot failure unrelated to this task; the Git sidebar affordance and Git command surface still rendered and verified correctly on top of that state.

## Files Created/Modified

- `src/web/git-summary-service.ts` — new current-project read-only Git summary service with repo/not-a-repo handling, raw porcelain parsing, and build-safe local git exec helpers
- `web/app/api/git/route.ts` — same-origin Git summary route with explicit JSON error responses and no-store caching
- `web/lib/git-summary-contract.ts` — shared Git summary response contract for route/store normalization
- `web/lib/browser-slash-command-dispatch.ts` — added shared `git` surface support
- `web/lib/command-surface-contract.ts` — extended the shared command-surface contract with `git` section, `load_git_summary` action, and `gitSummary` state
- `web/lib/gsd-workspace-store.tsx` — added Git summary normalization, fetch action, shared state wiring, and action export
- `web/components/gsd/command-surface.tsx` — rendered the Git summary card and its visible repo/not-a-repo/error states with stable markers
- `web/components/gsd/sidebar.tsx` — wired the sidebar Git button to open the shared Git surface and added a stable test id
- `src/tests/web-session-parity-contract.test.ts` — added `/api/git` current-project scoping and explicit not-a-repo contract coverage plus shared Git source-contract assertions
- `src/tests/web-state-surfaces-contract.test.ts` — added dead-affordance regression coverage for the Git sidebar button and browser-visible Git states
- `.gsd/DECISIONS.md` — recorded the on-demand `/api/git` parity decision for downstream work
