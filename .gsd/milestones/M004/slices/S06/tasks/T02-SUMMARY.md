---
id: T02
parent: S06
milestone: M004
provides:
  - gsd-tools.test.ts — 35 assertions covering saveDecisionToDb (ID auto-assignment, DB row, DECISIONS.md), updateRequirementInDb (field merge, REQUIREMENTS.md, not-found throw), saveArtifactToDb (row + file write at slice/milestone/task levels), DB-unavailable fallback, tool result shape
  - gsd-inspect.test.ts — 32 assertions covering formatInspectOutput: full output, empty data, null schema version, 5 recent entries, multiline text format
key_files:
  - src/resources/extensions/gsd/tests/gsd-tools.test.ts
  - src/resources/extensions/gsd/tests/gsd-inspect.test.ts
key_decisions:
  - Used `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test` (M004 standard runner) instead of the ts-node-based command in the task plan — ts-node is not installed; Node v25.5.0 has node:sqlite built-in without --experimental-sqlite flag
patterns_established:
  - Both files are verbatim ports — zero adaptation required; import paths matched M004 layout exactly as predicted
observability_surfaces:
  - gsd-tools.test.ts validates DB-unavailable path: isDbAvailable()=false → nextDecisionId returns D001 fallback (no throw)
  - gsd-tools.test.ts validates stderr diagnostic: updateRequirementInDb logs "gsd-db: updateRequirementInDb failed: Requirement R999 not found" before throwing
  - gsd-inspect.test.ts validates formatInspectOutput produces human-readable multiline text (not JSON) with sections for schema version, counts, and recent entries
duration: 10m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Add gsd-tools.test.ts and gsd-inspect.test.ts

**Ported two test files verbatim from memory-db; 35 + 32 assertions all pass, npm test clean (pack-install pre-existing failure unrelated to this work).**

## What Happened

Both source files read from the memory-db worktree and written verbatim. No import path changes needed — the `'../gsd-db.ts'`, `'../db-writer.ts'`, `'../commands.ts'`, `'./test-helpers.ts'` paths matched M004 layout exactly.

The task plan's direct-run command (using `ts-node`) fails in this environment — ts-node isn't installed. The correct runner is the M004 standard: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test <file>`. Node v25.5.0 ships `node:sqlite` as built-in; `--experimental-sqlite` flag is not required.

`gsd-tools.test.ts` exercises the full DB-write contract for all 3 LLM tools: ID auto-assignment (D001→D002→D003 sequential), row creation and field verification, markdown regeneration (DECISIONS.md, REQUIREMENTS.md), error path for missing requirement (throws with ID in message), DB-unavailable fallback (nextDecisionId returns D001 instead of throwing), and `saveArtifactToDb` at slice/milestone/task path levels.

`gsd-inspect.test.ts` exercises `formatInspectOutput` as a pure function across 5 scenarios: full data with recent entries, zero counts with empty arrays, null schema version → "unknown", 5-entry lists with mixed statuses, and output format validation (multiline, not JSON).

## Verification

```
# gsd-tools.test.ts
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-tools.test.ts
→ Results: 35 passed, 0 failed

# gsd-inspect.test.ts
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-inspect.test.ts
→ Results: 32 passed, 0 failed

# tsc
npx tsc --noEmit → clean (no output)

# npm test — unit suite: 369 pass / 0 fail; integration suite: 167 pass / 0 fail
# pack-install.test.ts failure (dist/ not found) is pre-existing — identical on pre-task stash pop

# Smoke checks
grep -c "gsd_save_decision|gsd_update_requirement|gsd_save_summary" src/resources/extensions/gsd/index.ts → 9
grep "inspect" src/resources/extensions/gsd/commands.ts → 4 matches (subcommands array, handler dispatch, error message, handleInspect/formatInspectOutput)
```

## Diagnostics

- **DB-unavailable path**: `isDbAvailable()` → false → `nextDecisionId()` returns `'D001'` (no throw). Validated directly in `gsd-tools.test.ts` "DB unavailable error paths" section.
- **Stderr signal on write failure**: `updateRequirementInDb` writes `gsd-db: updateRequirementInDb failed: Requirement R999 not found` to stderr before throwing — visible in test output and in production stderr stream.
- **Inspect output surface**: `formatInspectOutput` produces section-separated human-readable text with `=== GSD Database Inspect ===` header, aligned counts, and `DXXX: decision → choice` / `RXXX [status]: description` entry format. No JSON emitted.

## Deviations

- **Direct-run command**: Task plan specified ts-node-based invocation; correct command for M004 is the resolve-ts.mjs loader with `--experimental-strip-types --test`. Same test outcome; different runner.
- **--experimental-sqlite not needed**: Node v25.5.0 ships node:sqlite built-in. The flag in the task plan's verification command is for older Node versions — omitting it is correct on this runtime.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/gsd-tools.test.ts` — new file, 326 lines, verbatim port from memory-db; tests all 3 tool functions + DB-unavailable path + tool result shape
- `src/resources/extensions/gsd/tests/gsd-inspect.test.ts` — new file, 118 lines, verbatim port from memory-db; tests formatInspectOutput across 5 scenarios
- `.gsd/milestones/M004/slices/S06/S06-PLAN.md` — T02 marked [x]
