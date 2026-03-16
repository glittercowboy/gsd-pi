---
estimated_steps: 4
estimated_files: 2
---

# T02: Add gsd-tools.test.ts and gsd-inspect.test.ts

**Slice:** S06 — Structured LLM Tools + /gsd inspect
**Milestone:** M004

## Description

Copy two test files from the memory-db worktree verbatim. Both are direct ports with no adaptation required — import paths match M004's layout exactly (same pattern proved by S03's `prompt-db.test.ts` which also needed zero changes).

`gsd-tools.test.ts` tests the DB write functions that back the 3 LLM tools: ID auto-assignment, DB row creation, markdown file regeneration, error paths. Tests call the underlying functions directly (`saveDecisionToDb`, `updateRequirementInDb`, `saveArtifactToDb`) rather than going through the tool registration layer.

`gsd-inspect.test.ts` tests the pure `formatInspectOutput` function: full output format, empty data, null schema version, 5 recent entries, multiline text output.

## Steps

1. Read `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/gsd-tools.test.ts` and write it verbatim to `src/resources/extensions/gsd/tests/gsd-tools.test.ts`
2. Read `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/gsd-inspect.test.ts` and write it verbatim to `src/resources/extensions/gsd/tests/gsd-inspect.test.ts`
3. Run `gsd-tools.test.ts` and verify all assertions pass
4. Run `gsd-inspect.test.ts` and verify all assertions pass
5. Run `npm test` and verify no regressions

## Must-Haves

- [ ] `gsd-tools.test.ts` written with all test sections (gsd_save_decision, gsd_update_requirement, gsd_save_summary, DB unavailable, tool result format)
- [ ] `gsd-inspect.test.ts` written with all 5 test scenarios
- [ ] Both files run to completion with zero assertion failures
- [ ] `npm test` passes — no regressions in full test suite

## Verification

```bash
# Run tool tests
node --experimental-sqlite --import 'data:text/javascript,import{register}from"node:module";import{pathToFileURL}from"node:url";register("ts-node/esm",pathToFileURL("./"))' src/resources/extensions/gsd/tests/gsd-tools.test.ts

# Run inspect tests  
node --experimental-sqlite --import 'data:text/javascript,import{register}from"node:module";import{pathToFileURL}from"node:url";register("ts-node/esm",pathToFileURL("./"))' src/resources/extensions/gsd/tests/gsd-inspect.test.ts

# Full suite
npm test
```

Both direct runs must exit 0 (report() throws on any failure). `npm test` must show no regressions.

## Inputs

- T01 completed — `commands.ts` exports `formatInspectOutput` and `InspectData` (required by gsd-inspect.test.ts)
- `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/gsd-tools.test.ts` — source
- `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/gsd-inspect.test.ts` — source

## Expected Output

- `src/resources/extensions/gsd/tests/gsd-tools.test.ts` — new file, 326 lines, tests all 3 tool functions + DB-unavailable path
- `src/resources/extensions/gsd/tests/gsd-inspect.test.ts` — new file, ~120 lines, tests formatInspectOutput across 5 scenarios
