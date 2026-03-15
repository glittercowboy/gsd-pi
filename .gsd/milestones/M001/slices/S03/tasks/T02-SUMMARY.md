---
id: T02
parent: S03
milestone: M001
provides:
  - integration test proving secrets gate logic for all three paths
key_files:
  - src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts
key_decisions:
  - Used hasUI:false ctx stub for collectSecretsFromManifest — collectOneSecret returns null (skip), showSecretsSummary no-ops, enabling end-to-end test without TUI rendering
patterns_established:
  - No-UI ctx pattern for testing manifest collection: { ui: {}, hasUI: false, cwd: tmpDir }
observability_surfaces:
  - Run `npx tsx --test src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts` to verify gate logic
duration: 8 minutes
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T02: Write integration test and verify build+test pass

**Created integration test exercising getManifestStatus → collectSecretsFromManifest composition for null manifest, pending keys, and no-pending-keys paths.**

## What Happened

Created `auto-secrets-gate.test.ts` with three test cases using real filesystem (temp dirs with `.gsd/milestones/M001/` structure):

1. **No manifest exists** — `getManifestStatus` returns `null`. Proves the gate's null-check skip path.
2. **Pending keys exist** — manifest with 2 pending + 1 env-present key. Verifies `getManifestStatus` reports pending, then calls `collectSecretsFromManifest` with `hasUI: false` ctx. Asserts: return shape correct (applied=[], skipped includes pending keys, existingSkipped includes env key), manifest on disk updated (pending→skipped for collected entries, env-present entry retains disk status), and post-collection `getManifestStatus` shows no pending.
3. **No pending keys** — manifest with collected, skipped, and env-present entries. `getManifestStatus` returns `pending.length === 0`. Proves the gate's skip path.

Key finding during test 2: `collectSecretsFromManifest` only updates manifest status for entries that flow through `collectOneSecret`. Entries already in env keep their manifest disk status (e.g. "pending") because `getManifestStatus` overrides them to "existing" at runtime based on env presence. This is correct — the manifest is a planning artifact, runtime env presence is authoritative.

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts` — 3/3 pass
- `npm run build` — clean, no TypeScript errors
- `npm run test` — 144 pass, 19 fail (pre-existing baseline, no new failures)

## Diagnostics

Run the test file directly: `npx tsx --test src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts`. Each test case has specific assertion messages for failure localization.

## Deviations

Initial assertion expected all manifest entries to have status != "pending" after collection. Corrected to match actual behavior: env-present entries retain their disk status since `collectSecretsFromManifest` only updates entries that flow through the collection loop.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts` — integration test for secrets gate (3 scenarios: null manifest, pending keys, no pending keys)
