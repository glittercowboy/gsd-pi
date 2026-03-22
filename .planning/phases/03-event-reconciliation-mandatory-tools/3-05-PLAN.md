---
phase: 03-event-reconciliation-mandatory-tools
plan: 05
type: tdd
wave: 2
depends_on: [3-01]
files_modified:
  - src/resources/extensions/gsd/workflow-reconcile.ts
  - src/resources/extensions/gsd/engine/resolve-conflict.test.ts
  - src/resources/extensions/gsd/commands/handlers/ops.ts
  - src/resources/extensions/gsd/commands/handlers/core.ts
  - src/resources/extensions/gsd/commands/catalog.ts
autonomous: true
requirements: [SYNC-05]

must_haves:
  truths:
    - "gsd resolve-conflict --entity {type}:{id} --pick {main|worktree} resolves a single conflict entry"
    - "After all conflicts resolved, re-running sync succeeds (CONFLICTS.md is removed)"
    - "Partial resolution is supported — resolving one conflict at a time, CONFLICTS.md updated after each"
    - "gsd resolve-conflict with no args lists current conflicts from CONFLICTS.md"
  artifacts:
    - path: "src/resources/extensions/gsd/workflow-reconcile.ts"
      provides: "resolveConflict(), listConflicts(), removeConflictsFile() functions"
      exports: ["resolveConflict", "listConflicts", "removeConflictsFile"]
    - path: "src/resources/extensions/gsd/engine/resolve-conflict.test.ts"
      provides: "Unit tests for conflict resolution"
      min_lines: 60
  key_links:
    - from: "src/resources/extensions/gsd/commands/handlers/ops.ts"
      to: "src/resources/extensions/gsd/workflow-reconcile.ts"
      via: "dynamic import of resolveConflict/listConflicts for gsd resolve-conflict CLI"
      pattern: "resolve-conflict|resolveConflict"
    - from: "src/resources/extensions/gsd/workflow-reconcile.ts"
      to: "src/resources/extensions/gsd/workflow-events.ts"
      via: "replay resolved events via engine after conflict resolution"
      pattern: "replayAll|appendEvent"
---

<objective>
Implement `gsd resolve-conflict` CLI command (D-06). User picks winners per conflicting entity, command replays the resolved event set through the engine, removes CONFLICTS.md when all conflicts are resolved. This completes the conflict resolution UX for the event-based reconciliation built in plan 3-01.

Purpose: Enable human resolution of merge conflicts detected during worktree sync (SYNC-05).
Output: resolveConflict/listConflicts functions in workflow-reconcile.ts, CLI handler in ops.ts, resolve-conflict.test.ts.
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

From src/resources/extensions/gsd/workflow-reconcile.ts (created in plan 3-01):
```typescript
export interface ConflictEntry {
  entityType: string;
  entityId: string;
  mainSideEvents: WorkflowEvent[];
  worktreeSideEvents: WorkflowEvent[];
}

export interface ReconcileResult {
  autoMerged: number;
  conflicts: ConflictEntry[];
}

export function reconcileWorktreeLogs(mainBasePath: string, worktreeBasePath: string): ReconcileResult;
export function writeConflictsFile(basePath: string, conflicts: ConflictEntry[], worktreePath: string): void;
export function detectConflicts(mainDiverged: WorkflowEvent[], wtDiverged: WorkflowEvent[]): ConflictEntry[];
export function extractEntityKey(event: WorkflowEvent): { type: string; id: string } | null;
```

The CONFLICTS.md file format (written by writeConflictsFile):
```
# Merge Conflicts — {ISO date}

Conflicts detected merging worktree `{worktreePath}` into `{basePath}`.
Run `gsd resolve-conflict` to resolve each conflict.

## Conflict N: {entityType} {entityId}

**Main side events:**
- {cmd} at {ts} (hash: {hash})
  params: {JSON.stringify(params)}

**Worktree side events:**
- {cmd} at {ts} (hash: {hash})
  params: {JSON.stringify(params)}

**Resolve with:** `gsd resolve-conflict --entity {entityType}:{entityId} --pick [main|worktree]`
```

