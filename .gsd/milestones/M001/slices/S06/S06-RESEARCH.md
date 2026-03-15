# S06: Structured LLM Tools + /gsd inspect — Research

**Date:** 2026-03-15
**Scope:** M001/S06

## Summary

S06 delivers two capabilities: (1) structured LLM tool calls (`gsd_save_decision`, `gsd_update_requirement`, `gsd_save_summary`) that let the LLM write directly to the SQLite DB and trigger markdown dual-write, eliminating the fragile markdown-then-parse roundtrip; and (2) a `/gsd inspect` slash command that dumps DB state for debugging.

The codebase is well-prepared for this. The extension tool registration pattern is established (`pi.registerTool()` with TypeBox schemas), the DB layer (`gsd-db.ts`) has all the upsert wrappers needed, and the dual-write re-import pattern from S03 (`migrateFromMarkdown`) provides the markdown sync mechanism. The main design question is the dual-write direction: S03 writes markdown first then re-imports to DB, but S06 tools should write DB first then regenerate markdown — this requires new markdown generation functions for DECISIONS.md and REQUIREMENTS.md that don't exist yet.

The `/gsd inspect` command is straightforward — add an "inspect" subcommand to the existing `/gsd` command dispatcher in `commands.ts`, dynamically import `gsd-db.ts` and `context-store.ts`, query table counts and recent entries, and display via `ctx.ui.notify()`.

## Recommendation

Implement S06 in three tasks:

1. **Markdown generators + DB-first write functions**: Create functions that regenerate DECISIONS.md and REQUIREMENTS.md from DB state. This is the missing piece for DB→markdown dual-write. Place in a new `db-writer.ts` module or extend `md-importer.ts` with export functions.

2. **Structured LLM tools**: Register 3 tools in `index.ts` via `pi.registerTool()`:
   - `gsd_save_decision` — writes a new decision row to DB, regenerates DECISIONS.md
   - `gsd_update_requirement` — updates a requirement's status/validation/notes in DB, regenerates REQUIREMENTS.md
   - `gsd_save_summary` — writes an artifact (summary, research, etc.) to DB and to the corresponding markdown file path

3. **`/gsd inspect` slash command**: Add `inspect` subcommand in `commands.ts` that dumps schema version, table counts, recent decisions, and recent requirements.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Parameter schema validation | `@sinclair/typebox` `Type.Object()` | Already used by all extension tools; required by `ToolDefinition.parameters` |
| DB upsert operations | `upsertDecision()`, `upsertRequirement()`, `insertArtifact()` in `gsd-db.ts` | Idempotent, handles schema correctly, already tested |
| Decision parsing/import | `parseDecisionsTable()` in `md-importer.ts` | Round-trip tested; use it to verify regenerated markdown |
| Requirement parsing/import | `parseRequirementsSections()` in `md-importer.ts` | Round-trip tested; use for verification |
| File I/O | `saveFile()` in `files.ts` | Atomic write (tmp + rename), creates parent dirs |
| Dynamic imports | `import("./gsd-db.js")` pattern from S03 | Preserves D003 graceful degradation |

## Existing Code and Patterns

- `src/resources/extensions/gsd/index.ts` — Extension entry point where `pi.registerTool()` is called. Currently registers dynamic bash/write/read/edit tools. New tools go here, following the same pattern. ~490 lines.
- `src/resources/extensions/gsd/commands.ts` — `/gsd` command handler with subcommand routing (`handler()` function at line ~105). Add `inspect` branch here matching existing pattern (`if (trimmed === "inspect") { ... }`). Autocomplete array at line ~64 needs `"inspect"` added.
- `src/resources/extensions/gsd/gsd-db.ts` — DB layer with `upsertDecision()`, `upsertRequirement()`, `insertArtifact()`, `isDbAvailable()`, `_getAdapter()`, `getActiveDecisions()`, `getActiveRequirements()`. All wrappers needed for tool writes already exist.
- `src/resources/extensions/gsd/context-store.ts` — Query layer with `queryDecisions()`, `queryRequirements()`, `queryArtifact()`, `formatDecisionsForPrompt()`, `formatRequirementsForPrompt()`. The format functions produce prompt-injectable markdown but NOT full-file markdown. Need separate generators for file regeneration.
- `src/resources/extensions/gsd/md-importer.ts` — `parseDecisionsTable()` and `parseRequirementsSections()` parsers. `migrateFromMarkdown()` orchestrator for full re-import. Useful for testing round-trip fidelity of generated markdown.
- `src/resources/extensions/gsd/paths.ts` — `resolveGsdRootFile(basePath, 'DECISIONS')` returns path to DECISIONS.md. `gsdRoot(basePath)` returns `.gsd/` path.
- `src/resources/extensions/gsd/files.ts` — `saveFile(path, content)` for atomic file writes.
- `src/resources/extensions/gsd/auto.ts` — `isDbAvailable` static import at line ~65. `handleAgentEnd` dual-write re-import at line ~878. DB-aware helpers pattern at lines ~2460–2550.
- `src/resources/extensions/google-search/index.ts` — Reference implementation for `pi.registerTool()` with TypeBox schemas, execute function, and error handling. Good pattern to follow.
- `packages/pi-coding-agent/src/core/extensions/types.ts` — `ToolDefinition` interface (line ~337): `name`, `label`, `description`, `promptSnippet`, `promptGuidelines`, `parameters` (TypeBox), `execute()` returning `AgentToolResult`. `ExtensionContext` provides `cwd`.

