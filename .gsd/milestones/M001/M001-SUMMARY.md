---
id: M001
provides:
  - Secrets manifest parser/formatter with LLM-resilient round-trip (parseSecretsManifest, formatSecretsManifest)
  - getManifestStatus() — pure query returning pending/collected/skipped/existing categorization
  - collectSecretsFromManifest() — orchestrator with summary screen, guidance display, env-skip, manifest update, destination write
  - showSecretsSummary() — read-only TUI summary screen with status indicators
  - collectOneSecret() guidance parameter — numbered dim-styled steps with line wrapping above masked input
  - Secrets collection gate in startAuto() — checks manifest before first dispatch, non-fatal on error
  - Plan-milestone prompt with Secret Forecasting section — instructs LLM to write M00x-SECRETS.md
key_decisions:
  - D001: Secret collection at startAuto entry point, not as a dispatch unit type
  - D002: Manifest file naming via resolveMilestoneFile(base, mid, "SECRETS")
  - D003: Summary screen is read-only with auto-skip (no interactive deselection)
  - D004: Guidance displayed on same page as masked input (above editor)
  - D005: Manifest format is markdown with H3 sections per key
  - D006: Destination inference reuses existing detectDestination()
patterns_established:
  - Secrets gate pattern in startAuto: getManifestStatus → pending check → collectSecretsFromManifest → notify counts
  - applySecrets() shared helper with optional exec callback for vercel/convex CLI access
  - No-UI ctx pattern for testing collection without TUI rendering
  - Dynamic loadFilesExports() test helper to avoid static import chain resolution issues
observability_surfaces:
  - getManifestStatus(base, mid) — pure query for manifest state inspection
  - collectSecretsFromManifest() returns { applied, skipped, existingSkipped } for caller inspection
  - ctx.ui.notify() messages in startAuto for collection results and errors
  - Manifest file on disk updated with entry statuses after collection
requirement_outcomes:
  - id: R001
    from_status: active
    to_status: validated
    proof: plan-milestone.md has Secret Forecasting section (line 62) instructing LLM to write secrets manifest with per-key guidance
  - id: R002
    from_status: active
    to_status: validated
    proof: parseSecretsManifest/formatSecretsManifest round-trip tested (parsers.test.ts including LLM-style variations), resolveMilestoneFile(base, mid, "SECRETS") resolves path
  - id: R003
    from_status: active
    to_status: validated
    proof: collectOneSecret accepts guidance parameter, renders numbered dim-styled steps with wrapping (collect-from-manifest.test.ts tests 6-8)
  - id: R004
    from_status: active
    to_status: validated
    proof: showSecretsSummary() renders read-only ctx.ui.custom screen with status indicators via makeUI().progressItem() (collect-from-manifest.test.ts tests 4-5)
  - id: R005
    from_status: active
    to_status: validated
    proof: getManifestStatus cross-references checkExistingEnvKeys, categorizes env-present keys as existing (manifest-status.test.ts tests 4,7), collectSecretsFromManifest skips them (collect-from-manifest.test.ts tests 1-2)
  - id: R006
    from_status: active
    to_status: validated
    proof: collectSecretsFromManifest calls detectDestination() for destination inference, applySecrets() routes to dotenv/vercel/convex accordingly
  - id: R007
    from_status: active
    to_status: validated
    proof: startAuto() in auto.ts has secrets gate at line 479 — calls getManifestStatus, checks pending, calls collectSecretsFromManifest before dispatchNextUnit (auto-secrets-gate.test.ts 3/3 pass)
  - id: R008
    from_status: active
    to_status: validated
    proof: guided-flow.ts calls startAuto() directly (lines 52, 486, 647, 794) — all guided flow paths that start auto-mode inherit the secrets gate
  - id: R009
    from_status: active
    to_status: validated
    proof: plan-milestone.md Secret Forecasting section (line 62) instructs LLM to analyze slices for external service dependencies and write {{secretsOutputPath}}
  - id: R010
    from_status: active
    to_status: validated
    proof: collectOneSecret renders guidance as numbered dim-styled lines above masked input, wrapTextWithAnsi handles wrapping (collect-from-manifest.test.ts tests 6-8)
duration: ~3 hours
verification_result: passed
completed_at: 2026-03-12T22:33:15.102Z
---

# M001: Proactive Secret Management

**Front-loaded API key collection into GSD's planning phase — planning prompts forecast secrets, a manifest persists them, and auto-mode collects them before dispatching the first slice.**

## What Happened

Three slices delivered incrementally, each building on the previous:

**S01 (Manifest Wiring & Prompt Verification)** established the data layer. Added `ManifestStatus` type and `getManifestStatus()` function to query manifest state by cross-referencing parsed entries against `.env`/`process.env`. Verified the plan-milestone prompt's Secret Forecasting section produces output that round-trips through `parseSecretsManifest()`. Created 7 contract tests for manifest status categorization and 3 LLM-style round-trip parser resilience tests.

**S02 (Enhanced Collection TUI)** built the user-facing collection experience. Enhanced `collectOneSecret()` with an optional `guidance` parameter that renders numbered dim-styled steps with ANSI-aware line wrapping above the masked input. Added `showSecretsSummary()` — a read-only `ctx.ui.custom` screen using `makeUI().progressItem()` with status mapping (pending/collected/skipped/existing). Built `collectSecretsFromManifest()` as the full orchestrator: reads manifest, checks existing keys, shows summary, collects pending keys with guidance, updates manifest statuses, writes back to disk, applies to destination. Extracted `applySecrets()` shared helper from `execute()` to eliminate write-logic duplication. Created 9 integration tests covering orchestration, summary rendering, guidance display, and result shape.

