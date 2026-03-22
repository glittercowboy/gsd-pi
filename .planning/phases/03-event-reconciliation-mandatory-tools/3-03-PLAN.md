---
phase: 03-event-reconciliation-mandatory-tools
plan: 03
type: tdd
wave: 2
depends_on: [3-01]
files_modified:
  - src/resources/extensions/gsd/workflow-migration.ts
  - src/resources/extensions/gsd/engine/migration.test.ts
  - src/resources/extensions/gsd/state.ts
  - src/resources/extensions/gsd/commands/handlers/ops.ts
  - src/resources/extensions/gsd/commands/catalog.ts
autonomous: true
requirements: [MIG-01, MIG-02, MIG-03]

must_haves:
  truths:
    - "migrateFromMarkdown() populates engine tables from existing markdown state files"
    - "Migration handles all .gsd/ directory shapes: no DB, stale DB, partial milestones, orphaned summaries"
    - "deriveState() auto-triggers migration when engine tables are empty and markdown exists"
    - "After migration, deriveState() returns engine state with no markdown parsing in the call path"
    - "A synthetic 'migrate' event is written to event log for fork-point baseline"
    - "Running `gsd migrate` from the CLI explicitly triggers migrateFromMarkdown as a failsafe"
    - "After migration, engine deriveState() and legacy deriveStateLegacy() produce equivalent output (discrepancies logged)"
  artifacts:
    - path: "src/resources/extensions/gsd/workflow-migration.ts"
      provides: "migrateFromMarkdown(), needsAutoMigration()"
      exports: ["migrateFromMarkdown", "needsAutoMigration"]
    - path: "src/resources/extensions/gsd/engine/migration.test.ts"
      provides: "Unit tests for migration and auto-trigger"
      min_lines: 100
  key_links:
    - from: "src/resources/extensions/gsd/state.ts"
      to: "src/resources/extensions/gsd/workflow-migration.ts"
      via: "dynamic import in deriveState() try block — needsAutoMigration check + migrateFromMarkdown call"
      pattern: "workflow-migration"
    - from: "src/resources/extensions/gsd/workflow-migration.ts"
      to: "src/resources/extensions/gsd/files.ts"
      via: "import parsePlan, parseRoadmap for markdown parsing"
      pattern: "parsePlan|parseRoadmap"
    - from: "src/resources/extensions/gsd/commands/handlers/ops.ts"
      to: "src/resources/extensions/gsd/workflow-migration.ts"
      via: "dynamic import of migrateFromMarkdown for gsd migrate CLI command"
      pattern: "workflow-migration"
---

<objective>
Build `gsd migrate` functionality: a workflow-migration.ts module that converts legacy markdown-only projects to engine state by parsing existing ROADMAP.md, *-PLAN.md, and *-SUMMARY.md files and inserting rows into engine tables. Wire auto-migration trigger into deriveState() and switch it to engine-only path after migration. Register `gsd migrate` CLI command as explicit failsafe entry point (D-12).

Purpose: Enable smooth onboarding of legacy projects (MIG-01, MIG-02) and eliminate markdown parsing from the deriveState() hot path (MIG-03).
Output: workflow-migration.ts module, migration.test.ts, updated state.ts, gsd migrate CLI command.
</objective>

<execution_context>
@/Users/jeremymcspadden/.claude/get-shit-done/workflows/execute-plan.md
@/Users/jeremymcspadden/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/03-event-reconciliation-mandatory-tools/3-CONTEXT.md
@.planning/phases/03-event-reconciliation-mandatory-tools/3-RESEARCH.md
@.planning/phases/03-event-reconciliation-mandatory-tools/3-01-SUMMARY.md

<interfaces>
<!-- Key types and contracts the executor needs. -->

From src/resources/extensions/gsd/workflow-engine.ts:
```typescript
export class WorkflowEngine {
  deriveState(): GSDState;
  // db is a private property — access via (engine as any).db for migration
}
export function getEngine(basePath: string): WorkflowEngine;
export function isEngineAvailable(basePath: string): boolean;
```

From src/resources/extensions/gsd/state.ts (lines 182-197 — modification target):
```typescript
// Engine bridge (Phase 1 dual-write — ENG-03, TOOL-02)
try {
  const { isEngineAvailable, getEngine } = await import('./workflow-engine.js');
  if (isEngineAvailable(basePath)) {
    const engine = getEngine(basePath);
    const engineState = engine.deriveState();
    _stateCache = { basePath, result: engineState, timestamp: Date.now() };
    _telemetry.engineDeriveCount++;
    return engineState;
  }
} catch {
  // Fall through to legacy markdown parse
}
```

