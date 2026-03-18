# S02: Live Reroute Proof Run — UAT

**Milestone:** M007-aos64t
**Written:** 2026-03-18

## UAT Type

- UAT mode: live-runtime (artifact-driven)
- Why this mode is sufficient: The slice implements production dispatch rules and prompt builders that must work with real runtime code. Live tests using S01 fixture data prove the integration path without requiring human interaction.

## Preconditions

- Node.js v22+ with experimental-strip-types flag available
- S01 fixture data exists at `src/resources/extensions/gsd/tests/fixtures/factcheck/`
- TypeScript compilation passes (or has only pre-existing errors)

## Smoke Test

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/factcheck-runtime-live.test.ts
```

Expected: All 9 tests pass with "All live integration tests passed" summary.

## Test Cases

### 1. Dispatch reroute on plan-impacting refutation

1. Run the live integration test
2. Locate the dispatch test output
3. **Expected:** Test log shows `Result: action=dispatch, unitType=plan-slice` when FACTCHECK-STATUS.json has `planImpacting: true`
4. Verify the dispatch rule name appears as "factcheck-reroute → plan-slice" in rule names list

### 2. Corrected evidence appears in plan-slice prompt

1. Run the live integration test
2. Locate the prompt test output
3. **Expected:** Log shows `Contains 5.2.0: true` — the corrected value from refuted claim C001
4. Verify evidence section preview contains the original claim and corrected value

### 3. Fact-check evidence section header present

1. Run the live integration test
2. Locate the prompt test output
3. **Expected:** Log shows `Contains Fact-Check Evidence: true`
4. Verify evidence section includes "## Fact-Check Evidence" markdown header and "⚠️ Plan-Impacting Refutations Detected" warning

### 4. Negative case: no status file falls through

1. Run the live integration test
2. Observe negative test output
3. **Expected:** Log shows "Factcheck status file removed, rule falls through to normal planning"
4. Verify dispatch still returns an action but without factcheck reroute

### 5. Negative case: planImpacting=false falls through

1. Run the live integration test
2. Observe negative test output for planImpacting=false case
3. **Expected:** Log shows "planImpacting=false: rule falls through to normal planning"

### 6. Proof artifacts written to disk

1. Run the live integration test
2. Locate the artifacts test output
3. **Expected:** Log shows "Proof output directory" path
4. Verify `reroute-action.json` contains `{"action":"dispatch","unitType":"plan-slice",...}`
5. Verify `prompt-excerpt.txt` contains the fact-check evidence section

### 7. Dispatch rule exists in production code

1. Run: `grep -n "factcheck-reroute" src/resources/extensions/gsd/auto-dispatch.ts`
2. **Expected:** Output shows rule at approximately line 217
3. Verify rule reads FACTCHECK-STATUS.json from slice factcheck/ subdirectory

### 8. Evidence injection exists in prompt builder

1. Run: `grep -n "loadFactcheckEvidence\|Fact-Check Evidence" src/resources/extensions/gsd/auto-prompts.ts`
2. **Expected:** Output shows evidence loading and injection in buildPlanSlicePrompt

### 9. Fixture tests still pass

1. Run: `node --test src/resources/extensions/gsd/tests/factcheck-runtime-fixture.test.ts`
2. **Expected:** All 30 fixture tests pass

## Edge Cases

### Empty factcheck directory

- Create a temp project with no factcheck/ subdirectory
- Run dispatch rule match
- **Expected:** Rule falls through to normal planning (no error)

### Malformed FACTCHECK-STATUS.json

- Create a temp project with invalid JSON in FACTCHECK-STATUS.json
- Run dispatch rule match
- **Expected:** Rule handles gracefully, falls through or logs error without crashing

### Multiple REFUTED claims

- The evidence section should format all REFUTED claims, not just the first one
- **Expected:** Prompt contains multiple "### C00X (REFUTED)" sections if multiple claims are refuted

## Failure Signals

- Test output shows "Cannot find package" errors — dist-redirect.mjs needs updating
- Test output shows "action=null" for dispatch test — dispatch rule not matching
- Prompt test shows "Contains 5.2.0: false" — evidence injection not working
- Test hangs or times out — potential infinite loop in dispatch rule evaluation

## Not Proven By This UAT

- Full end-to-end runtime from actual research completion through planner reinvocation (requires S03)
- Human experience of the reroute flow in a real auto-mode session
- Durability of proof artifacts across multiple test runs (S03 addresses this)
- Performance characteristics under load

## Notes for Tester

- The test uses synthetic fixture data — no real API calls or network activity
- Temp directories are cleaned up after test completion
- The dist-redirect.mjs workaround is specific to worktree testing — production code uses normal imports
- If dispatch rule matching fails, check that FACTCHECK-STATUS.json has `planImpacting: true` (boolean, not string)
