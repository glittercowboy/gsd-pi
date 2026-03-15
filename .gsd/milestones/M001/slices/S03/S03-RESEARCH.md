# S03: Auto-Mode & Guided Flow Integration — Research

**Date:** 2026-03-12

## Summary

S03 is the integration slice that wires the S01 manifest status query (`getManifestStatus`) and S02 collection orchestrator (`collectSecretsFromManifest`) into GSD's two entry points: `startAuto()` in `auto.ts` and the guided flow in `guided-flow.ts`. Both paths converge through `startAuto()`, making the insertion point singular and low-risk.

The S02 branch contains all prerequisite code — `collectSecretsFromManifest()`, `showSecretsSummary()`, and `getManifestStatus()` — with passing tests. The S03 branch was forked from main before S02 merged, so the first task must merge S02 into S03. The actual integration is a small code change: ~15 lines in `startAuto()` to check for pending secrets and collect them before `dispatchNextUnit()`.

The guided flow requires no direct modification. All guided flow paths that lead to execution route through `startAuto()` — either directly (the "Go auto" button at line 647) or via `checkAutoStartAfterDiscuss()` (the discuss→auto transition at line 52). Since the collection hook lives in `startAuto()`, both paths get coverage automatically.

## Recommendation

1. **Merge S02 into S03 branch** — Fast-forward merge bringing all S01+S02 code (manifest status, collection TUI, orchestrator).
2. **Add collection gate in `startAuto()`** — After state derivation, before `dispatchNextUnit()`, call `getManifestStatus()`. If it returns pending keys, call `collectSecretsFromManifest()` and log the result. This is ~15 lines of code.
3. **Write integration tests** — Cannot unit-test `startAuto()` directly (it requires real pi infrastructure). Instead: verify the contract with a focused test that calls `getManifestStatus()` → asserts pending → calls `collectSecretsFromManifest()` → asserts manifest updated. This proves the gate logic works. Then verify build+test pass.
4. **Verify guided flow path** — Trace all `startAuto()` call sites in `guided-flow.ts` to confirm coverage. No code change needed in `guided-flow.ts`.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Manifest status query | `getManifestStatus(base, mid)` in `files.ts` (S01) | Returns categorized `{pending, collected, skipped, existing}` — no need to parse manifest manually |
| Secret collection UI | `collectSecretsFromManifest(base, mid, ctx)` in `get-secrets-from-user.ts` (S02) | Full orchestrator: summary screen, guidance display, env detection, manifest status update, apply to destination |
| Existing key detection | `checkExistingEnvKeys()` in `get-secrets-from-user.ts` | Already integrated into both `getManifestStatus` and `collectSecretsFromManifest` |
| Destination inference | `detectDestination()` in `get-secrets-from-user.ts` | Already integrated into `collectSecretsFromManifest` |

## Existing Code and Patterns

- `src/resources/extensions/gsd/auto.ts` — `startAuto()` (line 333) is the sole insertion point. The function already has a clear flow: resume check → git init → crash recovery → state derivation → metrics init → `dispatchNextUnit()`. The secrets gate goes between metrics init and `dispatchNextUnit()`.
- `src/resources/extensions/gsd/auto.ts` — `dispatchNextUnit()` (line 951) must NOT be modified. Decision D001 explicitly states collection happens at entry, not in the dispatch loop.
- `src/resources/extensions/gsd/guided-flow.ts` — `checkAutoStartAfterDiscuss()` (line 39) calls `startAuto()` after discuss→plan completes. No modification needed — it inherits the collection gate.
- `src/resources/extensions/gsd/guided-flow.ts` — `showSmartEntry()` "Go auto" path (line 647) calls `startAuto()` directly. No modification needed.
- `src/resources/extensions/gsd/guided-flow.ts` — Plan dispatch (line 614) passes `secretsOutputPath` to the LLM. The manifest gets written by the LLM during planning, then `agent_end` triggers `checkAutoStartAfterDiscuss()` → `startAuto()`. Collection gate fires before first dispatch.
- `src/resources/extensions/get-secrets-from-user.ts` — `collectSecretsFromManifest()` (line 421 on S02) takes `(base, milestoneId, ctx: { ui, hasUI, cwd })`. The `ExtensionCommandContext` satisfies this interface.
- `src/resources/extensions/gsd/files.ts` — `getManifestStatus()` (line 816 on S02) returns `ManifestStatus | null`. Returns `null` when no manifest exists — callers use this to skip collection entirely.

