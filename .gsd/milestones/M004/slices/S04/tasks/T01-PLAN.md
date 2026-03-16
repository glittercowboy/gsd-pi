---
estimated_steps: 6
estimated_files: 3
---

# T01: Wire token measurement into metrics + auto + state

**Slice:** S04 — Token Measurement + State Derivation
**Milestone:** M004

## Description

Add `promptCharCount`/`baselineCharCount` to `UnitMetrics`, wire measurement into `dispatchNextUnit`, update all 11 `snapshotUnitMetrics` call sites, and add DB-first content loading to `deriveState()`. Three files modified with zero new files.

## Steps

1. **metrics.ts — Add fields to UnitMetrics and opts param to snapshotUnitMetrics**
   - Add `promptCharCount?: number;` and `baselineCharCount?: number;` to the `UnitMetrics` interface, after `userMessages: number;` (around line 42).
   - Add `opts?: { promptCharCount?: number; baselineCharCount?: number }` as the 6th parameter to `snapshotUnitMetrics` (after `model: string`, around line 107).
   - In the unit record construction (around line 155), spread opts into the object:
     ```ts
     ...(opts?.promptCharCount != null ? { promptCharCount: opts.promptCharCount } : {}),
     ...(opts?.baselineCharCount != null ? { baselineCharCount: opts.baselineCharCount } : {}),
     ```
   - Do NOT modify `loadLedgerFromDisk` or any other existing function.
   - Run `npx tsc --noEmit` to verify.

2. **auto.ts — Declare measurement variables**
   - Near line 210 (after the `let dispatchGapHandle` declaration, around the module-scoped variables section), add:
     ```ts
     /** Prompt character measurement for token savings analysis (R051). */
     let lastPromptCharCount: number | undefined;
     let lastBaselineCharCount: number | undefined;
     ```

3. **auto.ts — Reset measurement at top of dispatchNextUnit**
   - Inside `dispatchNextUnit`, immediately after the `invalidateAllCaches();` call (~line 1245), add:
     ```ts
     lastPromptCharCount = undefined;
     lastBaselineCharCount = undefined;
     ```

4. **auto.ts — Add measurement block after finalPrompt assembly**
   - After the observability repair block (after `if (repairBlock) { finalPrompt = ... }`, around line 1840), before the model switching section, add:
     ```ts
     // ── Prompt char measurement (R051) ──
     lastPromptCharCount = finalPrompt.length;
     lastBaselineCharCount = undefined;
     if (isDbAvailable()) {
       try {
         const { inlineGsdRootFile } = await import("./auto-prompts.js");
         const [decisionsContent, requirementsContent, projectContent] = await Promise.all([
           inlineGsdRootFile(basePath, "decisions.md", "Decisions"),
           inlineGsdRootFile(basePath, "requirements.md", "Requirements"),
           inlineGsdRootFile(basePath, "project.md", "Project"),
         ]);
         lastBaselineCharCount =
           (decisionsContent?.length ?? 0) +
           (requirementsContent?.length ?? 0) +
           (projectContent?.length ?? 0);
       } catch {
         // Non-fatal — baseline measurement is best-effort
       }
     }
     ```
   - Uses dynamic `import("./auto-prompts.js")` to avoid circular dependency (auto.ts → auto-dispatch.ts → auto-prompts.ts cycle). `isDbAvailable()` is already imported statically.

5. **auto.ts — Update all 11 snapshotUnitMetrics call sites**
   - Find all 11 `snapshotUnitMetrics(ctx,` calls in `auto.ts`. Each currently has 5 arguments: `(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId)`.
   - Add a 6th argument to each: `{ promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount }`.
   - Example transformation:
     ```ts
     // Before:
     snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
     // After:
     snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount });
     ```
   - There are exactly 11 call sites. Use `grep -n 'snapshotUnitMetrics(' auto.ts` to find them all. The import at line 66 should NOT be modified.
   - After updating, verify: `grep 'snapshotUnitMetrics(' src/resources/extensions/gsd/auto.ts | grep -cv 'promptCharCount'` should return 0 (meaning every call site has the opts).
   - Actually the import line doesn't contain a `(` followed by args — it's just the import name. The check should work. But be aware: the import line `snapshotUnitMetrics,` won't match `snapshotUnitMetrics(` so the grep is safe.

