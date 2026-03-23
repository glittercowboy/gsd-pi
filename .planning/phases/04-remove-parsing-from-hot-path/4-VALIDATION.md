# Phase 4: Remove Parsing from Hot Path - Validation

**Generated:** 2026-03-22
**Source:** 4-RESEARCH.md Validation Architecture (lines 526-557)

## Test Framework

| Property | Value |
|----------|-------|
| Framework | Node.js built-in test runner (--experimental-strip-types) |
| Config file | none — package.json test scripts |
| Quick run command | `npm run test:unit -- --test-name-pattern "doctor"` |
| Full suite command | `npm run test:unit` |

## Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | Test File | Status |
|--------|----------|-----------|-------------------|-----------|--------|
| DOC-01 | `gsd doctor` does not detect orphaned_completed_units or call verifyExpectedArtifact for checkbox state | unit | `npm run test:unit -- --test-name-pattern "doctor-runtime"` | src/resources/extensions/gsd/tests/doctor-runtime.test.ts | Exists — needs regression test added (Wave 0) |
| DOC-02 | writeBlockerPlaceholder and skipExecuteTask no longer exist in auto-recovery.ts | unit | `npm run test:unit -- --test-name-pattern "auto-recovery"` | src/resources/extensions/gsd/tests/auto-recovery.test.ts | Exists — needs export removal test added (Wave 0) |
| DOC-03 | Health scoring does not escalate on "consecutive error units caused by state drift" | unit | `npm run test:unit -- --test-name-pattern "doctor-proactive"` | src/resources/extensions/gsd/tests/doctor-proactive.test.ts | Exists — needs projection drift test added (Wave 0) |
| DOC-04 | checkGitHealth, checkGlobalHealth, checkRuntimeHealth (infrastructure) still run | unit | `npm run test:unit -- --test-name-pattern "doctor"` | src/resources/extensions/gsd/tests/doctor.test.ts | Exists |
| DOC-05 | checkEngineHealth() reports orphaned tasks, slices-without-milestones, done-tasks-without-summaries | unit | `npm run test:unit -- --test-name-pattern "doctor-runtime"` | src/resources/extensions/gsd/tests/doctor-runtime.test.ts | Missing — Wave 0 must add checkEngineHealth tests |
| CLN-07 | parseRoadmap/parsePlan/parseSummary exported from legacy/parsers.ts; hot-path files do NOT import from files.ts for these functions | unit | `npm run test:unit -- --test-name-pattern "parsers"` | src/resources/extensions/gsd/tests/parsers.test.ts (+ new import-boundary.test.ts) | Missing — Wave 0 must add import boundary test |

## Wave 0 Test Gaps

These test cases MUST be created before the plans that depend on them.

### Gap 1: checkEngineHealth tests (DOC-05, needed by Plan 4-02)
- **File:** `src/resources/extensions/gsd/tests/doctor-runtime.test.ts`
- **Tests to add:**
  - `checkEngineHealth reports db_orphaned_task when task references non-existent slice`
  - `checkEngineHealth reports db_orphaned_slice when slice references non-existent milestone`
  - `checkEngineHealth reports db_done_task_no_summary when done task has no summary`
  - `checkEngineHealth reports db_duplicate_id when duplicate milestone/slice/task IDs exist`
- **Pattern:** RED phase only — tests call `checkEngineHealth()` and assert on `issues[]` codes. They will fail until Plan 4-02 Task 1 implements the function.

### Gap 2: orphaned_completed_units regression test (DOC-01, needed by Plan 4-02)
- **File:** `src/resources/extensions/gsd/tests/doctor-runtime.test.ts`
- **Test to add:**
  - `checkRuntimeHealth does not push orphaned_completed_units issues`
- **Pattern:** Assert that after running checkRuntimeHealth, no issue has `code: "orphaned_completed_units"`.

### Gap 3: removed export tests (DOC-02, needed by Plan 4-03)
- **File:** `src/resources/extensions/gsd/tests/auto-recovery.test.ts`
- **Tests to add:**
  - `writeBlockerPlaceholder is not exported from auto-recovery`
  - `skipExecuteTask is not exported from auto-recovery`
- **Pattern:** Dynamic import `auto-recovery.ts` and assert the named exports do not include these functions.

### Gap 4: pre-dispatch projection drift test (DOC-03, needed by Plan 4-02)
- **File:** `src/resources/extensions/gsd/tests/doctor-proactive.test.ts`
- **Test to add:**
  - `preDispatchHealthGate re-renders projections when event log is newer than projection files`
- **Pattern:** Set up stale projection file, add newer event, call preDispatchHealthGate, verify projection was re-rendered.

### Gap 5: import boundary test (CLN-07, needed by Plan 4-01)
- **File:** `src/resources/extensions/gsd/tests/import-boundary.test.ts` (new file)
- **Tests to add:**
  - `legacy/parsers.ts exports parseRoadmap, parsePlan, parseSummary`
  - `doctor-checks.ts does not import from legacy/parsers`
  - `auto-recovery.ts does not import from legacy/parsers`
  - `state.ts does not import parseRoadmap/parsePlan/parseSummary from files.ts`
- **Pattern:** Read file contents as strings and assert on import statements. No runtime execution needed.

## Sampling Rate

- **Per task commit:** `npm run test:unit -- --test-name-pattern "doctor|auto-recovery|forensics|parsers|import-boundary"`
- **Per wave merge:** `npm run test:unit`
- **Phase gate:** Full suite green before `/gsd:verify-work`

## Verification Commands

```bash
# Wave 0 verification (after 4-00 completes)
npm run test:unit -- --test-name-pattern "doctor-runtime|auto-recovery|doctor-proactive|import-boundary"

# Wave 1 verification (after 4-01 completes)
npm run test:unit -- --test-name-pattern "parsers|import-boundary"
npx tsc --noEmit

# Wave 2 verification (after 4-02 and 4-03 complete)
npm run test:unit -- --test-name-pattern "doctor|auto-recovery|forensics"
npx tsc --noEmit

# Phase gate
npm run test:unit
npx tsc --noEmit
```
