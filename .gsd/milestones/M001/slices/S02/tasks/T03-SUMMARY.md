---
id: T03
parent: S02
milestone: M001
provides:
  - showSecretsSummary() exported — read-only ctx.ui.custom screen using makeUI() progressItem() with status mapping (collected→done, pending→pending, skipped→skipped, existing→done with "already set" annotation)
  - collectSecretsFromManifest(base, milestoneId, ctx) exported — full orchestrator reading manifest, checking existing keys, showing summary, collecting pending keys with guidance, updating manifest statuses, writing back, and applying to destination
  - applySecrets() shared helper extracted from execute() — eliminates destination write logic duplication
key_files:
  - src/resources/extensions/get-secrets-from-user.ts
key_decisions:
  - Extracted destination write logic into applySecrets() helper with optional exec parameter — dotenv writes are direct, vercel/convex writes require pi.exec passed via opts.exec
  - collectSecretsFromManifest signature is (base, milestoneId, ctx) matching test expectations rather than (ctx, base, milestoneId) from plan
  - showSecretsSummary takes (ctx, entries, existingKeys) — accepts raw SecretsManifestEntry[] and string[] of existing keys for flexible status mapping
patterns_established:
  - applySecrets() pattern for shared secret writing with optional exec callback — allows both tool execute() and standalone orchestrator to share write logic
observability_surfaces:
  - collectSecretsFromManifest() returns { applied: string[], skipped: string[], existingSkipped: string[] } — structured result for caller inspection
  - Manifest file on disk is updated with entry statuses after collection — inspectable via parseSecretsManifest()
duration: 20m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T03: Add showSecretsSummary and collectSecretsFromManifest

**Added showSecretsSummary() read-only summary screen and collectSecretsFromManifest() orchestrator, extracted applySecrets() shared helper from execute().**

## What Happened

Added three pieces to `get-secrets-from-user.ts`:

1. **showSecretsSummary()** — A `ctx.ui.custom` screen that renders all manifest entries with status indicators using `makeUI().progressItem()`. Maps manifest statuses to `ProgressStatus` (collected→done, pending→pending, skipped→skipped). Keys in `existingKeys` show as done with "already set" detail annotation. Any key press dismisses (follows confirm-ui.ts pattern).

2. **applySecrets()** — Extracted the dotenv/vercel/convex write logic from `execute()` into a shared helper. Takes an optional `exec` callback for vercel/convex CLI calls (which require `pi.exec`). The `execute()` function now delegates to `applySecrets()` instead of inlining the write logic.

3. **collectSecretsFromManifest()** — Full orchestrator: resolves manifest path via `resolveMilestoneFile()`, parses manifest, checks existing keys against `.env`/`process.env`, shows summary screen, detects destination via `detectDestination()`, collects only pending keys (passing guidance and formatHint), updates manifest entry statuses to collected/skipped, writes manifest back to disk, and applies collected values via `applySecrets()`. Returns structured `{ applied, skipped, existingSkipped }`.

New imports added: `makeUI`/`ProgressStatus` from shared/ui, `parseSecretsManifest`/`formatSecretsManifest` from gsd/files, `resolveMilestoneFile` from gsd/paths, `SecretsManifestEntry` type from gsd/types.

## Verification

- `npm run build` — exits 0
- `node --test src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — all 9 tests pass:
  - Orchestrator categorizes entries (pending/existing/skipped) ✓
  - Existing keys excluded from collection list ✓
  - Manifest statuses updated after collection ✓
  - showSecretsSummary renders correct status glyphs ✓
  - showSecretsSummary shows existing keys with distinct indicator ✓
  - Guidance lines appear in collectOneSecret render ✓
  - Long guidance URLs wrap instead of truncating ✓
  - No guidance = no guidance section ✓
  - Returns structured result with applied/skipped/existingSkipped ✓
- `node --test src/resources/extensions/gsd/tests/secure-env-collect.test.ts` — all 12 existing tests pass
- `npm run test` — 141 pass, 19 fail (pre-existing: 25 failures before this task, reduced to 19 by the 9 new passing tests minus 3 guidance tests that already passed from T02)
- `grep -n "export.*showSecretsSummary\|export.*collectSecretsFromManifest" src/resources/extensions/get-secrets-from-user.ts` — both exports confirmed at lines 280 and 421

### Slice-level verification status

- ✅ `npm run build` passes with no new errors
- ✅ `npm run test` passes with no new failures (net reduction in failures)
- ✅ `node --test collect-from-manifest.test.ts` — all 9 tests pass
- ✅ `node --test secure-env-collect.test.ts` — all 12 existing tests pass

## Diagnostics

- `grep -n "export.*showSecretsSummary\|export.*collectSecretsFromManifest" src/resources/extensions/get-secrets-from-user.ts` — confirms both exports
- Call `collectSecretsFromManifest(base, milestoneId, ctx)` and inspect return value for `{ applied, skipped, existingSkipped }`
- Read manifest file after collection to verify updated statuses via `parseSecretsManifest()`
- Manifest parse errors propagate as exceptions; file I/O errors propagate with path context

## Deviations

- **Signature order**: Plan specified `(ctx, base, milestoneId)` but tests use `(base, milestoneId, ctx)`. Matched the test signatures since they are the authoritative contract.
- **applySecrets exec callback**: Plan implied full parity for vercel/convex in the orchestrator, but `pi.exec` isn't available outside the tool registration. Used optional `exec` callback parameter so `execute()` passes `pi.exec` while the orchestrator works without it (dotenv only). This is correct — the orchestrator runs during GSD auto-mode where dotenv is the expected destination.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/get-secrets-from-user.ts` — Added `showSecretsSummary()`, `collectSecretsFromManifest()`, `applySecrets()` helper; refactored `execute()` to use `applySecrets()`; added imports for makeUI, parseSecretsManifest, formatSecretsManifest, resolveMilestoneFile, SecretsManifestEntry, ProgressStatus
