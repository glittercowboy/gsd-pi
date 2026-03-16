# S07: Integration Verification + Polish — UAT

**Milestone:** M004
**Written:** 2026-03-16

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S07 is a pure verification slice — all work is test files and requirement promotion. No new runtime behavior was introduced. The integration tests themselves are the UAT artifacts; running them is the complete verification.

## Preconditions

- Working directory: `.gsd/worktrees/M004` (or main project root after merge)
- Node 22.x with `node:sqlite` support (`node --version` → `v22.x.x` or higher)
- Dependencies installed (`npm ci` or `npm install` if needed)
- No pre-existing `/tmp/gsd-int-*` directories from crashed prior runs (safe to delete if present)

## Smoke Test

Run the lifecycle test and confirm it prints token savings ≥ 30%:

```
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/integration-lifecycle.test.ts
```

Expected: `Token savings: 42.4% (scoped: 5242, full: 9101)` in stdout, `Results: 50 passed, 0 failed` at end.

## Test Cases

### 1. Full M004 pipeline — integration-lifecycle

```
node --experimental-sqlite \
  --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types \
  --test src/resources/extensions/gsd/tests/integration-lifecycle.test.ts
```

1. Run the command above.
2. Observe stdout header: `=== integration-lifecycle: full pipeline ===`
3. Observe migration log: `gsd-migrate: imported 14 decisions, 12 requirements, 1 artifacts`
4. Observe token savings line: `Token savings: XX.X% (scoped: N, full: M)`
5. Observe re-import log: `gsd-migrate: imported 15 decisions, 12 requirements, 1 artifacts`
6. **Expected:** `Results: 50 passed, 0 failed` — all assertions pass, savings percentage ≥ 30%

### 2. Edge cases — integration-edge

```
node --experimental-sqlite \
  --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types \
  --test src/resources/extensions/gsd/tests/integration-edge.test.ts
```

1. Run the command above.
2. Observe three section headers: empty project, partial migration, fallback mode.
3. **Expected:** `Results: 33 passed, 0 failed`

### 3. Token savings measurements

```
node --experimental-sqlite \
  --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types \
  --test src/resources/extensions/gsd/tests/token-savings.test.ts
```

1. Run the command above.
2. Observe printed savings: `Decisions savings (M001): 66.3%`, `Research-milestone composite savings: 32.2%`
3. **Expected:** `Results: 99 passed, 0 failed` — all three scenario savings exceed 30%

### 4. Full test suite

```
npm test
```

1. Run the command above.
2. **Expected:** 371 unit tests pass, 0 fail. `pack-install.test.ts` fails with "dist/ not found" — this is pre-existing and expected. All other tests pass.

### 5. TypeScript clean compile

```
npx tsc --noEmit
```

1. Run the command above.
2. **Expected:** No output (zero errors). Command exits 0.

### 6. Requirements state

```
grep -c "Status: validated" .gsd/REQUIREMENTS.md
```

1. Run the command above.
2. **Expected:** `46` — all 8 M004 requirements (R045, R047–R052, R057) promoted plus 38 previously validated.

## Edge Cases

### Empty project — no crashes, correct zero counts

The `integration-edge.test.ts` empty-project scenario covers this. If running manually:
1. Create a temp dir with no `.gsd/` files
2. Call `migrateFromMarkdown(tmpDir)` programmatically
3. **Expected:** `gsd-migrate: imported 0 decisions, 0 requirements, 0 artifacts` — no throw, all query functions return empty arrays/null

### Partial migration — DECISIONS.md only

Covered by integration-edge scenario 2:
1. Provide `.gsd/DECISIONS.md` with 6 entries, no REQUIREMENTS.md
2. Call `migrateFromMarkdown(tmpDir)`
3. **Expected:** 6 decisions imported, requirements return `[]` without crash

### Fallback mode — DB unavailable after close

Covered by integration-edge scenario 3:
1. `closeDatabase()` + `_resetProvider()`
2. `isDbAvailable()` returns false
3. All query functions return empty results
4. `openDatabase(dbPath)` at same path restores all rows
5. **Expected:** Zero crashes throughout; data survives close/reopen cycle

### Residual temp files

If a test run crashes mid-execution:
```
ls /tmp/gsd-int-*
```
1. **Expected in normal operation:** No directories matching `gsd-int-*` (all cleaned by try/finally)
2. If directories exist: safe to `rm -rf /tmp/gsd-int-*` — these are orphaned test artifacts

## Failure Signals

- `Results: N passed, M failed` with M > 0 in any integration test file — indicates a subsystem regression
- `Token savings: XX.X%` where XX.X < 30 — prompt injection or measurement block broken
- `gsd-migrate: imported 0 decisions` when fixture has content — markdown parser or DB write failed
- `npx tsc --noEmit` produces any output — TypeScript type error introduced
- `grep -c "Status: validated" .gsd/REQUIREMENTS.md` returns < 46 — requirement promotion incomplete

## Requirements Proved By This UAT

- R045 — WAL mode assertion in lifecycle step 3; DB availability throughout pipeline
- R047 — Migration log `imported 14 decisions, 12 requirements, 1 artifacts` in lifecycle step 2; re-import log `imported 15 decisions` in step 8
- R048 — Round-trip parse→generate→parse in lifecycle step 10 produces field-identical output
- R049 — Scoped queries (M001+M002 sums to total, no cross-contamination) in lifecycle steps 3–5
- R050 — Re-import after content change in lifecycle step 8 reflects updated DECISIONS.md in DB
- R051 — Token savings ≥ 30% assertion in lifecycle step 7 + 99 token-savings.test.ts assertions
- R052 — DB populated and queryable throughout lifecycle proves DB-first content loading works
- R057 — 42.4% lifecycle savings + 52.2% plan-slice + 66.3% decisions-only + 32.2% composite all exceed ≥30%

## Not Proven By This UAT

- Live auto-mode run with a real project and real LLM dispatch (UAT type: human-experience)
- `/gsd inspect` command output in the actual pi TUI (covered by S06 gsd-inspect.test.ts)
- Worktree DB copy/merge on a real git repository workflow (covered by S05 worktree-db-integration.test.ts)
- Structured LLM tool calls in a live session (covered by S06 gsd-tools.test.ts)

## Notes for Tester

- All integration tests use file-backed DBs in temp dirs — they do not modify any project state
- The `pack-install.test.ts` failure is expected and pre-existing (requires `dist/` from a build)
- Token savings numbers are deterministic against the fixture data — 42.4% lifecycle, 52.2% plan-slice, 66.3% decisions-only, 32.2% research composite
- If `node:sqlite` is unavailable (Node < 22.5 without better-sqlite3), all DB tests will fail gracefully — the fallback path is tested separately in integration-edge scenario 3
