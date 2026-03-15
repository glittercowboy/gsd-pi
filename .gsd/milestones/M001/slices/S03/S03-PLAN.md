# S03: Auto-Mode & Guided Flow Integration

**Goal:** `startAuto()` checks for a secrets manifest with pending keys and collects them before dispatching the first slice. All guided flow paths inherit this behavior automatically.
**Demo:** Running `/gsd auto` on a milestone with a secrets manifest pauses for collection before slice execution. The `/gsd` wizard triggers the same flow after planning.

## Must-Haves

- `startAuto()` calls `getManifestStatus()` after state derivation; if pending keys exist, calls `collectSecretsFromManifest()` before `dispatchNextUnit()`
- When no manifest exists (`getManifestStatus` returns `null`), behavior is identical to before — silent no-op
- When manifest exists but no keys are pending (all collected/existing), behavior is identical — silent skip
- The resume path (paused=true branch) does NOT trigger collection again
- All guided flow `startAuto()` call sites (`checkAutoStartAfterDiscuss`, `showSmartEntry` "Go auto", line 486, line 794) inherit the gate without modification
- Integration test proves: manifest with pending keys → collection called → manifest updated
- `npm run build` passes with no new errors
- `npm run test` passes with no new failures

## Proof Level

- This slice proves: integration (real function composition through `getManifestStatus` → `collectSecretsFromManifest`, exercised with on-disk manifests in temp dirs)
- Real runtime required: no (cannot unit-test full `startAuto()` which requires pi infrastructure, but the gate logic is exercised through direct function calls with real filesystem state)
- Human/UAT required: no (mechanical wiring — all paths trace through `startAuto()`)

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts` — integration test proving the gate logic (manifest pending → collect → update)
- `npm run build` — no new TypeScript errors
- `npm run test` — no new test failures beyond pre-existing 19

## Observability / Diagnostics

- Runtime signals: `ctx.ui.notify()` message when secrets are collected (count of applied/skipped/existing), no message when skipped silently
- Inspection surfaces: `getManifestStatus(base, mid)` can be called independently to check manifest state at any time
- Failure visibility: `collectSecretsFromManifest` throws if manifest path is missing — caught and surfaced via notify. Collection errors don't block auto-mode start (non-fatal).
- Redaction constraints: Secret values never logged. Only key names appear in notify messages and manifest status.

## Integration Closure

- Upstream surfaces consumed: `getManifestStatus()` from `files.ts` (S01), `collectSecretsFromManifest()` from `get-secrets-from-user.ts` (S02), `ManifestStatus` type from `types.ts`
- New wiring introduced in this slice: `startAuto()` in `auto.ts` gains a secrets collection gate between metrics init and `dispatchNextUnit()`
- What remains before the milestone is truly usable end-to-end: nothing — this is the final assembly slice. After S03, the full flow works: plan-milestone writes manifest → `startAuto()` detects pending keys → collection TUI runs → auto-mode dispatches first slice.

## Tasks

- [x] **T01: Merge S02 and add secrets collection gate in startAuto()** `est:30m`
  - Why: This is the core integration — wires `getManifestStatus` + `collectSecretsFromManifest` into the auto-mode entry point. Must merge S02 first to get the prerequisite code.
  - Files: `src/resources/extensions/gsd/auto.ts`
  - Do: (1) Merge `gsd/M001/S02` into `gsd/M001/S03`. (2) In `startAuto()`, after the `initMetrics(base)` block and skill snapshot block, before the "Self-heal" comment, add: check `state.activeMilestone.id` → call `getManifestStatus(base, mid)` → if result is non-null and `result.pending.length > 0`, call `collectSecretsFromManifest(base, mid, ctx)` → notify with counts. Wrap in try/catch so collection errors don't block auto-mode. (3) Verify the resume path (paused=true) returns before reaching this code. Constraint: Do NOT modify `dispatchNextUnit()` per D001.
  - Verify: `npm run build` passes. Manual code inspection confirms gate is in fresh-start path only.
  - Done when: `auto.ts` compiles, gate is in the correct location, resume path does not hit it.

- [x] **T02: Write integration test and verify build+test pass** `est:30m`
  - Why: Proves the gate logic works end-to-end with real filesystem state, and confirms nothing is broken across the test suite.
  - Files: `src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts`
  - Do: (1) Create `auto-secrets-gate.test.ts` with tests: (a) `getManifestStatus` returns null when no manifest → gate is a no-op; (b) `getManifestStatus` returns pending keys → `collectSecretsFromManifest` is callable and updates manifest status on disk; (c) `getManifestStatus` returns no pending keys (all existing) → gate skips. Use temp directories with real `.gsd/milestones/M001/` structure, same pattern as `manifest-status.test.ts`. (2) Run `npm run build` — no new errors. (3) Run `npm run test` — no new failures beyond pre-existing 19.
  - Verify: `npx tsx --test src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts` passes. `npm run build` passes. `npm run test` — no new failures.
  - Done when: Integration test passes, build clean, no regressions.

## Files Likely Touched

- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts`
