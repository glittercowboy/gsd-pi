---
phase: 04-remove-parsing-from-hot-path
plan: 01
type: execute
wave: 2
depends_on: [4-00]
files_modified:
  - src/resources/extensions/gsd/legacy/parsers.ts
  - src/resources/extensions/gsd/files.ts
  - src/resources/extensions/gsd/auto-dashboard.ts
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/parallel-eligibility.ts
  - src/resources/extensions/gsd/visualizer-data.ts
  - src/resources/extensions/gsd/workflow-migration.ts
  - src/resources/extensions/gsd/guided-flow.ts
  - src/resources/extensions/gsd/auto-direct-dispatch.ts
  - src/resources/extensions/gsd/dashboard-overlay.ts
  - src/resources/extensions/gsd/workspace-index.ts
  - src/resources/extensions/gsd/auto-post-unit.ts
  - src/resources/extensions/gsd/auto-verification.ts
  - src/resources/extensions/gsd/reactive-graph.ts
  - src/resources/extensions/gsd/bootstrap/system-context.ts
autonomous: true
requirements: [CLN-07]

must_haves:
  truths:
    - "parseRoadmap, parsePlan, parseSummary are exported from legacy/parsers.ts"
    - "files.ts no longer exports parseRoadmap, parsePlan, or parseSummary"
    - "All display callers import from legacy/parsers.ts, not files.ts"
    - "Hot-path callers (doctor-checks.ts, auto-recovery.ts, state.ts) do NOT import parseRoadmap/parsePlan/parseSummary from any module"
    - "workflow-migration.ts imports parse functions from legacy/parsers.ts (explicitly permitted per D-13)"
  artifacts:
    - path: "src/resources/extensions/gsd/legacy/parsers.ts"
      provides: "Relocated markdown parsers with boundary comment header"
      contains: "HOT-PATH CODE MUST NOT IMPORT FROM THIS MODULE"
  key_links:
    - from: "src/resources/extensions/gsd/auto-dashboard.ts"
      to: "src/resources/extensions/gsd/legacy/parsers.ts"
      via: "import { parseRoadmap, parsePlan }"
      pattern: 'from "./legacy/parsers.js"'
    - from: "src/resources/extensions/gsd/visualizer-data.ts"
      to: "src/resources/extensions/gsd/legacy/parsers.ts"
      via: "import { parseRoadmap, parsePlan, parseSummary }"
      pattern: 'from "./legacy/parsers.js"'
    - from: "src/resources/extensions/gsd/workflow-migration.ts"
      to: "src/resources/extensions/gsd/legacy/parsers.ts"
      via: "import { parseRoadmap, parsePlan, parseSummary }"
      pattern: 'from "./legacy/parsers.js"'
---

<objective>
Relocate markdown parsers (parseRoadmap, parsePlan, parseSummary) from files.ts to a new legacy/parsers.ts module. Update all display-only callers to import from the new location. Remove parse function exports from files.ts entirely (no re-exports) so TypeScript catches any hot-path callers still referencing them.

Purpose: Establishes the import boundary between hot-path code (engine queries) and display-only code (markdown parsing). This is the foundation that makes the doctor/recovery surgery in plans 02-03 clean.
Output: New legacy/parsers.ts file, updated imports across ~13 files, files.ts stripped of parse function definitions.
</objective>

<execution_context>
@/Users/jeremymcspadden/.claude/get-shit-done/workflows/execute-plan.md
@/Users/jeremymcspadden/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/04-remove-parsing-from-hot-path/4-CONTEXT.md
@.planning/phases/04-remove-parsing-from-hot-path/4-RESEARCH.md

<interfaces>
<!-- Key exports from files.ts that will be relocated -->
From src/resources/extensions/gsd/files.ts:
- parseRoadmap(content: string) — line 122, returns { title, slices[], description, ... }
- parsePlan(content: string) — line 317, returns { tasks[], filesLikelyTouched[], ... }
- parseSummary(content: string) — line 444, returns { title, status, summary, ... }

These three functions and their supporting helpers (any non-exported helper functions they call that are NOT shared with other functions in files.ts) move to legacy/parsers.ts.

Functions that STAY in files.ts (general-purpose utilities per D-11):
- loadFile(), extractSection(), extractBoldField(), parseBullets()
- parseTaskPlanIO(), parseTaskPlanMustHaves(), countMustHavesMentionedInSummary()
- parseContinue(), clearParseCache()
- All save/resolve functions

From src/resources/extensions/gsd/workflow-engine.ts:
- class WorkflowEngine { getMilestone(), getMilestones(), getSlice(), getSlices(), getTask(), getTasks(), deriveState() }
- export function getEngine(basePath): WorkflowEngine
- export function isEngineAvailable(basePath): boolean

