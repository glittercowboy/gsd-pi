# S02: Enhanced Collection TUI

**Goal:** The `secure_env_collect` tool displays guidance steps above the masked input, shows a read-only summary screen before collection, and auto-skips keys already in the environment. A new `collectSecretsFromManifest()` orchestrator connects manifest parsing to the enhanced TUI.
**Demo:** Calling `secure_env_collect` with guidance arrays renders numbered guidance steps above the editor. Calling `collectSecretsFromManifest()` with a manifest file shows a summary screen listing all keys with status indicators, skips already-set keys, collects only pending ones with guidance, and writes updated statuses back to the manifest.

## Must-Haves

- `collectOneSecret()` accepts optional `guidance: string[]` and renders numbered steps above the editor using `wrapTextWithAnsi()`
- The tool's `execute()` threads `item.guidance` to `collectOneSecret()` — backward compatible (no guidance = no change)
- `showSecretsSummary()` renders a read-only `ctx.ui.custom` screen using `makeUI()` primitives (`progressItem()` with `collected → done` mapping), dismissed by any key press
- `collectSecretsFromManifest()` orchestrator: reads manifest, checks existing keys, shows summary, collects pending with guidance, updates manifest entry statuses, writes back
- Keys already in `.env` or `process.env` are auto-skipped (not prompted)
- All new functions exported for S03 consumption

## Proof Level

- This slice proves: contract + integration (new functions compose correctly with existing parser/env-check/TUI infrastructure)
- Real runtime required: no (unit tests exercise non-TUI logic; TUI rendering is verified by UAT)
- Human/UAT required: yes (visual verification of guidance rendering and summary screen at multiple terminal widths)

## Verification

