---
estimated_steps: 4
estimated_files: 1
---

# T02: Wire DB lifecycle into auto.ts

**Slice:** S03 — Surgical Prompt Injection + Dual-Write
**Milestone:** M004

## Description

Wire the SQLite DB lifecycle into auto-mode: open/migrate the DB in `startAuto()`, re-import markdown changes in `handleAgentEnd()`, and close the DB in `stopAuto()`. All operations are non-fatal with graceful fallback.

## Steps

1. **Add `isDbAvailable` import at top of auto.ts.** Add a static import of `isDbAvailable` from `./gsd-db.js`. The lifecycle functions (`openDatabase`, `closeDatabase`, `migrateFromMarkdown`) use dynamic `await import()` to avoid loading heavy modules when DB is not needed.

2. **Add DB init in `startAuto()`** — insert AFTER the auto-worktree try/catch block (which ends around line 748) and BEFORE `initMetrics(base)` (around line 753). This must use `basePath` (not `base`) because worktree setup may have changed it. Two blocks:

   **Block A — Auto-migration** (if `gsd.db` doesn't exist but markdown does):
   ```
   const gsdDbPath = join(basePath, ".gsd", "gsd.db");
   const gsdDirPath = join(basePath, ".gsd");
   if (existsSync(gsdDirPath) && !existsSync(gsdDbPath)) {
     const hasDecisions = existsSync(join(gsdDirPath, "DECISIONS.md"));
     const hasRequirements = existsSync(join(gsdDirPath, "REQUIREMENTS.md"));
     const hasMilestones = existsSync(join(gsdDirPath, "milestones"));
     if (hasDecisions || hasRequirements || hasMilestones) {
       try {
         const { openDatabase: openDb } = await import("./gsd-db.js");
         const { migrateFromMarkdown } = await import("./md-importer.js");
         openDb(gsdDbPath);
         migrateFromMarkdown(basePath);
       } catch (err) {
         process.stderr.write(`gsd-migrate: auto-migration failed: ${(err as Error).message}\n`);
       }
     }
   }
   ```

   **Block B — Open existing DB** (if `gsd.db` exists but DB not yet open):
   ```
   if (existsSync(gsdDbPath) && !isDbAvailable()) {
     try {
       const { openDatabase: openDb } = await import("./gsd-db.js");
       openDb(gsdDbPath);
     } catch (err) {
       process.stderr.write(`gsd-db: failed to open existing database: ${(err as Error).message}\n`);
     }
   }
   ```

   **Critical placement constraint:** `basePath` may differ from `base` after worktree creation. Use `basePath` for the DB path, not `base`.

3. **Add re-import in `handleAgentEnd()`** — insert AFTER the `rebuildState + autoCommitCurrentBranch` block (around line 858, after the rewrite-docs completion block) and BEFORE the `// ── Post-unit hooks` comment. This ensures markdown files are in final state before re-import, and DB is fresh before hooks dispatch the next unit.

   ```
   // ── DB dual-write: re-import changed markdown files so next unit's prompts use fresh data ──
   if (isDbAvailable()) {
     try {
       const { migrateFromMarkdown } = await import("./md-importer.js");
       migrateFromMarkdown(basePath);
     } catch (err) {
       process.stderr.write(`gsd-db: re-import failed: ${(err as Error).message}\n`);
     }
   }
   ```

4. **Add DB close in `stopAuto()`** — insert AFTER the auto-worktree teardown block (around line 401, after the worktree try/catch that restores `basePath`) and BEFORE the ledger/metrics section. Non-fatal.

   ```
   // ── DB cleanup: close the SQLite connection ──
   if (isDbAvailable()) {
     try {
       const { closeDatabase } = await import("./gsd-db.js");
       closeDatabase();
     } catch { /* non-fatal */ }
   }
   ```

## Must-Haves

- [ ] DB auto-migration runs in `startAuto()` when `gsd.db` missing but markdown exists
- [ ] Existing `gsd.db` opened in `startAuto()` when not yet open
- [ ] Re-import runs in `handleAgentEnd()` after doctor/rebuildState/commit, before hooks
- [ ] `closeDatabase()` called in `stopAuto()` after worktree teardown
- [ ] All operations non-fatal (try/catch, stderr logging)
- [ ] Uses `basePath` not `base` for DB path (worktree-aware)
- [ ] TypeScript compiles clean

## Verification

- `npx tsc --noEmit` — zero errors
- `grep -n 'isDbAvailable\|openDatabase\|closeDatabase\|migrateFromMarkdown' src/resources/extensions/gsd/auto.ts` — shows all 4 functions referenced at correct locations (startAuto, handleAgentEnd, stopAuto)
- Verify placement: `grep -n 'gsd-migrate:\|gsd-db:' src/resources/extensions/gsd/auto.ts` — shows stderr logging at the 3 insertion points

## Inputs

- `src/resources/extensions/gsd/auto.ts` — current 2344-line file. Key locations: `startAuto()` at line 478, `handleAgentEnd()` at line 805, `stopAuto()` at line 371
- `src/resources/extensions/gsd/gsd-db.ts` — provides `openDatabase()`, `closeDatabase()`, `isDbAvailable()` (S01 output)
- `src/resources/extensions/gsd/md-importer.ts` — provides `migrateFromMarkdown()` (S02 output)
- Reference: memory-db `auto.ts` lines 635-668 (DB init), 875-882 (re-import)

## Expected Output

- `src/resources/extensions/gsd/auto.ts` — modified with ~30 new lines across 3 insertion points. DB lifecycle fully wired. All existing logic untouched.

## Observability Impact

- **New stderr signals:** `gsd-migrate: auto-migration failed: <msg>` on first-run migration failure in `startAuto()`, `gsd-db: failed to open existing database: <msg>` on DB open failure, `gsd-db: re-import failed: <msg>` on re-import failure in `handleAgentEnd()`
- **Inspection:** `isDbAvailable()` returns `true` after successful DB init in `startAuto()`, `false` after `closeDatabase()` in `stopAuto()`
- **Failure state:** All DB operations are non-fatal — failures produce stderr lines and the system degrades to filesystem-only mode silently