From src/resources/extensions/gsd/workflow-migration.ts (confirmed imports):
- import { parseRoadmap, parsePlan, parseSummary } from "./files.js" (line 9)
- parseRoadmap() called at lines 134, 324
- parsePlan() called at lines 182, 332
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create legacy/parsers.ts and relocate parse functions from files.ts</name>
  <files>
    src/resources/extensions/gsd/legacy/parsers.ts
    src/resources/extensions/gsd/files.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/files.ts
  </read_first>
  <action>
1. Create directory `src/resources/extensions/gsd/legacy/` if it doesn't exist.

2. Create `src/resources/extensions/gsd/legacy/parsers.ts` with:
   - Copyright header: `// GSD Extension — Legacy Markdown Parsers` + `// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>`
   - Boundary comment block (exact text from D-14 in RESEARCH.md Pattern 5):
     ```
     /**
      * BOUNDARY: These parsers are for display-only callers and `gsd migrate`.
      * HOT-PATH CODE MUST NOT IMPORT FROM THIS MODULE.
      *
      * Permitted callers:
      *   - auto-dashboard.ts, visualizer-data.ts, parallel-eligibility.ts
      *   - auto-worktree.ts, guided-flow.ts, auto-direct-dispatch.ts
      *   - dashboard-overlay.ts, workspace-index.ts, auto-post-unit.ts
      *   - auto-verification.ts, reactive-graph.ts, bootstrap/system-context.ts
      *   - workflow-migration.ts (gsd migrate)
      *
      * Forbidden callers (use WorkflowEngine queries instead):
      *   - doctor-checks.ts, doctor.ts, doctor-proactive.ts
      *   - auto-recovery.ts, state.ts
      *   - Any dispatch or state-derivation path
      */
     ```
   - Move `parseRoadmap()` (files.ts line ~122-207), `parsePlan()` (line ~317-443), `parseSummary()` (line ~444-541) and any private helper functions they depend on that are NOT used by other functions remaining in files.ts.
   - Import any shared types or utilities these functions need from `../files.js` (e.g., `extractSection`, `extractBoldField`, `parseBullets` if used).
   - Export all three parse functions.

3. In `files.ts`:
   - Remove the parseRoadmap, parsePlan, parseSummary function bodies entirely (no re-exports — per Pitfall 4 in RESEARCH.md).
   - Keep all other exports: loadFile, extractSection, extractBoldField, parseBullets, parseTaskPlanIO, parseTaskPlanMustHaves, countMustHavesMentionedInSummary, parseContinue, clearParseCache, saveFile, and all resolve/path functions.
   - Keep any helper functions that are shared with remaining functions.

