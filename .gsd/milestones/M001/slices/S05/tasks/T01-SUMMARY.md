---
id: T01
parent: S05
milestone: M001
key_files:
  - src/resources/extensions/gsd/gsd-db.ts
  - src/resources/extensions/gsd/state.ts
  - src/resources/extensions/gsd/triage-resolution.ts
  - src/resources/extensions/gsd/tests/flag-file-db.test.ts
  - src/resources/extensions/gsd/tests/derive-state-db.test.ts
key_decisions:
  - deriveStateFromDb uses getReplanHistory().length for loop protection instead of disk REPLAN.md check
  - deriveStateFromDb uses getSlice().replan_triggered_at for trigger detection instead of disk REPLAN-TRIGGER.md check
  - triage-resolution.ts DB write is best-effort with silent catch — disk file remains primary for _deriveStateImpl fallback
  - Updated existing Test 16 in derive-state-db.test.ts to seed DB column since the DB path no longer reads disk flag files
duration: ""
verification_result: passed
completed_at: 2026-03-23T17:46:00.398Z
blocker_discovered: false
---

# T01: Schema v10 adds replan_triggered_at column; deriveStateFromDb uses DB queries for REPLAN/REPLAN-TRIGGER detection instead of disk files

**Schema v10 adds replan_triggered_at column; deriveStateFromDb uses DB queries for REPLAN/REPLAN-TRIGGER detection instead of disk files**

## What Happened

Implemented schema v10 and migrated flag-file detection from disk-based to DB-based in deriveStateFromDb().

**Schema v10 in gsd-db.ts:**
- Bumped SCHEMA_VERSION from 9 to 10
- Added `replan_triggered_at TEXT DEFAULT NULL` column to slices CREATE TABLE DDL (after `sequence`)
- Added `if (currentVersion < 10)` migration block using `ensureColumn()` for existing DBs
- Updated `SliceRow` interface with `replan_triggered_at: string | null`
- Updated `rowToSlice()` to read the column

**deriveStateFromDb() in state.ts:**
- Replaced `resolveSliceFile(... "REPLAN")` loop protection with `getReplanHistory(mid, sid).length > 0` — checks if replan was already completed via DB instead of checking for REPLAN.md on disk
- Replaced `resolveSliceFile(... "REPLAN-TRIGGER")` detection with `getSlice(mid, sid)?.replan_triggered_at` non-null check — detects triage-initiated replan trigger from DB column instead of REPLAN-TRIGGER.md on disk
- Added `getReplanHistory` and `getSlice` to the gsd-db.js import
- Left `_deriveStateImpl()` fallback path completely untouched — it still uses disk-based detection
- Left CONTINUE.md detection untouched per D003

**triage-resolution.ts executeReplan():**
- After writing the disk REPLAN-TRIGGER.md file (kept for fallback path), also writes `replan_triggered_at` column via `UPDATE slices SET replan_triggered_at = :ts`
- Uses lazy `createRequire(import.meta.url)` pattern (consistent with codebase convention) with `isDbAvailable()` gate
- DB write is best-effort — catches errors silently since disk file is primary for fallback path

**derive-state-db.test.ts fix:**
- Test 16 ("replanning-slice via DB") was seeding only a REPLAN-TRIGGER.md disk file without setting `replan_triggered_at` in DB. Updated to also seed the DB column so the DB-backed detection works correctly.

**flag-file-db.test.ts (new, 6 test cases):**
1. blocker_discovered + no replan_history → phase is replanning-slice
2. blocker_discovered + replan_history exists → loop protection, phase is executing
3. replan_triggered_at set + no replan_history → phase is replanning-slice
4. replan_triggered_at set + replan_history exists → loop protection, phase is executing
5. no blocker, no trigger → phase is executing (baseline)
6. Diagnostic: replan_triggered_at column is queryable (observability surface verification)

## Verification

All three verification suites pass with zero failures:
- flag-file-db.test.ts: 14 assertions passed across 6 test cases (including diagnostic)
- derive-state-db.test.ts: 105 assertions passed (0 regressions after Test 16 fix)
- derive-state-crossval.test.ts: 189 assertions passed (0 regressions)
- schema-v9-sequence.test.ts: 7 tests passed (v9 migration still works under v10)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/flag-file-db.test.ts` | 0 | ✅ pass | 2400ms |
| 2 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/derive-state-db.test.ts` | 0 | ✅ pass | 2400ms |
| 3 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/derive-state-crossval.test.ts` | 0 | ✅ pass | 2400ms |
| 4 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/schema-v9-sequence.test.ts` | 0 | ✅ pass | 2800ms |


## Deviations

Updated derive-state-db.test.ts Test 16 to seed replan_triggered_at DB column — the test was relying on disk-based REPLAN-TRIGGER.md detection which is now replaced by DB queries in deriveStateFromDb(). Added a 6th diagnostic test case in flag-file-db.test.ts beyond the 5 specified in the plan to verify observability surface (column queryability).

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/gsd-db.ts`
- `src/resources/extensions/gsd/state.ts`
- `src/resources/extensions/gsd/triage-resolution.ts`
- `src/resources/extensions/gsd/tests/flag-file-db.test.ts`
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts`
