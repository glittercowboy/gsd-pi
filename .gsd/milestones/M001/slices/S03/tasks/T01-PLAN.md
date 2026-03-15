---
estimated_steps: 4
estimated_files: 1
---

# T01: Merge S02 and add secrets collection gate in startAuto()

**Slice:** S03 — Auto-Mode & Guided Flow Integration
**Milestone:** M001

## Description

Merge the S02 branch (which contains `getManifestStatus`, `collectSecretsFromManifest`, and all S01+S02 work) into the S03 branch, then add the secrets collection gate in `startAuto()`. The gate checks for pending secrets in the active milestone's manifest and collects them before dispatching the first unit. This is the core integration point for requirements R007 and R008.

## Steps

1. Merge `gsd/M001/S02` into the current `gsd/M001/S03` branch. Resolve any conflicts (expected: none or trivial).
2. Add imports to `auto.ts`: `getManifestStatus` from `./files.js`, `collectSecretsFromManifest` from `../get-secrets-from-user.js`.
3. In `startAuto()`, after the skill snapshot block and before the "Self-heal" comment, add the secrets collection gate:
   - Get `mid = state.activeMilestone.id` (already confirmed non-null by the earlier guard at line ~430).
   - Call `const manifestStatus = await getManifestStatus(base, mid)`.
   - If `manifestStatus` is non-null and `manifestStatus.pending.length > 0`, call `const result = await collectSecretsFromManifest(base, mid, ctx)`.
   - Notify with counts: `"Secrets collected: X applied, Y skipped, Z already set."` using `ctx.ui.notify()`.
   - Wrap the entire block in try/catch — collection errors are non-fatal (notify as warning, don't block).
   - If `manifestStatus` is null or no pending keys, do nothing (silent skip).
4. Verify the paused-resume path (line ~345) returns before this code. Confirm by tracing the control flow — the resume branch calls `dispatchNextUnit` and returns, never reaching the fresh-start section.

## Must-Haves

- [ ] S02 merged into S03 branch
- [ ] Gate placed in fresh-start path only (between metrics/skill-snapshot and self-heal/dispatch)
- [ ] Resume path does NOT trigger collection
- [ ] Null manifest → silent no-op (no notify, no error)
- [ ] Empty pending array → silent no-op
- [ ] Collection errors wrapped in try/catch (non-fatal)
- [ ] No modifications to `dispatchNextUnit()` (D001)
- [ ] `npm run build` passes

## Verification

- `npm run build` passes with no new TypeScript errors
- Code inspection: the gate is between metrics init and `dispatchNextUnit()` in the fresh-start path
- Code inspection: the resume path (paused=true) returns at line ~368 before reaching the gate

## Observability Impact

- Signals added/changed: `ctx.ui.notify()` message when secrets are collected, showing applied/skipped/existing counts. Warning-level notify on collection error.
- How a future agent inspects this: Read `auto.ts` at the secrets gate location. Call `getManifestStatus(base, mid)` independently to check manifest state.
- Failure state exposed: Collection errors are caught and surfaced via `ctx.ui.notify(message, "warning")` — visible in the TUI notification area.

## Inputs

- `gsd/M001/S02` branch — contains all S01+S02 code including `getManifestStatus`, `collectSecretsFromManifest`, manifest parser/formatter, collection TUI
- S03 research — identifies insertion point, ctx shape, and constraints

## Expected Output

- `src/resources/extensions/gsd/auto.ts` — modified with secrets collection gate in `startAuto()` fresh-start path
- Clean build (`npm run build` passes)
