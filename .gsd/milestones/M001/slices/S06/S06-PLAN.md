# S06: Structured LLM Tools + /gsd inspect

**Goal:** LLM writes decisions/requirements/summaries via lightweight tool calls that write to DB and trigger markdown dual-write. `/gsd inspect` dumps DB state for debugging.
**Demo:** Call `gsd_save_decision` tool → new row in DB + DECISIONS.md regenerated. Call `/gsd inspect` → table counts and recent entries displayed.

## Must-Haves

- `gsd_save_decision` tool writes a new decision to DB and regenerates DECISIONS.md
- `gsd_update_requirement` tool updates a requirement in DB and regenerates REQUIREMENTS.md
- `gsd_save_summary` tool writes an artifact to DB and to the corresponding markdown file path
- `/gsd inspect` slash command shows schema version, table counts, and recent entries
- All DB writes use dynamic imports with try/catch (D014 pattern)
- Decision IDs auto-assigned (next D-number from DB state)
- Generated markdown round-trips cleanly through existing parsers

## Proof Level

- This slice proves: contract + integration
- Real runtime required: no (DB layer + tool execute functions testable with in-memory DB)
- Human/UAT required: no

## Verification

- `npm run test:unit -- --test-name-pattern "db-writer"` — round-trip fidelity tests for markdown generators
- `npm run test:unit -- --test-name-pattern "gsd-tools"` — structured LLM tool tests
- `npm run test:unit -- --test-name-pattern "gsd-inspect"` — inspect command output tests
- `npm run test:unit` — full suite passes with no regressions
- `npx tsc --noEmit` — clean compilation

## Observability / Diagnostics

- Runtime signals: stderr log `gsd-db:` prefix on any tool write failure; tool results include structured details with operation and counts
- Inspection surfaces: `/gsd inspect` dumps table counts, schema version, recent decisions/requirements
- Failure visibility: tool execute returns `isError: true` with descriptive message when DB unavailable or inputs invalid
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `gsd-db.ts` (upsertDecision, upsertRequirement, insertArtifact, getActiveDecisions, getActiveRequirements, isDbAvailable, _getAdapter), `context-store.ts` (queryDecisions, queryRequirements), `md-importer.ts` (parseDecisionsTable, parseRequirementsSections for round-trip verification), `paths.ts` (resolveGsdRootFile, gsdRoot), `files.ts` (saveFile)
- New wiring introduced in this slice: 3 tools registered via `pi.registerTool()` in index.ts; `inspect` subcommand in commands.ts
- What remains before the milestone is truly usable end-to-end: S07 integration verification + polish

## Tasks

- [x] **T01: Markdown generators + DB-first write helpers** `est:45m`
  - Why: The DB→markdown direction is missing. S03 writes markdown first then re-imports to DB. S06 tools need to write DB first then regenerate markdown files. This task creates the generators for DECISIONS.md and REQUIREMENTS.md from DB state, plus a helper to write an artifact to DB + disk. Round-trip fidelity is the critical risk.
  - Files: `src/resources/extensions/gsd/db-writer.ts`, `src/resources/extensions/gsd/tests/db-writer.test.ts`
  - Do: Create `db-writer.ts` with: (1) `generateDecisionsMd(decisions)` — takes Decision[] and produces full DECISIONS.md content with header, comment block, table header, separator, and data rows; (2) `generateRequirementsMd(requirements)` — takes Requirement[] grouped by status into Active/Validated/Deferred/Out of Scope sections with ### headings and bullet fields; (3) `nextDecisionId()` — queries DB for MAX id and returns next D-number; (4) `saveDecisionToDb(fields)` — upserts decision to DB, calls `getActiveDecisions()`, regenerates DECISIONS.md via `generateDecisionsMd()`, writes file with `saveFile()`; (5) `updateRequirementInDb(id, updates)` — upserts requirement to DB, calls `getActiveRequirements()`, regenerates REQUIREMENTS.md via `generateRequirementsMd()`, writes file; (6) `saveArtifactToDb(path, type, content, milestoneId?, sliceId?, taskId?)` — inserts artifact to DB and writes markdown file to disk. All dynamic imports of gsd-db.js inside try/catch per D014. Test round-trip: generate → parse → compare for both decisions and requirements.
  - Verify: `npm run test:unit -- --test-name-pattern "db-writer"` — all assertions pass including round-trip fidelity
  - Done when: Generated DECISIONS.md and REQUIREMENTS.md parse back to identical data through `parseDecisionsTable` and `parseRequirementsSections`

- [x] **T02: Register structured LLM tools** `est:30m`
  - Why: This is the core R014 deliverable — 3 tools that let the LLM write structured data directly, eliminating the markdown-then-parse roundtrip.
  - Files: `src/resources/extensions/gsd/index.ts`, `src/resources/extensions/gsd/tests/gsd-tools.test.ts`
  - Do: In `index.ts`, register 3 tools via `pi.registerTool()` following the google-search pattern: (1) `gsd_save_decision` — params: scope (string), decision (string), choice (string), rationale (string), revisable (Optional string, default "Yes"), when_context (Optional string, defaults to active milestone). Execute: dynamic import db-writer.js → call `saveDecisionToDb()` → return success with new ID. (2) `gsd_update_requirement` — params: id (string, required), status (Optional string), validation (Optional string), notes (Optional string). Execute: dynamic import gsd-db.js → get existing requirement → merge updates → call `updateRequirementInDb()` → return success. (3) `gsd_save_summary` — params: milestone_id (string), slice_id (Optional string), task_id (Optional string), artifact_type (string enum: SUMMARY/RESEARCH/CONTEXT/ASSESSMENT), content (string). Execute: compute file path from IDs → call `saveArtifactToDb()` → return success. All tools check `isDbAvailable()` first and return clear error if DB not open. TypeBox schemas for all params. Tests: verify execute functions with in-memory DB.
  - Verify: `npm run test:unit -- --test-name-pattern "gsd-tools"` — all assertions pass
  - Done when: All 3 tools register, execute with valid params, produce correct DB state and return structured results

- [ ] **T03: /gsd inspect slash command** `est:20m`
  - Why: R015 deliverable — debugging visibility into DB state. Without this, there's no way to verify DB contents from within pi.
  - Files: `src/resources/extensions/gsd/commands.ts`, `src/resources/extensions/gsd/tests/gsd-inspect.test.ts`
  - Do: (1) Add `"inspect"` to the autocomplete array in commands.ts. (2) Add `if (trimmed === "inspect")` branch in the handler that: dynamically imports gsd-db.js and context-store.js, checks `isDbAvailable()` (show "No DB available" notification if false), queries schema_version table for version, counts rows in decisions/requirements/artifacts tables via `SELECT count(*)`, fetches 5 most recent decisions and 5 most recent requirements, formats as multi-line text, calls `ctx.ui.notify(text, "info")`. (3) Update the unknown-command help text to include `inspect`. Test: build the inspect output formatter as a pure function, test with known data.
  - Verify: `npm run test:unit -- --test-name-pattern "gsd-inspect"` — all assertions pass
  - Done when: `/gsd inspect` shows schema version, table counts, and recent entries when DB is available, and shows "No DB available" when it's not

## Files Likely Touched

- `src/resources/extensions/gsd/db-writer.ts` (new)
- `src/resources/extensions/gsd/index.ts`
- `src/resources/extensions/gsd/commands.ts`
- `src/resources/extensions/gsd/tests/db-writer.test.ts` (new)
- `src/resources/extensions/gsd/tests/gsd-tools.test.ts` (new)
- `src/resources/extensions/gsd/tests/gsd-inspect.test.ts` (new)