Run `npx tsc --noEmit` after this task to confirm the file compiles (callers will show errors — that's expected and fixed in Task 2).
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -50</automated>
  </verify>
  <acceptance_criteria>
    - File `src/resources/extensions/gsd/legacy/parsers.ts` exists
    - `legacy/parsers.ts` contains `export function parseRoadmap(`
    - `legacy/parsers.ts` contains `export function parsePlan(`
    - `legacy/parsers.ts` contains `export function parseSummary(`
    - `legacy/parsers.ts` contains `HOT-PATH CODE MUST NOT IMPORT FROM THIS MODULE`
    - `legacy/parsers.ts` contains `Copyright (c) 2026 Jeremy McSpadden`
    - `files.ts` does NOT contain `export function parseRoadmap(`
    - `files.ts` does NOT contain `export function parsePlan(`
    - `files.ts` does NOT contain `export function parseSummary(`
    - `files.ts` does NOT contain `from "./legacy/parsers` (no re-exports)
  </acceptance_criteria>
  <done>parseRoadmap, parsePlan, parseSummary live exclusively in legacy/parsers.ts. files.ts no longer exports them. TypeScript may show import errors in callers — that's expected and fixed in Task 2.</done>
</task>

<task type="auto">
  <name>Task 2: Update all display callers to import from legacy/parsers.ts</name>
  <files>
    src/resources/extensions/gsd/auto-dashboard.ts
    src/resources/extensions/gsd/auto-worktree.ts
    src/resources/extensions/gsd/parallel-eligibility.ts
    src/resources/extensions/gsd/visualizer-data.ts
    src/resources/extensions/gsd/workflow-migration.ts
    src/resources/extensions/gsd/guided-flow.ts
    src/resources/extensions/gsd/auto-direct-dispatch.ts
    src/resources/extensions/gsd/dashboard-overlay.ts
    src/resources/extensions/gsd/workspace-index.ts
    src/resources/extensions/gsd/auto-post-unit.ts
    src/resources/extensions/gsd/auto-verification.ts
    src/resources/extensions/gsd/reactive-graph.ts
    src/resources/extensions/gsd/bootstrap/system-context.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/auto-dashboard.ts
    src/resources/extensions/gsd/auto-worktree.ts
    src/resources/extensions/gsd/parallel-eligibility.ts
    src/resources/extensions/gsd/visualizer-data.ts
    src/resources/extensions/gsd/workflow-migration.ts
    src/resources/extensions/gsd/guided-flow.ts
    src/resources/extensions/gsd/auto-direct-dispatch.ts
    src/resources/extensions/gsd/dashboard-overlay.ts
    src/resources/extensions/gsd/workspace-index.ts
    src/resources/extensions/gsd/auto-post-unit.ts
    src/resources/extensions/gsd/auto-verification.ts
    src/resources/extensions/gsd/reactive-graph.ts
    src/resources/extensions/gsd/bootstrap/system-context.ts
  </read_first>
  <action>
For each file, change the import of parseRoadmap/parsePlan/parseSummary from `"./files.js"` to `"./legacy/parsers.js"` (or `"../legacy/parsers.js"` for bootstrap/system-context.ts). Keep any other imports from `"./files.js"` (loadFile, extractSection, etc.) on the original import line.

**IMPORTANT: Run `npx tsc --noEmit` after every 4-5 file changes to catch errors early.** This plan touches 15 files — batch carefully. If tsc reports errors, fix them before continuing to the next batch.

Specific changes by file (each file has a parseRoadmap/parsePlan/parseSummary import to update):

1. **auto-dashboard.ts** (line 18): `import { parseRoadmap, parsePlan } from "./files.js"` → split: keep `loadFile` etc. from `"./files.js"`, add `import { parseRoadmap, parsePlan } from "./legacy/parsers.js"`
2. **auto-worktree.ts** (line 44): `import { parseRoadmap } from "./files.js"` → `import { parseRoadmap } from "./legacy/parsers.js"`
3. **parallel-eligibility.ts** (line 9): `import { parseRoadmap, parsePlan, loadFile } from "./files.js"` → split: `import { loadFile } from "./files.js"` + `import { parseRoadmap, parsePlan } from "./legacy/parsers.js"`
4. **visualizer-data.ts** (line 6): `import { parseRoadmap, parsePlan, parseSummary, loadFile } from './files.js'` → split: `import { loadFile } from './files.js'` + `import { parseRoadmap, parsePlan, parseSummary } from './legacy/parsers.js'`
5. **workflow-migration.ts** (line 9): `import { parseRoadmap, parsePlan, parseSummary } from "./files.js"` → `import { parseRoadmap, parsePlan, parseSummary } from "./legacy/parsers.js"`. Keep any other imports from `"./files.js"` on a separate line. workflow-migration.ts is the `gsd migrate` entry point — it is explicitly permitted to use legacy parsers per D-13.
6. **guided-flow.ts** (line 11): `import { loadFile, parseRoadmap } from "./files.js"` → split: `import { loadFile } from "./files.js"` + `import { parseRoadmap } from "./legacy/parsers.js"`
7. **auto-direct-dispatch.ts** (line 12): `import { loadFile, parseRoadmap } from "./files.js"` → split: `import { loadFile } from "./files.js"` + `import { parseRoadmap } from "./legacy/parsers.js"`
8. **dashboard-overlay.ts** (line 12): `import { loadFile, parseRoadmap, parsePlan } from "./files.js"` → split: `import { loadFile } from "./files.js"` + `import { parseRoadmap, parsePlan } from "./legacy/parsers.js"`
9. **workspace-index.ts** (line 3): `import { loadFile, parsePlan, parseRoadmap } from "./files.js"` → split: `import { loadFile } from "./files.js"` + `import { parseRoadmap, parsePlan } from "./legacy/parsers.js"`
10. **auto-post-unit.ts** (line 16): `import { loadFile, parseSummary, resolveAllOverrides } from "./files.js"` → split: `import { loadFile, resolveAllOverrides } from "./files.js"` + `import { parseSummary } from "./legacy/parsers.js"`
11. **auto-verification.ts** (line 14): `import { loadFile, parsePlan } from "./files.js"` → split: `import { loadFile } from "./files.js"` + `import { parsePlan } from "./legacy/parsers.js"`
12. **reactive-graph.ts** (line 13): `import { loadFile, parsePlan, parseTaskPlanIO } from "./files.js"` → split: `import { loadFile, parseTaskPlanIO } from "./files.js"` + `import { parsePlan } from "./legacy/parsers.js"`
13. **bootstrap/system-context.ts** (line 15): `import { formatOverridesSection, loadActiveOverrides, loadFile, parseContinue, parseSummary } from "../files.js"` → split: `import { formatOverridesSection, loadActiveOverrides, loadFile, parseContinue } from "../files.js"` + `import { parseSummary } from "../legacy/parsers.js"`

Also handle doctor-checks.ts and doctor.ts — these files currently import parseRoadmap/parsePlan/parseSummary from files.js. For NOW (in this task), simply remove the parse function names from their import lines. They will get engine query replacements in Plan 02. If removing the import causes unused-variable errors, that's fine — Plan 02 will add engine imports.

Files to strip parse imports from (hot-path — do NOT redirect to legacy/parsers.ts):
- **doctor-checks.ts** (line 6): Remove `parseRoadmap` from `import { loadFile, parseRoadmap } from "./files.js"` → `import { loadFile } from "./files.js"`
- **doctor.ts** (line 4): Remove `parsePlan, parseRoadmap, parseSummary` from the import line, keep remaining imports
- **auto-recovery.ts** (line ~14): Remove `parseRoadmap, parsePlan` from imports — keep remaining imports from files.js
- **state.ts** (lines 15-17): Remove `parseRoadmap, parsePlan, parseSummary` from imports

Note: Removing these imports will cause TypeScript errors at usage sites (doctor-checks.ts lines 57, 104; doctor.ts lines 377, 632, 751; auto-recovery.ts lines 361, 396, 691; state.ts lines 152, 326, 337, 376, 730, 822). These will be resolved in Plans 02 and 03 where the call sites are replaced with engine queries. For THIS plan, comment out the usage lines with `// TODO(phase-4-plan-02): replace with engine query` to keep TypeScript compiling.
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -30 && npm run test:unit -- --test-name-pattern "import-boundary" 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - `auto-dashboard.ts` contains `from "./legacy/parsers.js"`
    - `auto-worktree.ts` contains `from "./legacy/parsers.js"`
    - `parallel-eligibility.ts` contains `from "./legacy/parsers.js"`
    - `visualizer-data.ts` contains `from "./legacy/parsers.js"`
    - `workflow-migration.ts` contains `from "./legacy/parsers.js"` (line 9 updated)
    - `guided-flow.ts` contains `from "./legacy/parsers.js"`
    - `auto-direct-dispatch.ts` contains `from "./legacy/parsers.js"`
    - `dashboard-overlay.ts` contains `from "./legacy/parsers.js"`
    - `workspace-index.ts` contains `from "./legacy/parsers.js"`
    - `auto-post-unit.ts` contains `from "./legacy/parsers.js"`
    - `auto-verification.ts` contains `from "./legacy/parsers.js"`
    - `reactive-graph.ts` contains `from "./legacy/parsers.js"`
    - `bootstrap/system-context.ts` contains `from "../legacy/parsers.js"`
    - `doctor-checks.ts` does NOT contain `parseRoadmap` in any import line
    - `doctor.ts` does NOT contain `parseRoadmap` or `parsePlan` or `parseSummary` in any import line
    - `auto-recovery.ts` does NOT contain `parseRoadmap` or `parsePlan` in any import from files.js
    - `state.ts` does NOT contain `parseRoadmap` or `parsePlan` or `parseSummary` in any import from files.js
    - TypeScript compiles without errors (`npx tsc --noEmit` exits 0)
    - import-boundary tests pass (`npm run test:unit -- --test-name-pattern "import-boundary"`)
  </acceptance_criteria>
  <done>All display callers (including workflow-migration.ts) import from legacy/parsers.ts. All hot-path callers have parse imports removed. TypeScript compiles clean. Parse usage sites in hot-path files are commented out with TODO markers for Plans 02-03.</done>
</task>

</tasks>

<verification>
- `npx tsc --noEmit` passes (zero errors)
- `npm run test:unit` passes (all existing tests green)
- `npm run test:unit -- --test-name-pattern "import-boundary"` passes (boundary enforcement tests green)
- `grep -rn 'from "./files.js"' src/resources/extensions/gsd/*.ts | grep -E 'parseRoadmap|parsePlan|parseSummary'` returns empty (no display callers still importing parsers from files.js)
- `grep -rn 'parseRoadmap\|parsePlan\|parseSummary' src/resources/extensions/gsd/legacy/parsers.ts | grep 'export function'` returns 3 lines (all three exported)
</verification>

<success_criteria>
- legacy/parsers.ts exists with all three parse functions and the boundary comment header
- files.ts no longer exports parseRoadmap, parsePlan, or parseSummary
- All 13 display callers (including workflow-migration.ts) import from legacy/parsers.ts
- Hot-path files (doctor-checks, doctor, auto-recovery, state) have no parse function imports
- TypeScript compiles and tests pass
</success_criteria>

<output>
After completion, create `.planning/phases/04-remove-parsing-from-hot-path/4-01-SUMMARY.md`
</output>
