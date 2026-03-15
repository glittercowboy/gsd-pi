# S01: DB Foundation + Decisions + Requirements — Research

**Date:** 2026-03-14
**Slice owns:** R001, R002, R005, R006, R017, R020, R021
**Slice supports:** (none — first slice)

## Summary

The foundation slice requires a SQLite database layer, schema with decisions/requirements tables, filtered views, and graceful fallback. Research reveals a significant opportunity: `node:sqlite` (the built-in SQLite module) is available on Node.js v22.20.0 with a sync API (`DatabaseSync`) that matches our needs — `prepare`/`run`/`get`/`all`, named parameters, WAL mode, `loadExtension`, and even `createSession`/`applyChangeset` for future worktree merge. This eliminates the native addon distribution problem entirely for Node ≥22.5.0 users.

D001 chose `better-sqlite3` for its sync API and prebuilt binaries. However, `better-sqlite3` has known prebuild availability issues (especially on Node 24 and Arch Linux), adds a C++ build dependency, complicates npm distribution, and provides no capability that `node:sqlite` doesn't already have. The recommended approach is: **prefer `node:sqlite`, fall back to `better-sqlite3` if `node:sqlite` is unavailable (Node <22.5.0), fall back to markdown if neither works.** This preserves D001's safety net while eliminating the most likely failure mode (native addon install) on modern Node versions.

The DECISIONS.md format is a markdown table (columns: `#`, `When`, `Scope`, `Decision`, `Choice`, `Rationale`, `Revisable?`). No existing parser breaks this into individual rows — `files.ts` only has `parseRequirementCounts` which counts headings. Both decisions and requirements parsers need to be written for import. The decisions table parser is straightforward (split markdown table rows); the requirements parser is more involved (H3 sections with key-value metadata lines). The existing `extractSection` and `extractAllSections` utilities in `files.ts` can handle the requirements parsing.

## Recommendation

**Library strategy:** Use `node:sqlite` as the primary SQLite provider with a thin abstraction layer. Add `better-sqlite3` as an `optionalDependency` that loads only when `node:sqlite` is unavailable. The abstraction layer exposes: `open(path)`, `close()`, `exec(sql)`, `prepare(sql)` returning `{ run, get, all }`, and a `transaction(fn)` helper. This is roughly 80 lines of code and hides the provider choice from all consumers.

**Schema:** Two tables for S01 — `decisions` and `requirements` — plus a `schema_version` table. `decisions` uses `seq INTEGER PRIMARY KEY` (auto-increment) with `id TEXT UNIQUE` (D001, D002...) for deterministic merge. `requirements` uses `id TEXT PRIMARY KEY` (R001, R002...) as stable natural key. Both tables include a `superseded_by TEXT` column for the "append-only, supersede to reverse" pattern. Views `active_decisions` and `active_requirements` filter `WHERE superseded_by IS NULL`.

**Fallback:** Three-tier: `node:sqlite` → `better-sqlite3` → markdown. The `isDbAvailable()` function tries to load `node:sqlite`, then `better-sqlite3`, caching the result. All downstream code checks `isDbAvailable()` before using DB operations.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| SQLite access (sync) | `node:sqlite` (`DatabaseSync`) | Built into Node ≥22.5.0. Zero dependencies. Sync API matches codebase. WAL, `loadExtension`, `createSession` all available. |
| SQLite fallback | `better-sqlite3` (npm) | Proven fallback for Node <22.5.0. Same sync API shape. Well-maintained, prebuilt binaries for LTS. |
| Section extraction | `extractSection()` / `extractAllSections()` in `files.ts` | Already handles heading-level scoping. Uses native parser when available. |
| Graceful native module loading | Pattern in `native-parser-bridge.ts` | `try { require(...) } catch {}` with `loadAttempted` flag. Exact pattern we need. |
| Gitignore management | `ensureGitignore()` in `gitignore.ts` | `BASELINE_PATTERNS` array — just add `gsd.db`, `gsd.db-wal`, `gsd.db-shm`. |