## Constraints

- **D001**: Collection at `startAuto()` entry point only, never in `dispatchNextUnit()` loop. This is firm — the state machine must remain untouched.
- **Backward compatibility**: `startAuto()` must work identically when no manifest exists. `getManifestStatus()` returning `null` → skip collection → no behavior change.
- **ctx shape**: `collectSecretsFromManifest` expects `{ ui, hasUI, cwd }`. The `ExtensionCommandContext` has all three. Pass `ctx` directly.
- **Async**: Both `getManifestStatus` and `collectSecretsFromManifest` are async. `startAuto` is already async.
- **S02 not merged**: The S03 branch is forked from main and doesn't have S02's commits. Must merge S02 first.
- **Resume path**: The paused-resume branch (line 345) should NOT trigger collection again. The gate should only run on fresh starts. The resume branch returns early before reaching the insertion point, so this is naturally handled.

## Common Pitfalls

- **Double collection on resume** — The `startAuto` resume path (paused=true branch) returns early at line 369, before reaching the fresh-start section. No risk here — but verify during implementation that the gate is placed in the fresh-start section only.
- **Missing milestone ID** — If `state.activeMilestone` is null, `startAuto` delegates to `showSmartEntry` and returns (line 430-434). The gate code only runs after this check, so `mid` is always defined. Use `state.activeMilestone.id`.
- **Silent no-op when no manifest** — `getManifestStatus` returns `null` when no SECRETS file exists. The gate must check for null AND for empty pending array. Most milestones won't have a manifest — this must be a silent skip, no notifications.
- **`ctx.cwd` vs `base`** — `startAuto` uses `base` (the project root). `collectSecretsFromManifest` expects `ctx.cwd` for `.env` path resolution. In practice they're the same — `base` comes from the slash-command context. But the function takes its own base parameter for manifest resolution and uses `ctx.cwd` for .env. Pass `base` as the first arg and the ctx (which has `cwd` = `base`) as the third.

## Open Risks

- **S02 merge conflicts** — The S03 branch diverged from main before S02. If main had independent changes between S02's fork point and now, the merge could conflict. Low risk since both S01 and S02 were clean.
- **Pre-existing test failures** — 19 pre-existing test failures exist across the suite (VALID_BRANCH_NAME export, AGENTS.md sync). These are unrelated to this work but must be tracked to avoid confusion during verification.

## Requirements Coverage

This slice owns:
- **R007** — Auto-mode collection at entry point: `startAuto()` checks `getManifestStatus()`, calls `collectSecretsFromManifest()` if pending keys exist, before `dispatchNextUnit()`.
- **R008** — Guided `/gsd` wizard integration: All guided flow paths route through `startAuto()`. No separate integration needed — the collection gate in `startAuto()` covers all paths.

This slice supports (delivered by S01/S02, consumed here):
- **R001** — Secret forecasting (manifest already produced during planning)
- **R002** — Secrets manifest persistence (manifest already on disk)
- **R003** — Step-by-step guidance (displayed by `collectSecretsFromManifest`)
- **R004** — Summary screen (shown by `collectSecretsFromManifest`)
- **R005** — Existing key detection (handled by `collectSecretsFromManifest`)
- **R006** — Smart destination detection (handled by `collectSecretsFromManifest`)

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| pi-coding-agent extensions | none found | No external skills relevant — this is internal pi extension work |

## Sources

- S01 task summaries (`.gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md`, `T02-SUMMARY.md`) — authoritative source for `getManifestStatus` contract
- S02 task summaries (`.gsd/milestones/M001/slices/S02/tasks/T01-SUMMARY.md`, `T02-SUMMARY.md`, `T03-SUMMARY.md`) — authoritative source for `collectSecretsFromManifest`, `showSecretsSummary`, guidance rendering
- `src/resources/extensions/gsd/auto.ts` — `startAuto()` insertion point analysis
- `src/resources/extensions/gsd/guided-flow.ts` — all `startAuto()` call sites, `checkAutoStartAfterDiscuss()` flow
- `gsd/M001/S02` branch — verified exports of `collectSecretsFromManifest`, `showSecretsSummary`, `getManifestStatus`