6. **state.ts — Add DB-first content loading tier to _deriveStateImpl**
   - Add imports at the top of `state.ts`:
     ```ts
     import { isDbAvailable, _getAdapter } from './gsd-db.js';
     ```
   - In `_deriveStateImpl`, before the existing `const batchFiles = nativeBatchParseGsdFiles(gsdDir);` line (~line 134), insert:
     ```ts
     // ── DB-first content loading ──
     // When the DB is available, load artifact content from the artifacts table
     // (indexed SELECT instead of O(N) file I/O). Falls back to native Rust batch
     // parser, which in turn falls back to sequential JS reads via cachedLoadFile.
     let dbContentLoaded = false;
     if (isDbAvailable()) {
       const adapter = _getAdapter();
       if (adapter) {
         try {
           const rows = adapter.prepare('SELECT path, full_content FROM artifacts').all();
           for (const row of rows) {
             const relPath = (row as Record<string, unknown>)['path'] as string;
             const content = (row as Record<string, unknown>)['full_content'] as string;
             const absPath = resolve(gsdDir, relPath);
             fileContentCache.set(absPath, content);
           }
           dbContentLoaded = rows.length > 0;
         } catch {
           // DB query failed — fall through to native batch parse
         }
       }
     }
     ```
   - Wrap the existing native batch parser block in `if (!dbContentLoaded) { ... }`:
     ```ts
     if (!dbContentLoaded) {
       const batchFiles = nativeBatchParseGsdFiles(gsdDir);
       if (batchFiles) {
         // ... existing code ...
       }
     }
     ```
   - The `cachedLoadFile` function and everything after the batch parser block stays unchanged — it reads from `fileContentCache` (now populated from either DB or batch parser) with disk fallback.

## Must-Haves

- [ ] `UnitMetrics` has `promptCharCount?: number` and `baselineCharCount?: number`
- [ ] `snapshotUnitMetrics` has optional 6th `opts` parameter
- [ ] All 11 call sites in `auto.ts` pass opts with both measurement values
- [ ] Measurement vars declared, reset at top of `dispatchNextUnit`, populated after `finalPrompt` assembly
- [ ] Dynamic import of `inlineGsdRootFile` from `auto-prompts.js` for baseline measurement (no static import)
- [ ] `_deriveStateImpl` queries DB artifacts table when available, falls back to native batch parser
- [ ] `_getAdapter()` null-checked before use in state.ts

## Observability Impact

- **Signal added:** `promptCharCount` and `baselineCharCount` fields in every `UnitMetrics` record written to `.gsd/metrics.json` (the metrics ledger). Present only when measurement succeeded — both are `undefined`/absent when DB is unavailable or `inlineGsdRootFile` throws.
- **Inspection:** `cat .gsd/metrics.json | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.units.forEach(u => { if(u.promptCharCount != null) console.log(u.id, u.promptCharCount, u.baselineCharCount) })"` — prints unit IDs with their char counts. Savings % = `(baseline - prompt) / baseline * 100`.
- **Failure visibility:** `lastBaselineCharCount` stays `undefined` when DB is off or `inlineGsdRootFile` throws — the catch block is silent and non-fatal. Absence of `baselineCharCount` in ledger entries is the diagnostic signal.
- **DB-first state loading:** When `_deriveStateImpl` uses the DB path, file cache population is logged implicitly via `dbContentLoaded = true`. If DB query fails, falls through to native batch parse silently.

## Verification

- `npx tsc --noEmit` — zero errors
- `grep -c 'lastPromptCharCount\|lastBaselineCharCount' src/resources/extensions/gsd/auto.ts` — returns ≥15
- `grep 'snapshotUnitMetrics(' src/resources/extensions/gsd/auto.ts | grep -cv 'promptCharCount'` — returns 0
- `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/metrics-io.test.ts` — existing tests pass (opts is optional)

## Inputs

- `src/resources/extensions/gsd/metrics.ts` — current `UnitMetrics` interface and `snapshotUnitMetrics` function
- `src/resources/extensions/gsd/auto.ts` — 11 `snapshotUnitMetrics` call sites, `dispatchNextUnit` function, `finalPrompt` assembly, `isDbAvailable` already imported
- `src/resources/extensions/gsd/state.ts` — `_deriveStateImpl` with native batch parser block
- `src/resources/extensions/gsd/gsd-db.ts` — `isDbAvailable()` and `_getAdapter()` exports
- `src/resources/extensions/gsd/auto-prompts.ts` — `inlineGsdRootFile` export (for dynamic import in measurement block)

## Expected Output

- `src/resources/extensions/gsd/metrics.ts` — `UnitMetrics` with 2 new optional fields, `snapshotUnitMetrics` with opts param
- `src/resources/extensions/gsd/auto.ts` — measurement vars, reset, measurement block, 11 updated call sites
- `src/resources/extensions/gsd/state.ts` — DB-first content loading tier before native batch parser