From src/resources/extensions/gsd/workflow-engine.ts:
```typescript
export function getEngine(basePath: string): WorkflowEngine;
// engine.replayAll(events) — replays events through the engine
```

From src/resources/extensions/gsd/workflow-events.ts:
```typescript
export function readEvents(logPath: string): WorkflowEvent[];
export function appendEvent(basePath: string, event: Omit<WorkflowEvent, "hash">): void;
```

From src/resources/extensions/gsd/atomic-write.ts:
```typescript
export function atomicWriteSync(filePath: string, content: string): void;
```

CLI handler pattern from ops.ts:
```typescript
if (trimmed === "migrate" || trimmed.startsWith("migrate ")) {
    const { handleMigrate } = await import("../../migrate/command.js");
    await handleMigrate(...);
    return true;
}
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: TDD conflict resolution functions — tests first, then implementation</name>
  <files>src/resources/extensions/gsd/workflow-reconcile.ts, src/resources/extensions/gsd/engine/resolve-conflict.test.ts</files>
  <read_first>
    src/resources/extensions/gsd/workflow-reconcile.ts (existing module from plan 3-01 — adding functions here)
    src/resources/extensions/gsd/workflow-engine.ts (getEngine, replayAll)
    src/resources/extensions/gsd/workflow-events.ts (readEvents, appendEvent)
    src/resources/extensions/gsd/atomic-write.ts (atomicWriteSync)
    src/resources/extensions/gsd/engine/reconcile.test.ts (test pattern reference)
  </read_first>
  <behavior>
    - Test 1: listConflicts returns parsed ConflictEntry[] from CONFLICTS.md
    - Test 2: listConflicts returns empty array when no CONFLICTS.md exists
    - Test 3: resolveConflict with pick="main" replays main side events for the entity, discards worktree side
    - Test 4: resolveConflict with pick="worktree" replays worktree side events, discards main side
    - Test 5: resolveConflict updates CONFLICTS.md removing the resolved entry
    - Test 6: resolveConflict removes CONFLICTS.md entirely when last conflict is resolved
    - Test 7: resolveConflict throws when entity not found in CONFLICTS.md
    - Test 8: After resolving all conflicts, the event log contains the resolved events appended
  </behavior>
  <action>
RED phase:
Create `src/resources/extensions/gsd/engine/resolve-conflict.test.ts` with 8 test cases. Setup:
- Create temp dir with `.gsd/` directory containing event-log.jsonl and CONFLICTS.md
- Write CONFLICTS.md using `writeConflictsFile()` from the existing workflow-reconcile.ts
- Seed the DB with engine tables (openDatabase, initSchema, migrateSchema)
- Import `resolveConflict`, `listConflicts` from `../workflow-reconcile.ts`
- Tests MUST fail (functions don't exist yet)

GREEN phase:
Add to the BOTTOM of `src/resources/extensions/gsd/workflow-reconcile.ts`:

```typescript
// ─── Conflict Resolution (D-06) ─────────────────────────────────────────

/**
 * Parse CONFLICTS.md and return structured conflict entries.
 */
export function listConflicts(basePath: string): ConflictEntry[] {
  const conflictsPath = join(basePath, ".gsd", "CONFLICTS.md");
  if (!existsSync(conflictsPath)) return [];

  const content = readFileSync(conflictsPath, "utf-8");
  // Parse the structured CONFLICTS.md format back into ConflictEntry[]
  // Each "## Conflict N:" section maps to one ConflictEntry
  // Parse entityType:entityId from the heading
  // Parse main/worktree events from the JSON params blocks
  // ... (implement parser)
}

/**
 * Resolve a single conflict by picking one side's events.
 * Replays the picked events through the engine, updates/removes CONFLICTS.md.
 */
