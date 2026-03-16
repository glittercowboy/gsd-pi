---
id: T02
parent: S03
milestone: M004
provides:
  - DB lifecycle wired into auto-mode (init/migrate in startAuto, re-import in handleAgentEnd, close in stopAuto)
key_files:
  - src/resources/extensions/gsd/auto.ts
key_decisions:
  - Dynamic imports for gsd-db.js and md-importer.js in all lifecycle hooks to avoid loading heavy modules when DB is not needed
  - Auto-migration only triggers when .gsd/ directory exists with markdown artifacts but no gsd.db file
patterns_established:
  - DB lifecycle hook pattern: isDbAvailable() guard → dynamic import → operation → try/catch with stderr prefix logging
  - All DB operations non-fatal: try/catch wrapping with process.stderr.write for visibility, no throws that could block auto-mode
observability_surfaces:
  - "gsd-migrate: auto-migration failed:" stderr on first-run migration failure in startAuto()
  - "gsd-db: failed to open existing database:" stderr on DB open failure in startAuto()
  - "gsd-db: re-import failed:" stderr on re-import failure in handleAgentEnd()
  - isDbAvailable() boolean — true after successful init, false after closeDatabase()
duration: 8m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Wire DB lifecycle into auto.ts

**Wired SQLite DB lifecycle into auto-mode: auto-migration + open in startAuto(), re-import in handleAgentEnd(), close in stopAuto() — all non-fatal with stderr logging.**

## What Happened

Added ~35 lines across 3 insertion points in `auto.ts`:

1. **Import** — static import of `isDbAvailable` from `./gsd-db.js` (line 130)
2. **startAuto()** (lines 715-747) — Two blocks after worktree setup, before `initMetrics(base)`:
   - Block A: Auto-migration — if `.gsd/` has markdown artifacts (DECISIONS.md, REQUIREMENTS.md, or milestones/) but no `gsd.db`, dynamically imports `openDatabase` and `migrateFromMarkdown`, opens the DB, and runs migration
   - Block B: Open existing — if `gsd.db` exists but `isDbAvailable()` is false, opens it
3. **handleAgentEnd()** (lines 946-953) — After doctor/rebuildState/commit and artifact verification, before post-unit hooks: re-imports markdown into DB via `migrateFromMarkdown(basePath)` so next unit's prompts use fresh data
4. **stopAuto()** (lines 404-409) — After worktree teardown, before ledger/metrics: calls `closeDatabase()` guarded by `isDbAvailable()`

All operations use `basePath` (not `base`) for worktree awareness. All wrapped in try/catch with descriptive stderr logging. No existing logic modified.

## Verification

- `npx tsc --noEmit` — zero errors
- `grep -n 'isDbAvailable|openDatabase|closeDatabase|migrateFromMarkdown' auto.ts` — all 4 functions referenced at correct locations (startAuto lines 730-741, handleAgentEnd lines 946-949, stopAuto lines 404-407)
- `grep -n 'gsd-migrate:|gsd-db:' auto.ts` — stderr logging at all 3 insertion points (lines 735, 744, 951)
- prompt-db.test.ts — 36/36 assertions pass
- Full test suite — 186/186 tests pass, zero failures
- `grep 'inlineGsdRootFile(base' auto-prompts.ts` — returns only the 3 fallback calls inside DB-aware helpers (expected, not in prompt builders)

### Slice Verification Status (intermediate — T02 of T03)

| Check | Status |
|-------|--------|
| prompt-db.test.ts passes | ✅ |
| Full test suite (186 tests) | ✅ |
| `npx tsc --noEmit` clean | ✅ |
| `inlineGsdRootFile(base` zero matches in builders | ✅ (3 matches are fallback paths inside helpers) |

## Diagnostics

- `grep -n 'gsd-migrate:\|gsd-db:' src/resources/extensions/gsd/auto.ts` — shows the 3 stderr log sites
- `isDbAvailable()` — returns true after successful DB init in startAuto, false after stopAuto
- All DB failures produce stderr lines with `gsd-migrate:` or `gsd-db:` prefix — grep auto-mode logs for these prefixes to diagnose lifecycle issues

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/auto.ts` — Added isDbAvailable import, DB init/migrate block in startAuto(), re-import block in handleAgentEnd(), close block in stopAuto()
- `.gsd/milestones/M004/slices/S03/tasks/T02-PLAN.md` — Added Observability Impact section (pre-flight fix)
