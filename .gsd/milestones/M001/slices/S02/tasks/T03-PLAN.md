---
estimated_steps: 5
estimated_files: 2
---

# T03: Add showSecretsSummary and collectSecretsFromManifest

**Slice:** S02 — Enhanced Collection TUI
**Milestone:** M001

## Description

This task creates the two remaining exported functions that S03 will consume: `showSecretsSummary()` (read-only summary screen) and `collectSecretsFromManifest()` (orchestrator). Together they deliver R004 (summary screen before collection), R005 (existing key detection and silent skip), and R006 (smart destination detection).

`showSecretsSummary()` displays all manifest entries with status indicators using `makeUI()` primitives. It follows the `confirm-ui.ts` pattern: render → any key → done. Status mapping: `collected → done`, `pending → pending`, `skipped → skipped` for `ProgressStatus`. Keys already in the environment show as `done` with an "already set" annotation.

`collectSecretsFromManifest()` is the orchestrator: reads manifest via `parseSecretsManifest()`, checks env via `checkExistingEnvKeys()`, detects destination via `detectDestination()`, shows summary, collects only pending keys (with guidance + hint), updates manifest statuses, and writes back via `formatSecretsManifest()`. Returns a structured result matching the existing tool result shape.

## Steps

1. Import `parseSecretsManifest`, `formatSecretsManifest` from `./gsd/files.js` and `resolveMilestoneFile` from `./gsd/paths.js` in `get-secrets-from-user.ts`. Import `makeUI` from `./shared/ui.js`. Import `wrapTextWithAnsi` if not already imported.
2. Add `showSecretsSummary()` function. It takes `ctx` (with `ui` and `hasUI`), and an array of `{ key: string, status: ProgressStatus, detail?: string }` entries. Renders as `ctx.ui.custom`: uses `makeUI(theme, width)` to build lines with `ui.bar()`, `ui.header("Secrets Summary")`, then `ui.progressItem()` for each entry, then `ui.hints(["any key to continue"])`, then `ui.bar()`. Resolves on any key press (follow `confirm-ui.ts` handleInput pattern — any key calls `done()`). Export the function.
3. Add `collectSecretsFromManifest()` function. Parameters: `ctx` (ExtensionContext with `ui`, `hasUI`, `cwd`), `base: string` (project root / `.gsd` parent), `milestoneId: string`. Steps: (a) resolve manifest path via `resolveMilestoneFile(base, milestoneId, "SECRETS")`, (b) read and parse manifest, (c) check existing keys via `checkExistingEnvKeys()` against `resolve(base, ".env")`, (d) build summary entries mapping each manifest entry to a `ProgressStatus` (existing → `done` with "already set", collected → `done`, skipped → `skipped`, pending → `pending`), (e) show summary screen, (f) detect destination via `detectDestination(ctx.cwd)`, (g) loop through entries where status is `pending` AND key is not existing — call `collectOneSecret()` with guidance and hint, (h) update manifest entry statuses (`collected` if value provided, `skipped` if null), (i) write manifest back to disk via `formatSecretsManifest()`, (j) apply collected values to destination (reuse the same dotenv/vercel/convex write logic from `execute()`). Return `{ applied: string[], skipped: string[], existingSkipped: string[] }`. Export the function.
4. Extract the destination write logic from `execute()` into a shared helper `applySecrets()` so both `execute()` and `collectSecretsFromManifest()` use the same code path. This avoids duplicating the dotenv/vercel/convex write logic.
5. Make all remaining tests in `collect-from-manifest.test.ts` pass. Tests for orchestrator categorization, existing-key skip, and manifest write-back should exercise the non-TUI logic by mocking or bypassing `ctx.ui.custom`. The summary render test should call the render function directly with a mock theme.

## Must-Haves

- [ ] `showSecretsSummary()` exported and renders using `makeUI()` `progressItem()` with correct status mapping
- [ ] `collectSecretsFromManifest()` exported with signature `(ctx, base, milestoneId)`
- [ ] Existing keys auto-skipped (not prompted)
- [ ] Manifest statuses updated and written back after collection
- [ ] Summary screen is read-only — any key dismisses (D003)
- [ ] All tests in `collect-from-manifest.test.ts` pass
- [ ] `npm run build` and `npm run test` pass

## Verification

- `npm run build` exits 0
- `node --test src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — all tests pass
- `npm run test` — no regressions
- `grep -n "export.*showSecretsSummary\|export.*collectSecretsFromManifest" src/resources/extensions/get-secrets-from-user.ts` shows both exports

## Observability Impact

- Signals added/changed: `collectSecretsFromManifest()` returns structured result with `applied`, `skipped`, `existingSkipped` arrays
- How a future agent inspects this: call `collectSecretsFromManifest()` and check the return value; read manifest file to see updated statuses
- Failure state exposed: manifest parse errors propagate as exceptions; file write errors propagate with path context

## Inputs

- `src/resources/extensions/get-secrets-from-user.ts` — enhanced `collectOneSecret()` from T02
- `src/resources/extensions/gsd/files.ts` — `parseSecretsManifest()`, `formatSecretsManifest()` (on branch after T01 merge)
- `src/resources/extensions/gsd/paths.ts` — `resolveMilestoneFile()`
- `src/resources/extensions/shared/ui.ts` — `makeUI()`, `ProgressStatus`
- `src/resources/extensions/shared/confirm-ui.ts` — pattern reference for read-only screen
- `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — test stubs from T01

## Expected Output

- `src/resources/extensions/get-secrets-from-user.ts` — `showSecretsSummary()` and `collectSecretsFromManifest()` exported, destination write logic extracted into shared helper
- `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — all tests passing
- Build and full test suite green