export function resolveConflict(
  basePath: string,
  entityKey: string,  // e.g. "task:T01"
  pick: "main" | "worktree",
): void {
  const conflicts = listConflicts(basePath);
  const [entityType, entityId] = entityKey.split(":");
  const idx = conflicts.findIndex(c => c.entityType === entityType && c.entityId === entityId);
  if (idx === -1) throw new Error(`No conflict found for entity ${entityKey}`);

  const conflict = conflicts[idx];
  const eventsToReplay = pick === "main" ? conflict.mainSideEvents : conflict.worktreeSideEvents;

  // Replay resolved events through engine
  const engine = getEngine(basePath);
  engine.replayAll(eventsToReplay);

  // Append resolved events to event log
  for (const event of eventsToReplay) {
    appendEvent(basePath, { cmd: event.cmd, params: event.params, ts: event.ts, actor: event.actor });
  }

  // Remove resolved conflict from list
  conflicts.splice(idx, 1);

  // Update or remove CONFLICTS.md
  if (conflicts.length === 0) {
    removeConflictsFile(basePath);
  } else {
    // Re-write CONFLICTS.md with remaining conflicts
    writeConflictsFile(basePath, conflicts, "");
  }
}

/**
 * Remove CONFLICTS.md — called when all conflicts are resolved.
 */