## Constraints

- **Dynamic imports required (D014)**: All imports of `gsd-db.js`, `context-store.js`, `md-importer.js` must be dynamic `import()` inside try/catch. Static imports would break graceful degradation when SQLite is unavailable.
- **DB must be open before tool calls work**: `isDbAvailable()` must return true. The DB opens during `startAuto()` (S03 wiring). Tools called outside auto-mode must check and return a clear error.
- **Append-only decisions convention**: DECISIONS.md has a comment "Append-only. Never edit or remove existing rows." The `gsd_save_decision` tool must append, not replace the entire file. However, regenerating from DB is also valid since DB preserves all rows.
- **Decision IDs must be auto-assigned**: The next D-number must be computed from existing decisions in DB (MAX seq + 1 or count + 1 mapped to `D{NNN}` format). The LLM should not guess IDs.
- **Tool results must be `{ content: [{type: "text", text: "..."}], details: ... }`**: The `AgentToolResult` interface requires content blocks, not raw strings.
- **TypeBox `Type.Object()` for parameters**: Must use `@sinclair/typebox` schema definitions, not JSON Schema objects directly.
- **CWD resolution**: The tool's execute function receives `ctx: ExtensionContext` which has `ctx.cwd`. But in the GSD worktree context, `process.cwd()` is the authoritative CWD (see dynamic bash tool pattern in index.ts). Use `process.cwd()` for consistency.

## Common Pitfalls

- **Markdown regeneration must preserve header/comments**: DECISIONS.md has a header (`# Decisions Register`) and an HTML comment block. Regenerating from DB rows alone would lose these. The generator must prepend the static header.
- **Requirement sections must be grouped by status**: REQUIREMENTS.md has `## Active`, `## Validated`, `## Deferred`, `## Out of Scope` sections. Regenerating must group requirements by status into the correct sections. The traceability table and coverage summary at the bottom should also be regenerated.
- **Auto-increment `seq` vs stable `id` for decisions**: `seq` is auto-increment PK. `id` (D001, D002) is a UNIQUE text field. When inserting a new decision via the tool, auto-generate the `id` from the max existing ID + 1. The `seq` is handled by SQLite.
- **Race condition with `handleAgentEnd` re-import**: If a tool writes to DB + markdown, then `handleAgentEnd` calls `migrateFromMarkdown()` which re-imports from markdown — this is fine because `upsertDecision` is idempotent (INSERT OR REPLACE). No data loss risk.
- **Test isolation**: Tests must use `:memory:` DB and not touch the real filesystem. The existing test pattern (`openDatabase(':memory:')`) works. For markdown generation tests, compare strings rather than writing files.

## Open Risks

- **Markdown fidelity of regenerated files**: The generated DECISIONS.md and REQUIREMENTS.md must be parseable by the existing importers (`parseDecisionsTable`, `parseRequirementsSections`). Need round-trip tests: generate → parse → compare.
- **Tool reliability under LLM usage**: The LLM might call tools with malformed inputs (empty fields, wrong scope values). TypeBox validation at the schema layer helps, but edge cases in business logic need defensive handling.
- **`gsd_save_summary` scope**: Summaries are stored as artifacts with specific paths (e.g., `milestones/M001/slices/S01/S01-SUMMARY.md`). The tool needs milestone/slice/task IDs to compute the correct path. This is more complex than decision/requirement tools.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| TypeBox | epicenterhq/epicenter@typebox | available (44 installs) — for schema validation patterns |
| better-sqlite3 | none | none found |
| Node.js testing | none | not needed — project uses custom test helpers |

## Sources

- Extension tool registration pattern studied from `src/resources/extensions/google-search/index.ts`
- `ToolDefinition` interface from `packages/pi-coding-agent/src/core/extensions/types.ts` (line 337)
- `AgentToolResult` type from `packages/pi-agent-core/src/types.ts`
- DB layer API from `src/resources/extensions/gsd/gsd-db.ts`
- S03 summary forward intelligence for dual-write patterns and `isDbAvailable()` import location
- D006 (structured LLM output mechanism) and D007 (`/gsd inspect` convention) from DECISIONS.md