## Existing Code and Patterns

- `src/resources/extensions/gsd/native-parser-bridge.ts` — **The exact graceful-fallback pattern to follow.** Lazy load with `loadAttempted` flag, `try/catch` around `require()`, all functions check availability before using native module. Our DB layer uses this same pattern.
- `src/resources/extensions/gsd/files.ts` — `extractSection()`, `extractAllSections()`, `splitFrontmatter()`, `parseFrontmatterMap()` are reusable for parsing REQUIREMENTS.md (H3 sections with key-value metadata). `parseRequirementCounts()` only counts — we need full row extraction.
- `src/resources/extensions/gsd/types.ts` — `RequirementCounts` exists but no `Decision` or `Requirement` type. New types needed: `Decision` (id, when, scope, decision, choice, rationale, revisable, superseded_by) and `Requirement` (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes).
- `src/resources/extensions/gsd/gitignore.ts` — `BASELINE_PATTERNS` array. Add `.gsd/gsd.db`, `.gsd/gsd.db-wal`, `.gsd/gsd.db-shm` to this array.
- `src/resources/extensions/gsd/paths.ts` — `gsdRoot()` and `resolveGsdRootFile()` for locating `.gsd/`. DB path = `join(gsdRoot(base), 'gsd.db')`.
- `src/resources/extensions/gsd/auto.ts` — `inlineGsdRootFile()` (line 2524) loads DECISIONS.md and REQUIREMENTS.md as full text. This is the integration surface for S03, not S01.
- `src/resources/extensions/gsd/state.ts` — `deriveState()` scans files. Integration surface for S04, not S01.
- `src/resources/extensions/gsd/tests/test-helpers.ts` — Test pattern: `createTestContext()` with `assertEq`, `assertTrue`, `assertMatch`, `report()`. Tests use Node's built-in test runner (`node --test`).
- `src/resources/extensions/gsd/package.json` — Extension is ESM (`"type": "module"`). Uses `jiti` loader which provides `require()` in ESM context.

## Constraints