export function removeConflictsFile(basePath: string): void {
  const conflictsPath = join(basePath, ".gsd", "CONFLICTS.md");
  if (existsSync(conflictsPath)) {
    unlinkSync(conflictsPath);
  }
}
```

Add necessary imports: `existsSync`, `readFileSync`, `unlinkSync` from `node:fs`, `getEngine` from `./workflow-engine.js`, `appendEvent` from `./workflow-events.js`.

Run tests — all 8 must pass.
  </action>
  <verify>
    <automated>node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/engine/resolve-conflict.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - src/resources/extensions/gsd/workflow-reconcile.ts contains `export function resolveConflict(`
    - src/resources/extensions/gsd/workflow-reconcile.ts contains `export function listConflicts(`
    - src/resources/extensions/gsd/workflow-reconcile.ts contains `export function removeConflictsFile(`
    - src/resources/extensions/gsd/workflow-reconcile.ts contains `unlinkSync`
    - src/resources/extensions/gsd/engine/resolve-conflict.test.ts exits 0 with all tests passing
  </acceptance_criteria>
  <done>resolveConflict picks winner per entity, replays events, updates/removes CONFLICTS.md. listConflicts parses CONFLICTS.md. removeConflictsFile cleans up. All 8 tests pass.</done>
</task>

<task type="auto">
  <name>Task 2: Register `gsd resolve-conflict` CLI command</name>
  <files>src/resources/extensions/gsd/commands/handlers/ops.ts, src/resources/extensions/gsd/commands/handlers/core.ts, src/resources/extensions/gsd/commands/catalog.ts</files>
  <read_first>
    src/resources/extensions/gsd/commands/handlers/ops.ts (existing command patterns)
    src/resources/extensions/gsd/commands/handlers/core.ts (help text)
    src/resources/extensions/gsd/commands/catalog.ts (command catalog)
  </read_first>
  <action>
**ops.ts — add handler for resolve-conflict:**

Add a new handler block in ops.ts (near the existing migrate handler):
```typescript
if (trimmed === "resolve-conflict" || trimmed.startsWith("resolve-conflict ")) {
    const args = trimmed.replace(/^resolve-conflict\s*/, "").trim();
    try {
      const { listConflicts, resolveConflict } = await import("../../workflow-reconcile.js");

      // No args: list current conflicts
      if (!args) {
        const conflicts = listConflicts(process.cwd());
        if (conflicts.length === 0) {
          ctx.ui.notify("No merge conflicts found.", "info");
        } else {
          const lines = conflicts.map((c, i) =>
            `${i + 1}. ${c.entityType}:${c.entityId} — ${c.mainSideEvents.length} main event(s), ${c.worktreeSideEvents.length} worktree event(s)`
          );
          ctx.ui.notify(
            `${conflicts.length} conflict(s):\n${lines.join("\n")}\n\nResolve with: /gsd resolve-conflict --entity {type}:{id} --pick [main|worktree]`,
            "info",
          );
        }
        return true;
      }

      // Parse --entity and --pick flags
      const entityMatch = args.match(/--entity\s+(\S+)/);
      const pickMatch = args.match(/--pick\s+(main|worktree)/);

      if (!entityMatch || !pickMatch) {
        ctx.ui.notify(
          "Usage: /gsd resolve-conflict --entity {type}:{id} --pick [main|worktree]\n" +
          "  Example: /gsd resolve-conflict --entity task:T01 --pick main\n" +
          "  Run without args to list current conflicts.",
          "error",
        );
        return true;
      }

      resolveConflict(process.cwd(), entityMatch[1], pickMatch[1] as "main" | "worktree");
      ctx.ui.notify(`Resolved conflict for ${entityMatch[1]} — picked ${pickMatch[1]} side.`, "info");

      // Check remaining conflicts
      const remaining = listConflicts(process.cwd());
      if (remaining.length === 0) {
        ctx.ui.notify("All conflicts resolved. Re-run sync to complete the merge.", "info");
      } else {
        ctx.ui.notify(`${remaining.length} conflict(s) remaining.`, "info");
      }
    } catch (err) {
      ctx.ui.notify(`resolve-conflict failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return true;
}
```

**core.ts — add help text:**

Add after the migrate line:
```
"  /gsd resolve-conflict  Resolve worktree merge conflicts  [--entity TYPE:ID --pick main|worktree]",
```

**catalog.ts — add to TOP_LEVEL_SUBCOMMANDS:**

Add entry:
```typescript
{ cmd: "resolve-conflict", desc: "Resolve worktree merge conflicts" },
```

Also add "resolve-conflict" to the GSD_COMMAND_DESCRIPTION string (the pipe-separated list).
  </action>
  <verify>
    <automated>grep -n "resolve-conflict" src/resources/extensions/gsd/commands/handlers/ops.ts src/resources/extensions/gsd/commands/handlers/core.ts src/resources/extensions/gsd/commands/catalog.ts</automated>
  </verify>
  <acceptance_criteria>
    - src/resources/extensions/gsd/commands/handlers/ops.ts contains `resolve-conflict`
    - src/resources/extensions/gsd/commands/handlers/ops.ts contains `resolveConflict(`
    - src/resources/extensions/gsd/commands/handlers/ops.ts contains `listConflicts(`
    - src/resources/extensions/gsd/commands/handlers/core.ts contains `resolve-conflict`
    - src/resources/extensions/gsd/commands/catalog.ts contains `resolve-conflict`
  </acceptance_criteria>
  <done>`gsd resolve-conflict` CLI command registered. No args lists conflicts, --entity + --pick resolves one. CONFLICTS.md removed when all resolved. Help text and catalog updated.</done>
</task>

</tasks>

<verification>
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/engine/resolve-conflict.test.ts` — all 8 resolve-conflict tests pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/engine/*.test.ts` — all engine tests pass
- `grep "resolve-conflict" src/resources/extensions/gsd/commands/handlers/ops.ts` — returns match
- `grep "resolve-conflict" src/resources/extensions/gsd/commands/catalog.ts` — returns match
</verification>

<success_criteria>
`gsd resolve-conflict` CLI command enables human resolution of merge conflicts. Users can list conflicts, pick winners per entity, and CONFLICTS.md is removed when all resolved. All tests pass.
</success_criteria>

<output>
After completion, create `.planning/phases/03-event-reconciliation-mandatory-tools/3-05-SUMMARY.md`
</output>