From src/resources/extensions/gsd/files.ts (reusable parsers):
```typescript
export function parsePlan(content: string): { tasks: Array<{ id: string; name: string; status: string; ... }> };
export function parseRoadmap(content: string): { slices: Array<{ id: string; name: string; status: string; ... }> };
export function parseSummary(content: string): { frontmatter: Record<string, unknown>; body: string };
```

From src/resources/extensions/gsd/workflow-manifest.ts:
```typescript
export function writeManifest(basePath: string, db: DbAdapter): void;
```

From src/resources/extensions/gsd/workflow-events.ts:
```typescript
export function appendEvent(basePath: string, event: Omit<WorkflowEvent, "hash">): void;
```

From src/resources/extensions/gsd/gsd-db.ts:
```typescript
export function openDatabase(dbPath: string): void;
export function closeDatabase(): void;
export function _getAdapter(): DbAdapter;
export function initSchema(): void;
export function migrateSchema(): void;
// DbAdapter.prepare(sql).run(...params) for raw inserts
// DbAdapter.transaction(fn) for atomic operations
```

From src/resources/extensions/gsd/commands/handlers/ops.ts (CLI registration pattern):
```typescript
// Existing pattern at line 149-152:
if (trimmed === "migrate" || trimmed.startsWith("migrate ")) {
    const { handleMigrate } = await import("../../migrate/command.js");
    await handleMigrate(trimmed.replace(/^migrate\s*/, "").trim(), ctx, pi);
    return true;
}
```
NOTE: The existing `gsd migrate` command in ops.ts handles v1-to-v2 (.planning/ -> .gsd/) migration.
The NEW engine migration (D-12) is a DIFFERENT operation: it migrates markdown-only .gsd/ projects
to engine DB state. This needs a separate subcommand, e.g. `gsd migrate --engine` or a new entry
like `gsd migrate-engine`, to avoid conflicting with the existing v1-to-v2 migration.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: TDD migration module — tests first, then implementation</name>
  <files>src/resources/extensions/gsd/workflow-migration.ts, src/resources/extensions/gsd/engine/migration.test.ts</files>
  <read_first>
    src/resources/extensions/gsd/files.ts (parsePlan, parseRoadmap, parseSummary signatures and behavior)
    src/resources/extensions/gsd/workflow-engine.ts (WorkflowEngine class, deriveState method)
    src/resources/extensions/gsd/workflow-manifest.ts (writeManifest)
    src/resources/extensions/gsd/workflow-events.ts (appendEvent)
    src/resources/extensions/gsd/gsd-db.ts (openDatabase, initSchema, migrateSchema, _getAdapter, transaction)
    src/resources/extensions/gsd/engine/event-log.test.ts (test pattern)
  </read_first>
  <behavior>
    - Test 1: needsAutoMigration returns true when engine tables empty AND .gsd/milestones/ dir exists with markdown files
    - Test 2: needsAutoMigration returns false when engine tables already have rows
    - Test 3: needsAutoMigration returns false when no .gsd/milestones/ directory exists
    - Test 4: migrateFromMarkdown populates milestones table from ROADMAP.md
    - Test 5: migrateFromMarkdown populates slices table from ROADMAP.md slice entries
    - Test 6: migrateFromMarkdown populates tasks table from *-PLAN.md files
    - Test 7: migrateFromMarkdown marks completed milestones (those with milestone SUMMARY.md) as status='done' and all their child entities as done (Pitfall #5)
    - Test 8: migrateFromMarkdown handles "no DB yet" shape — creates DB, populates from markdown
    - Test 9: migrateFromMarkdown handles "stale DB" shape — wipes engine tables, re-populates
    - Test 10: migrateFromMarkdown handles orphaned summary files — logs warning, does not crash
    - Test 11: migrateFromMarkdown writes a synthetic "migrate" event to event-log.jsonl with actor="system", cmd="migrate"
    - Test 12: migrateFromMarkdown calls writeManifest after all inserts
    - Test 13: After migrateFromMarkdown, engine deriveState() produces output with matching milestone/slice/task counts and statuses compared to parsing markdown directly (D-14 validation). Log any discrepancies to stderr but do not throw.
  </behavior>
  <action>
RED phase:
Create `src/resources/extensions/gsd/engine/migration.test.ts` with 13 test cases. Setup:
- Create temp dir with `.gsd/milestones/M001/` structure
- Write sample ROADMAP.md with 2 slices (one done, one pending)
- Write sample S01-PLAN.md with 3 tasks (2 done, 1 pending)
- Write sample S01-SUMMARY.md for the done slice
- Use `openDatabase(join(tempDir, ".gsd", "gsd.db"))`, `initSchema()`, `migrateSchema()` to set up v5 tables
- Import `migrateFromMarkdown`, `needsAutoMigration` from `../workflow-migration.ts`
- Tests MUST fail (module doesn't exist yet)

GREEN phase:
Create `src/resources/extensions/gsd/workflow-migration.ts` with file header:
```
// GSD Extension — Legacy Markdown to Engine Migration
// Converts legacy markdown-only projects to engine state by parsing
// existing ROADMAP.md, *-PLAN.md, and *-SUMMARY.md files.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
```

Exports:
- `function needsAutoMigration(basePath: string): boolean`
  1. Get db adapter via dynamic import of gsd-db.js → _getAdapter()
  2. Query: `SELECT COUNT(*) as cnt FROM milestones` — if cnt > 0, return false
  3. Check: `existsSync(join(basePath, ".gsd", "milestones"))` — if false, return false
  4. Return true

- `function migrateFromMarkdown(basePath: string): void`
  1. Get db adapter via `_getAdapter()` from gsd-db.js
  2. Read `.gsd/milestones/` directory — list all milestone dirs (pattern: `M\d+` or similar)
  3. For each milestone dir:
     a. Check for milestone-level SUMMARY.md → milestone status = "done" if exists, "active" otherwise
     b. Read ROADMAP.md if present → parse with `parseRoadmap()` from files.ts → extract slice list with IDs and statuses
     c. For each slice: read `{sliceId}-PLAN.md` if present → parse with `parsePlan()` → extract tasks
     d. For each done slice: read `{sliceId}-SUMMARY.md` if present → parse with `parseSummary()` → extract summary text
  4. Wrap all inserts in `db.transaction(() => { ... })`:
     a. For each milestone: `db.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)").run(id, title, status, new Date().toISOString())`
     b. For each slice: `db.prepare("INSERT INTO slices (id, milestone_id, title, status, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(...)`
     c. For each task: `db.prepare("INSERT INTO tasks (id, slice_id, milestone_id, title, status, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(...)`
     d. Per Pitfall #5: if milestone is done, force ALL child slices and tasks to status='done' regardless of parsed status
  5. After transaction: call `appendEvent(basePath, { cmd: "migrate", params: { milestonIds: [...] }, ts: new Date().toISOString(), actor: "system" })` — synthetic event for fork-point baseline
  6. Call `writeManifest(basePath, db)` to write state-manifest.json
  7. Handle orphaned summaries (summary file exists but slice not found in ROADMAP) — `process.stderr.write()` warning, skip

- `function validateMigration(basePath: string): { discrepancies: string[] }` (D-14)
  1. Get engine via `getEngine(basePath)` and call `engine.deriveState()` for engine state
  2. Parse markdown directly using existing parsers for legacy state
  3. Compare milestone count, slice count, task count, and status distributions
  4. Log each discrepancy to stderr via `process.stderr.write()`
  5. Return array of discrepancy strings (empty = clean migration)

Error handling for directory shapes:
- No DB yet: The caller (deriveState) handles DB creation via openDatabase + initSchema
- Stale DB (tables exist but empty): needsAutoMigration returns true → migrateFromMarkdown runs normally (tables empty, inserts succeed)
- No markdown at all: `readdirSync(milestonesDir)` returns empty → no-op, return early with stderr message

Run tests — all 13 must pass.
  </action>
  <verify>
    <automated>node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/engine/migration.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - src/resources/extensions/gsd/workflow-migration.ts contains `export function migrateFromMarkdown(`
    - src/resources/extensions/gsd/workflow-migration.ts contains `export function needsAutoMigration(`
    - src/resources/extensions/gsd/workflow-migration.ts contains `export function validateMigration(`
    - src/resources/extensions/gsd/workflow-migration.ts contains `parsePlan` or `parseRoadmap` (reuses existing parsers)
    - src/resources/extensions/gsd/workflow-migration.ts contains `transaction(` (atomic inserts)
    - src/resources/extensions/gsd/workflow-migration.ts contains `writeManifest(`
    - src/resources/extensions/gsd/workflow-migration.ts contains `appendEvent(`
    - src/resources/extensions/gsd/workflow-migration.ts contains `actor: "system"`
    - src/resources/extensions/gsd/workflow-migration.ts contains `Copyright (c) 2026 Jeremy McSpadden`
    - src/resources/extensions/gsd/engine/migration.test.ts exits 0 with all tests passing
  </acceptance_criteria>
  <done>Migration module parses markdown state, populates engine tables atomically, handles all directory shapes, writes synthetic migrate event for fork-point baseline, calls writeManifest, and validates engine vs legacy output (D-14). All 13 tests pass.</done>
</task>

<task type="auto">
  <name>Task 2: Wire auto-migration into deriveState() and switch to engine-only path</name>
  <files>src/resources/extensions/gsd/state.ts</files>
  <read_first>
    src/resources/extensions/gsd/state.ts (full file — especially lines 170-210, the deriveState function)
    src/resources/extensions/gsd/workflow-migration.ts (just created in Task 1)
  </read_first>
  <action>
Modify `deriveState()` in `src/resources/extensions/gsd/state.ts` at the engine bridge section (lines 182-197).

Current code:
```typescript
try {
  const { isEngineAvailable, getEngine } = await import('./workflow-engine.js');
  if (isEngineAvailable(basePath)) {
    const engine = getEngine(basePath);
    const engineState = engine.deriveState();
    _stateCache = { basePath, result: engineState, timestamp: Date.now() };
    _telemetry.engineDeriveCount++;
    return engineState;
  }
} catch {
  // Fall through to legacy markdown parse
}
```

Replace with (per D-11 and Pitfall #4):
```typescript
// Engine bridge (Phase 3 — MIG-03)
// When WorkflowEngine is available, use engine exclusively.
// Auto-migrate from markdown if tables are empty (D-11).
try {
  const { isEngineAvailable, getEngine } = await import('./workflow-engine.js');
  if (isEngineAvailable(basePath)) {
    const engine = getEngine(basePath);

    // Auto-migration trigger (D-11): if engine tables empty AND markdown exists
    try {
      const { needsAutoMigration, migrateFromMarkdown, validateMigration } = await import('./workflow-migration.js');
      if (needsAutoMigration(basePath)) {
        migrateFromMarkdown(basePath);
        // D-14: validate migration output, log discrepancies
        const { discrepancies } = validateMigration(basePath);
        if (discrepancies.length > 0) {
          process.stderr.write(`workflow-migration: ${discrepancies.length} discrepancy(ies) after migration (engine state is authoritative)\n`);
        }
      }
    } catch (migErr) {
      process.stderr.write(`workflow-migration: auto-migration failed: ${(migErr as Error).message}\n`);
      // Continue — engine may still have valid state from prior migration
    }

    const engineState = engine.deriveState();
    _stateCache = { basePath, result: engineState, timestamp: Date.now() };
    _telemetry.engineDeriveCount++;
    return engineState;
  }
} catch {
  // Fall through to legacy markdown parse — engine not yet initialized or import failed
}
```

Key points:
- Migration try/catch is INSIDE the engine try block, not outside (Pitfall #4)
- Migration failure does NOT prevent engine from returning state — it logs warning and continues
- After migration, validateMigration() is called to compare engine vs legacy output (D-14)
- After migration, the normal `engine.deriveState()` call runs and returns engine state
- Legacy fallback (`_deriveStateImpl`) is preserved for cold start when engine isn't available at all

Also: rename `_deriveStateImpl` to `_deriveStateLegacy` per D-15 and add a comment:
```typescript
// Legacy markdown parser — preserved for disaster recovery only (D-15).
// After Phase 3 auto-migration, this path should only be hit when engine is truly unavailable.
```
  </action>
  <verify>
    <automated>node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/engine/*.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - src/resources/extensions/gsd/state.ts contains `workflow-migration.js` (dynamic import)
    - src/resources/extensions/gsd/state.ts contains `needsAutoMigration(`
    - src/resources/extensions/gsd/state.ts contains `migrateFromMarkdown(`
    - src/resources/extensions/gsd/state.ts contains `validateMigration(`
    - src/resources/extensions/gsd/state.ts contains `_deriveStateLegacy` (renamed from _deriveStateImpl per D-15)
    - src/resources/extensions/gsd/state.ts contains `disaster recovery` (D-15 comment)
    - All engine tests still pass
  </acceptance_criteria>
  <done>deriveState() auto-triggers migration when engine tables empty, validates output (D-14), then returns engine state exclusively. Legacy markdown parser renamed to _deriveStateLegacy and preserved for disaster recovery only. All tests pass.</done>
</task>

<task type="auto">
  <name>Task 3: Register `gsd migrate --engine` CLI command (D-12)</name>
  <files>src/resources/extensions/gsd/commands/handlers/ops.ts, src/resources/extensions/gsd/commands/handlers/core.ts</files>
  <read_first>
    src/resources/extensions/gsd/commands/handlers/ops.ts (existing migrate handler at lines 149-152)
    src/resources/extensions/gsd/commands/handlers/core.ts (help text)
    src/resources/extensions/gsd/workflow-migration.ts (migrateFromMarkdown, validateMigration from Task 1)
  </read_first>
  <action>
The existing `gsd migrate` command handles v1-to-v2 (.planning/ to .gsd/) format migration. D-12 requires an explicit CLI entry point for the engine migration (markdown .gsd/ to engine DB state). Add this as a `--engine` flag on the existing migrate command.

**ops.ts — modify the existing migrate handler (lines 149-152):**

Change from:
```typescript
if (trimmed === "migrate" || trimmed.startsWith("migrate ")) {
    const { handleMigrate } = await import("../../migrate/command.js");
    await handleMigrate(trimmed.replace(/^migrate\s*/, "").trim(), ctx, pi);
    return true;
}
```

To:
```typescript
if (trimmed === "migrate" || trimmed.startsWith("migrate ")) {
    const migrateArgs = trimmed.replace(/^migrate\s*/, "").trim();

    // D-12: explicit engine migration failsafe
    if (migrateArgs === "--engine" || migrateArgs.startsWith("--engine ")) {
      try {
        const { migrateFromMarkdown, validateMigration } = await import("../../workflow-migration.js");
        ctx.ui.notify("Running engine migration (markdown -> engine DB)...", "info");
        migrateFromMarkdown(process.cwd());
        const { discrepancies } = validateMigration(process.cwd());
        if (discrepancies.length > 0) {
          ctx.ui.notify(
            `Migration complete with ${discrepancies.length} discrepancy(ies):\n${discrepancies.map(d => `  - ${d}`).join("\n")}`,
            "warning",
          );
        } else {
          ctx.ui.notify("Engine migration complete — all entities migrated successfully.", "info");
        }
      } catch (err) {
        ctx.ui.notify(
          `Engine migration failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
      return true;
    }

    // Existing v1-to-v2 migration
    const { handleMigrate } = await import("../../migrate/command.js");
    await handleMigrate(migrateArgs, ctx, pi);
    return true;
}
```

**core.ts — update help text:**

Find the line:
```
"  /gsd migrate        Migrate .planning/ (v1) to .gsd/ (v2) format",
```

Replace with:
```
"  /gsd migrate        Migrate .planning/ (v1) to .gsd/ (v2) format  [--engine]",
```
  </action>
  <verify>
    <automated>grep -n "migrate.*--engine" src/resources/extensions/gsd/commands/handlers/ops.ts src/resources/extensions/gsd/commands/handlers/core.ts</automated>
  </verify>
  <acceptance_criteria>
    - src/resources/extensions/gsd/commands/handlers/ops.ts contains `--engine`
    - src/resources/extensions/gsd/commands/handlers/ops.ts contains `migrateFromMarkdown(`
    - src/resources/extensions/gsd/commands/handlers/ops.ts contains `validateMigration(`
    - src/resources/extensions/gsd/commands/handlers/core.ts contains `--engine`
  </acceptance_criteria>
  <done>`gsd migrate --engine` explicitly triggers migrateFromMarkdown() + validateMigration() as a CLI failsafe (D-12). Help text updated. Original v1-to-v2 migration path preserved for `gsd migrate` without flags.</done>
</task>

</tasks>

<verification>
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/engine/migration.test.ts` — all 13 migration tests pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/engine/*.test.ts` — all engine tests pass
- `grep "needsAutoMigration" src/resources/extensions/gsd/state.ts` — returns match
- `grep "_deriveStateLegacy" src/resources/extensions/gsd/state.ts` — returns match
- `grep "migrateFromMarkdown" src/resources/extensions/gsd/commands/handlers/ops.ts` — returns match (CLI wiring)
</verification>

<success_criteria>
Migration converts legacy markdown to engine state. Auto-trigger in deriveState() handles transparent migration with D-14 validation. deriveState() uses engine exclusively after migration. `gsd migrate --engine` CLI command available as explicit failsafe. All tests pass.
</success_criteria>

<output>
After completion, create `.planning/phases/03-event-reconciliation-mandatory-tools/3-03-SUMMARY.md`
</output>