**S03 (Auto-Mode & Guided Flow Integration)** wired collection into the runtime. Inserted a secrets collection gate in `startAuto()` between the mode-started notification and self-heal — calls `getManifestStatus()`, checks for pending keys, calls `collectSecretsFromManifest()`, and notifies with counts. Entire gate is try/catch — collection errors are non-fatal warnings. The guided `/gsd` flow inherits this gate because it calls `startAuto()` directly. Created 3 integration tests proving all three gate paths (no manifest, pending keys, no pending keys).

## Cross-Slice Verification

| Success Criterion | Evidence |
|---|---|
| Planning run produces parseable secrets manifest with per-key guidance | `plan-milestone.md` has `## Secret Forecasting` section (line 62). `parseSecretsManifest()`/`formatSecretsManifest()` round-trip proven by `parsers.test.ts` including LLM-style variation tests |
| `/gsd auto` detects pending secrets and collects before first dispatch | `startAuto()` secrets gate at auto.ts:479-495. `auto-secrets-gate.test.ts` — 3/3 pass |
| Keys in `.env`/`process.env` silently skipped | `getManifestStatus()` categorizes env-present keys as `existing`. `manifest-status.test.ts` tests 4,7. `collect-from-manifest.test.ts` tests 1-2 |
| Guided `/gsd` wizard triggers same collection | `guided-flow.ts` calls `startAuto()` directly at lines 52, 486, 647, 794 — all paths inherit the gate |
| `npm run build` passes | Clean build, exit 0 |
| `npm run test` passes with no new failures | 144 pass, 19 fail — all 19 pre-existing (confirmed on base branch in S01/T01) |

**Test counts added by M001:** 19 new tests (7 manifest-status + 9 collect-from-manifest + 3 auto-secrets-gate), all passing.

## Requirement Changes

- R001: active → validated — plan-milestone.md Secret Forecasting section instructs LLM to forecast secrets
- R002: active → validated — manifest file persisted via resolveMilestoneFile, parser/formatter round-trip tested
- R003: active → validated — collectOneSecret renders numbered guidance steps with wrapping
- R004: active → validated — showSecretsSummary renders read-only summary with status indicators
- R005: active → validated — getManifestStatus cross-references checkExistingEnvKeys, collectSecretsFromManifest skips existing
- R006: active → validated — collectSecretsFromManifest calls detectDestination() for destination inference
- R007: active → validated — startAuto() secrets gate checks manifest and collects before first dispatch
- R008: active → validated — guided-flow.ts calls startAuto() directly, inheriting the gate
- R009: active → validated — plan-milestone.md Secret Forecasting section instructs LLM to analyze slices for dependencies
- R010: active → validated — collectOneSecret renders guidance as numbered dim-styled lines above masked input

## Forward Intelligence

### What the next milestone should know
- The secrets manifest is a planning artifact — runtime env presence is authoritative. A key marked "pending" in the manifest but present in `.env` is treated as "existing" at runtime.
- `applySecrets()` has an optional `exec` callback for Vercel/Convex CLI access. The orchestrator runs without it (dotenv only). If Vercel/Convex support is needed in the orchestrator, pass `pi.exec` via an options parameter.
- The 19 pre-existing test failures are caused by `VALID_BRANCH_NAME` missing from `git-service.ts` exports and `AGENTS.md` sync issues — unrelated to secrets work.

### What's fragile
- **LLM prompt compliance** — The quality and format of the secrets manifest depends entirely on the LLM following `plan-milestone.md` instructions. The parser is forgiving (handles extra whitespace, missing fields, blank lines), but fundamentally the LLM must produce H3 sections with the expected bold-field format. No runtime validation step catches a completely malformed manifest.
- **Vercel/Convex in orchestrator** — `collectSecretsFromManifest()` can only write to dotenv when called from the secrets gate (no `pi.exec` available). Vercel/Convex destinations require passing exec callback, which isn't wired in the gate.

### Authoritative diagnostics
- `getManifestStatus(base, mid)` — call this to inspect manifest state without side effects
- `npx tsx --test src/resources/extensions/gsd/tests/manifest-status.test.ts` — 7 tests for categorization
- `npx tsx --test src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — 9 tests for orchestration
- `npx tsx --test src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts` — 3 tests for gate integration

### What assumptions changed
- Planned `collectSecretsFromManifest(ctx, base, mid)` signature became `(base, mid, ctx)` to match test expectations — base/milestoneId are more fundamental than context
- Env-present keys retain their manifest disk status (e.g. "pending") because runtime categorization overrides — the manifest is a planning snapshot, not a live state tracker

## Files Created/Modified

- `src/resources/extensions/gsd/types.ts` — Added `ManifestStatus` interface (+7 lines)
- `src/resources/extensions/gsd/files.ts` — Added `getManifestStatus()` function with checkExistingEnvKeys integration (+46 lines)
- `src/resources/extensions/get-secrets-from-user.ts` — Added guidance rendering in `collectOneSecret()`, `showSecretsSummary()`, `collectSecretsFromManifest()` orchestrator, `applySecrets()` shared helper, refactored `execute()` (+325/-56 lines)
- `src/resources/extensions/gsd/auto.ts` — Added secrets collection gate in `startAuto()` (+21 lines)
- `src/resources/extensions/gsd/tests/manifest-status.test.ts` — 7 contract tests for getManifestStatus (new file, 283 lines)
- `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — 9 integration tests for collection orchestration (new file, 469 lines)
- `src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts` — 3 integration tests for startAuto secrets gate (new file, 196 lines)
- `src/resources/extensions/gsd/tests/parsers.test.ts` — 3 LLM-style round-trip test blocks added (+190 lines)
