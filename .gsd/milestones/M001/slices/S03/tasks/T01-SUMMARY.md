---
id: T01
parent: S03
milestone: M001
provides:
  - secrets collection gate in startAuto() fresh-start path
  - S02 code merged into S03 branch
key_files:
  - src/resources/extensions/gsd/auto.ts
key_decisions:
  - Gate placed after skill snapshot and mode-started notify, before self-heal and dispatchNextUnit
  - Entire gate wrapped in try/catch — collection errors are non-fatal warnings
patterns_established:
  - Secrets gate pattern: check getManifestStatus → if pending > 0 → collectSecretsFromManifest → notify counts
observability_surfaces:
  - ctx.ui.notify() with applied/skipped/existing counts on successful collection
  - ctx.ui.notify() with warning level on collection error
duration: 10m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T01: Merge S02 and add secrets collection gate in startAuto()

**Merged S02 into S03 and added secrets collection gate in `startAuto()` that checks for pending manifest keys and collects them before dispatching the first unit.**

## What Happened

1. Merged `gsd/M001/S02` into `gsd/M001/S03` — clean fast-forward, no conflicts. S03 now has all S01+S02 code (manifest parser, `getManifestStatus`, `collectSecretsFromManifest`, collection TUI).

2. Added two imports to `auto.ts`:
   - `getManifestStatus` from `./files.js`
   - `collectSecretsFromManifest` from `../get-secrets-from-user.js`

3. Inserted the secrets collection gate in `startAuto()` at line ~479 (fresh-start path), between the mode-started notify message and the self-heal block. The gate:
   - Gets `mid` from `state.activeMilestone.id` (already confirmed non-null by earlier guards)
   - Calls `getManifestStatus(base, mid)` — returns null if no manifest exists
   - If result is non-null and `pending.length > 0`, calls `collectSecretsFromManifest(base, mid, ctx)`
   - Notifies with counts: "Secrets collected: X applied, Y skipped, Z already set."
   - Entire block in try/catch — errors emit a warning notify but don't block auto-mode

4. Verified the resume path (`paused=true` at line 345) calls `dispatchNextUnit` and returns at line 372, never reaching the gate.

## Verification

- `npm run build` — passes, no TypeScript errors
- `npm run test` — 141 pass, 19 fail (same pre-existing baseline, no regressions)
- Code inspection: gate is between notify ("Auto-mode started") and self-heal comment
- Code inspection: resume path returns before reaching the gate
- `git diff` confirms only `auto.ts` modified: 2 import lines + 18-line gate block
- `dispatchNextUnit()` is untouched (D001 satisfied)

## Diagnostics

- When secrets are collected: `ctx.ui.notify()` shows "Secrets collected: X applied, Y skipped, Z already set." in TUI notification area
- When collection fails: `ctx.ui.notify()` shows "Secrets collection error: <message>" at warning level
- When no manifest or no pending keys: silent — no output
- Future agent can call `getManifestStatus(base, mid)` independently to inspect manifest state

## Deviations

None.

## Known Issues

- Integration test (`auto-secrets-gate.test.ts`) does not exist yet — will be created in T02

## Files Created/Modified

- `src/resources/extensions/gsd/auto.ts` — Added `getManifestStatus` and `collectSecretsFromManifest` imports; inserted 18-line secrets collection gate in `startAuto()` fresh-start path