- `npm run build` passes with no new errors
- `npm run test` passes with no new failures
- `node --test src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — new test file covering:
  - Orchestrator categorizes manifest entries correctly (pending/existing/skipped)
  - Existing keys are excluded from the collection list
  - Manifest statuses are updated after collection
  - `showSecretsSummary()` render function produces correct line count and status glyphs
  - Guidance lines are included in `collectOneSecret()` render output
- `node --test src/resources/extensions/gsd/tests/secure-env-collect.test.ts` — existing 12 tests still pass

## Observability / Diagnostics

- Runtime signals: none (dev-time TUI workflow, no persistent runtime)
- Inspection surfaces: `collectSecretsFromManifest()` returns a structured result with `applied`, `skipped`, `existingSkipped` arrays — same shape as existing tool result
- Failure visibility: parser errors from malformed manifests surface via `parseSecretsManifest()` (already tested); file I/O errors propagate as exceptions with path context
- Redaction constraints: secret values never logged or returned in results — only key names and status

## Integration Closure

- Upstream surfaces consumed: `parseSecretsManifest()` / `formatSecretsManifest()` from `gsd/files.ts`, `checkExistingEnvKeys()` / `detectDestination()` from `get-secrets-from-user.ts`, `resolveMilestoneFile()` from `gsd/paths.ts`, `makeUI()` from `shared/ui.ts`, `ManifestStatus` / `SecretsManifestEntry` from `gsd/types.ts`
- New wiring introduced in this slice: `collectSecretsFromManifest()` orchestrator (callable from S03), `showSecretsSummary()` (callable from S03), enhanced `collectOneSecret()` with guidance rendering
- What remains before the milestone is truly usable end-to-end: S03 must wire `collectSecretsFromManifest()` into `startAuto()` and the guided `/gsd` wizard flow

## Tasks

- [x] **T01: Merge S01 and create test scaffolding** `est:20m`
  - Why: S01's `getManifestStatus()`, `ManifestStatus` type, and manifest tests exist on the S01 branch but aren't on this branch. The orchestrator needs these. Also creates the test file with initially-failing assertions for the new functions.
  - Files: `src/resources/extensions/gsd/types.ts`, `src/resources/extensions/gsd/files.ts`, `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts`
  - Do: Merge S01 branch (`gsd/M001/S01`) into this branch. Verify `ManifestStatus` type and `getManifestStatus()` are available. Create `collect-from-manifest.test.ts` with test stubs for: orchestrator categorization, existing-key skip, manifest status update, summary render output, guidance render output. Tests should import functions that don't exist yet and fail.
  - Verify: `git log --oneline -3` shows merge commit. `npm run build` passes (S01 code is compatible). `node --test src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` runs but tests fail (expected — functions not yet implemented).
  - Done when: S01 code is on this branch, test file exists with meaningful assertions that reference the functions to be built in T02–T03.

- [x] **T02: Enhance collectOneSecret with guidance and thread through execute** `est:30m`
  - Why: Delivers R003 and R010 — guidance steps must render above the masked editor on the same page as the input (D004). The tool's `execute()` must pass `item.guidance` to `collectOneSecret()` so the schema's existing `guidance` field actually works.
  - Files: `src/resources/extensions/get-secrets-from-user.ts`, `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts`
  - Do: (1) Add optional `guidance?: string[]` parameter to `collectOneSecret()`. (2) In the `render()` function, after the hint line and before the masked preview, render numbered guidance steps as dim/muted lines using `wrapTextWithAnsi()` (not `truncateToWidth()` — long URLs must wrap, not truncate). (3) At the call site in `execute()` (line ~302), pass `item.guidance` to `collectOneSecret()`. (4) Invalidate `cachedLines` is already handled (guidance is static per key). (5) Update the guidance-render test in `collect-from-manifest.test.ts` to verify render output includes guidance lines.
  - Verify: `npm run build` passes. Existing callers without guidance see no change. Test for guidance rendering passes.
  - Done when: `collectOneSecret()` renders numbered guidance steps above the editor when guidance is provided, and the tool's `execute()` passes guidance through from the schema.

- [x] **T03: Add showSecretsSummary and collectSecretsFromManifest** `est:40m`
  - Why: Delivers R004 (summary screen), R005 (existing key skip), R006 (smart destination). Creates the orchestrator that S03 will call from `startAuto()` and the guided wizard.
  - Files: `src/resources/extensions/get-secrets-from-user.ts`, `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts`
  - Do: (1) Add `showSecretsSummary()` as a `ctx.ui.custom` screen — renders all manifest entries with `progressItem()` from `makeUI()`, maps `collected → done` for `ProgressStatus`, dismisses on any key press (follow `confirm-ui.ts` pattern). (2) Add `collectSecretsFromManifest()` orchestrator that: reads manifest via `parseSecretsManifest()`, checks existing keys via `checkExistingEnvKeys()`, detects destination via `detectDestination()`, shows summary screen, collects only pending keys (passing guidance + hint), updates entry statuses to `collected`/`skipped`, writes manifest back via `formatSecretsManifest()`. Needs `base` (project root), `milestoneId`, `ctx` as parameters. (3) Export both functions. (4) Make remaining tests in `collect-from-manifest.test.ts` pass — orchestrator categorization, existing-key skip, manifest write-back.
  - Verify: `npm run build` passes. `node --test src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — all tests pass. `npm run test` — no regressions.
  - Done when: `showSecretsSummary()` and `collectSecretsFromManifest()` are exported, all tests pass, and `npm run build` succeeds.

## Files Likely Touched

- `src/resources/extensions/get-secrets-from-user.ts` — enhanced `collectOneSecret()`, new `showSecretsSummary()`, new `collectSecretsFromManifest()`
- `src/resources/extensions/gsd/types.ts` — `ManifestStatus` type (from S01 merge)
- `src/resources/extensions/gsd/files.ts` — `getManifestStatus()` (from S01 merge)
- `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — new test file
- `src/resources/extensions/shared/ui.ts` — consumed (no changes expected)