- **Node ≥20.6.0** — `engines` constraint means `node:sqlite` (added 22.5.0) isn't available for all users. Must support `better-sqlite3` fallback.
- **ESM module system** — Extension uses `"type": "module"`. `better-sqlite3` is CJS — must use `require()` or `createRequire` (pattern exists in `native-parser-bridge.ts`).
- **Sync API only** — All prompt-building code is synchronous. Database operations must be synchronous (`DatabaseSync` / `better-sqlite3`'s sync API).
- **`jiti` loader** — Pi's TypeScript loader provides `require()` globally in ESM context. The `require('@gsd/native')` pattern in native-parser-bridge.ts confirms this works.
- **Schema forward-compatibility** — R021 requires schema that accommodates future Rust `rusqlite` vector search virtual tables. Use stable PKs (auto-increment `seq` for decisions, natural key `id` for requirements) that embedding tables can join on.
- **WAL mode** — R020 requires WAL. `PRAGMA journal_mode=WAL` must be set on every `open()`. Produces `.db-wal` and `.db-shm` sidecar files that must be gitignored.
- **`node:sqlite` ExperimentalWarning** — On Node 22.x, `require('node:sqlite')` emits `ExperimentalWarning` to stderr. Suppress it at the call site by intercepting `process.emit('warning', ...)` for the SQLite-specific warning.

## Common Pitfalls

- **WAL mode on `:memory:`** — `PRAGMA journal_mode=WAL` silently returns `memory` for in-memory databases. Tests using `:memory:` won't actually test WAL. Use temp file DBs for WAL-specific tests.
- **`node:sqlite` named parameter prefix** — `node:sqlite` supports `:name`, `$name`, and `@name` prefixes. `better-sqlite3` uses the same conventions. Use `:name` for consistency.
- **Transaction nesting** — Neither `node:sqlite` nor `better-sqlite3` supports nested transactions by default. Use `SAVEPOINT`/`RELEASE` if needed, but for S01's scope simple `BEGIN`/`COMMIT`/`ROLLBACK` suffices.
- **`node:sqlite` returns `[Object: null prototype]`** — Row objects from `node:sqlite` have null prototypes. This means `Object.keys()` works but `row.hasOwnProperty()` doesn't. Use `Object.hasOwn(row, key)` or destructuring instead.
- **`better-sqlite3` in ESM** — Cannot `import` directly. Must use `require()` (available via jiti) or `createRequire(import.meta.url)()`.
- **Schema version table** — Don't use `PRAGMA user_version` for schema versioning. It's a single integer with no migration history. Use a dedicated `schema_version` table with version number and applied timestamp for auditability.
- **View definitions survive schema changes** — If a column is renamed in a table, views referencing the old column name break silently (they error on query, not on table ALTER). Schema migrations that touch columns referenced by views must drop and recreate views.

## Open Risks

- **`node:sqlite` API stability on Node 22** — Currently at "Stability: 1.1 - Active development." API could change in minor Node 22.x releases. Mitigation: the abstraction layer isolates all callers from API changes. If the API breaks in a Node update, only the adapter module changes.
- **`better-sqlite3` as `optionalDependency`** — Users on Node <22.5.0 need `better-sqlite3` to install successfully. If prebuild isn't available for their platform/Node combo, they get markdown fallback (acceptable per R002, but suboptimal). Mitigation: document minimum Node version recommendation.
- **DECISIONS.md table parsing edge cases** — Markdown table cells containing `|` characters (pipe in rationale text) would break naive split-on-pipe parsing. Need to handle escaped pipes or use a proper markdown table parser. Mitigation: existing decisions in the codebase don't contain literal pipes in cell content, but the parser should handle it defensively.
- **REQUIREMENTS.md format stability** — Requirements use a semi-structured format (H3 heading + key-value lines). If users modify the format, the parser breaks silently. Mitigation: `full_content` column stores the original markdown for each requirement, ensuring no data loss even if structured parsing is incomplete.

## Decision: Revisit D001 (SQLite library choice)

**Recommendation:** Amend D001 to adopt a tiered strategy: `node:sqlite` → `better-sqlite3` → markdown.

**Evidence:**
1. `node:sqlite` `DatabaseSync` works on Node 22.20.0 with full API: `prepare`/`run`/`get`/`all`, named params, WAL, `loadExtension`, `createSession`/`applyChangeset`
2. Zero dependency — built into Node, no native addon, no prebuild, no C++ compiler
3. Standard SQLite file format (verified: `SQLite format 3\0` header) — compatible with `rusqlite` for future vector search
4. `better-sqlite3` has known prebuild availability issues on some platforms
5. The only gap: `node:sqlite` unavailable on Node <22.5.0 (project supports ≥20.6.0)

**This amends D001, not reverses it.** `better-sqlite3` remains as a fallback for Node <22.5.0 users. The two have nearly identical sync APIs, so the abstraction layer is thin.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| SQLite | `martinholovsky/claude-skills-generator@sqlite database expert` (544 installs) | available — generic SQLite expertise, not directly needed |
| better-sqlite3 | none found | n/a |
| node:sqlite | none found | n/a |

No skills worth installing. The work is straightforward SQLite schema design + TypeScript wrapper code.

## Sources

- `node:sqlite` `DatabaseSync` API verified by running tests on Node v22.20.0 (source: local verification)
- `node:sqlite` available since Node v22.5.0 (source: Node.js changelog)
- `node:sqlite` ExperimentalWarning suppressible via `process.emit` interception (source: local verification)
- `better-sqlite3` prebuild issues reported on multiple Linux distros (source: community reports)
- SQLite file format compatibility verified by reading file header bytes (source: local verification)
- `node:sqlite` `createSession`/`applyChangeset` available for future worktree merge (source: local verification)
