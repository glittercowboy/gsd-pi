# S01: DB Foundation + Decisions + Requirements — Research

**Date:** 2026-03-14

## Summary

S01 builds the SQLite foundation layer: open database, create schema, provide typed wrappers for decisions and requirements tables, expose filtered views (`active_decisions`, `active_requirements`), and gracefully degrade when `better-sqlite3` is unavailable. This slice owns R001, R002, R005, R006, R017, R020, R021 and provides the foundation all later slices depend on.

Verified: `better-sqlite3@12.8.0` installs cleanly on Node 22.20.0 (ARM64 macOS), compiles a native addon (no prebuilds directory — uses `node-gyp` at install time), WAL mode works on file-backed DBs, and query latency is ~0.012ms — well under the R017 5ms requirement. ESM default import (`import Database from 'better-sqlite3'`) works correctly with the project's `"type": "module"` + `NodeNext` module resolution.

The existing `native-parser-bridge.ts` provides a proven lazy-load pattern for optional native modules with graceful fallback. This is the exact pattern to replicate. The project already has optional native dependencies (`@gsd-build/engine-*`, `koffi`) in `optionalDependencies`, so adding `better-sqlite3` there follows established convention.

Key design constraint: the DECISIONS.md table format (`| # | When | Scope | Decision | Choice | Rationale | Revisable? |`) maps cleanly to a relational table with a `superseded_by` column for the `active_decisions` view. REQUIREMENTS.md has a richer per-item structure (9+ fields per requirement under `### Rxx —` headings) requiring a wider table — but individual requirement parsing doesn't exist yet in `files.ts` (only `parseRequirementCounts()` which counts headings). S01 defines the schema; S02 builds the importer.

## Recommendation

Use `better-sqlite3` as an `optionalDependency` with the `native-parser-bridge.ts` lazy-load pattern. Schema versioning via `PRAGMA user_version` (simpler than a separate table — built into SQLite). WAL mode on open. File at `.gsd/gsd.db`. Two new source files:

1. **`gsd-db.ts`** — Low-level DB layer: `openDatabase(dbPath)`, `initSchema()`, `isDbAvailable()`, typed insert/query wrappers for `decisions` and `requirements` tables. Exports the `Database` instance for direct use by higher-level modules.

2. **`context-store.ts`** — Query layer: `queryDecisions(milestoneId?, scope?)`, `queryRequirements(sliceId?, status?)`, format functions that produce markdown-like strings for prompt injection. This is what prompt builders will call (in S03).

Add `gsd.db`, `gsd.db-wal`, `gsd.db-shm` to `BASELINE_PATTERNS` in `gitignore.ts`.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| SQLite access from Node.js | `better-sqlite3@12.8.0` | Sync API matches existing sync prompt-building. Native addon with prebuilt/compiled binaries. D001 confirmed this choice as non-revisable. |
| Schema versioning | `PRAGMA user_version` | Built into SQLite, zero overhead. `db.pragma('user_version', { simple: true })` returns an integer. No extra table needed. |
| Optional native module loading | `native-parser-bridge.ts` pattern | Lazy load with `loadAttempted` sentinel, try/catch around `require()`. Proven pattern in this codebase. |
| TS type definitions | `@types/better-sqlite3` | Community-maintained types that match the latest API. Install as `devDependency`. |

## Existing Code and Patterns

- `src/resources/extensions/gsd/native-parser-bridge.ts` — **The fallback pattern to replicate.** Lazy `require()` with `loadAttempted` boolean sentinel. Module-level nullable typed reference. Every public function checks `loadNative()` before using native code. Returns `null` or sentinel value on unavailability. Lines 23–43 are the key pattern.
- `src/resources/extensions/gsd/auto.ts` (line 2499) — `inlineGsdRootFile()` reads entire markdown files and inlines them into prompts. Called 19 times across 9+ prompt builders for `decisions.md`, `requirements.md`, and `project.md`. This is what the context store query layer eventually replaces (S03).
- `src/resources/extensions/gsd/files.ts` (line 627) — `parseRequirementCounts()` only counts `### Rxx —` headings per section. Does NOT parse individual requirement fields. No decision parser exists at all — decisions are never parsed, just inlined wholesale. S01 defines the target schema; S02 builds parsers.
- `src/resources/extensions/gsd/paths.ts` (line 157) — `GSD_ROOT_FILES` constant and `resolveGsdRootFile()` handle case-insensitive file lookup with legacy fallback. New DB path should use `gsdRoot(basePath) + '/gsd.db'`.
- `src/resources/extensions/gsd/gitignore.ts` (line 17) — `BASELINE_PATTERNS` array defines auto-gitignored paths. Must add `gsd.db`, `gsd.db-wal`, `gsd.db-shm` here. The entire `.gsd/` is already in the project's root `.gitignore`, but `BASELINE_PATTERNS` is for the bootstrap — it ensures new GSD projects also get these patterns.
- `src/resources/extensions/gsd/types.ts` (line 161) — `RequirementCounts` interface is just aggregate counts. No `Decision` or `Requirement` typed interface exists — S01 must define these as row types for the DB layer.
- `src/resources/extensions/gsd/state.ts` — `deriveState()` populates `recentDecisions: string[]` (always empty array currently — line 198, 329, 348, etc.) and `requirements?: RequirementCounts`. S04 will rewire these to DB queries.
- `packages/pi-coding-agent/src/resources/extensions/memory/storage.ts` — Existing `sql.js`-based SQLite DB in the `memory` extension. Uses async init + manual buffer-to-file persist. Different approach from `better-sqlite3` (sync, direct file). The two coexist without conflict in different extensions.
- `package.json` `optionalDependencies` — Already declares `@gsd-build/engine-*` and `koffi` as optional. `better-sqlite3` goes here, following the same pattern.
- `tsconfig.json` — `"module": "NodeNext"`, `"target": "ES2022"`, `"strict": true`. Tests run with `node --test --experimental-strip-types`. Resource files (`src/resources/`) are excluded from tsc compilation and copied raw.

## Constraints

- **ESM project with `"type": "module"`** — `import Database from 'better-sqlite3'` works (verified). For lazy loading, use dynamic `import()` or `createRequire` from `node:module`. The `native-parser-bridge.ts` uses `require()` which works because `src/resources/` is excluded from tsc and copied raw — same would apply to `gsd-db.ts`.
- **Sync API required** — All `build*Prompt()` functions in `auto.ts` are async at the function level but data loading within them is synchronous (`existsSync`, `readFileSync` via helpers). `better-sqlite3` is sync by design — perfect fit.
- **WAL sidecar files** — `PRAGMA journal_mode = WAL` creates `gsd.db-wal` and `gsd.db-shm` files during runtime. These are cleaned up on proper `db.close()` but survive crashes. Must be gitignored.
- **`optionalDependency` declaration** — `better-sqlite3` must be optional so `npm install` succeeds even if the native addon fails to build. `@types/better-sqlite3` is a `devDependency`.
- **Schema forward-compatibility (R021)** — PKs must be stable and joinable by future embedding virtual tables. Decisions: `seq INTEGER PRIMARY KEY AUTOINCREMENT`. Requirements: `id TEXT PRIMARY KEY` (e.g., "R001"). Both allow `CREATE VIRTUAL TABLE embeddings USING vec0(decision_seq INTEGER, ...)` later.
- **Node ≥20.6.0** — Engine requirement. `better-sqlite3@12.x` declares `"node": "20.x || 22.x || 23.x || 24.x || 25.x"` — compatible.
- **Test runner is `node --test`** — Not vitest/jest. Tests use `createTestContext()` from `test-helpers.ts` with custom `assertEq`/`assertTrue`/`report` functions. DB tests must follow this pattern.

## Common Pitfalls

- **Top-level `require('better-sqlite3')`** — Crashes the process if the native addon failed to build. Must use the lazy-load pattern: a function called on first DB access, with try/catch, setting a module-level `loadAttempted` sentinel. Identical to `native-parser-bridge.ts` lines 23–43.
- **WAL sidecar files not gitignored** — A crash leaves `gsd.db-wal` and `gsd.db-shm` on disk. If not in `BASELINE_PATTERNS`, they appear as untracked files. Add all three file patterns.
- **`PRAGMA user_version` starts at 0** — Fresh SQLite DBs return `user_version = 0`. Must distinguish "never initialized" (no tables exist) from "schema version 0" to avoid re-running `initSchema()`. Check for table existence first (`SELECT name FROM sqlite_master WHERE type='table' AND name='decisions'`), then check `user_version` for migrations.
- **`db.pragma()` return format** — Without `{ simple: true }`, `db.pragma('journal_mode')` returns `[{ journal_mode: 'wal' }]`. With `{ simple: true }`, returns the scalar `'wal'`. Always use `{ simple: true }` for reads.
- **Decisions `superseded_by` inference** — The DECISIONS.md table has no explicit `superseded_by` column. When importing (S02), must infer from row content or default to `NULL`. The `active_decisions` view (`WHERE superseded_by IS NULL`) works correctly with this — all imported decisions start as active. Future decision rows can explicitly reference what they supersede.
- **Requirement `id` as PK** — R001, R002... are globally unique within the project. The REQUIREMENTS.md format uses `### Rxx — Title` headings with dash-separated fields below. The schema must accommodate the full field set (Class, Status, Description, Why it matters, Source, Primary owning slice, Supporting slices, Validation, Notes).
- **DB close on process exit** — Must register a cleanup handler (process `beforeExit` or `exit` event) to call `db.close()`. Otherwise WAL files linger and the DB may not be fully checkpointed. However, SQLite self-repairs on next open, so this is a cleanliness concern, not a data-loss risk.
- **Transaction performance** — 1000 individual inserts: ~100ms. Same 1000 inserts in a single transaction: ~5ms. Always wrap bulk operations in `db.transaction()`.

## Open Risks

- **`better-sqlite3` native build on exotic platforms** — Prebuilt binaries may not cover Alpine Linux, musl libc, or unusual architectures. These platforms require `node-gyp` + build tools (`python3`, `make`, `gcc`/`g++`). The graceful fallback (R002) makes this a non-fatal degradation. Low risk for typical use.
- **Schema evolution across slices** — S01 creates decisions + requirements tables. S02–S03 add 8+ more tables (milestones, slices, tasks, roadmaps, plans, summaries, contexts, research). Schema migrations via `user_version` must handle incremental additions without data loss. Use `CREATE TABLE IF NOT EXISTS` for new tables and `ALTER TABLE ADD COLUMN` for additions to existing tables.
- **`node:sqlite` stabilization** — Available in Node 22 as experimental (prints warning). If it stabilizes and becomes the standard, `better-sqlite3` becomes unnecessary tech debt. Low risk — D001 is non-revisable, and the fallback architecture means swapping implementations later is straightforward. The API surface is similar.
- **Two SQLite libraries in the project** — `sql.js` (memory extension) and `better-sqlite3` (GSD DB). Different extensions, different loading patterns, no conflict. Could eventually consolidate but out of scope for M001-h5msp6.
- **Process crash leaving DB in unexpected state** — WAL mode handles this gracefully — SQLite replays the WAL on next open. No special recovery code needed. The sidecar files are harmless artifacts of an incomplete checkpoint.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| SQLite | `martinholovsky/claude-skills-generator@sqlite-database-expert` | available (544 installs) — general SQLite expertise, not specific to better-sqlite3. Not recommended — the better-sqlite3 docs and existing codebase patterns are sufficient. |
| better-sqlite3 | (none found) | none found |

No skills are directly relevant enough to recommend installing.

## Sources

- `better-sqlite3@12.8.0` installs on Node 22.20.0 arm64 darwin via native addon compilation (source: local `npm install` verification in `/tmp/sqlite-test`)
- WAL mode confirmed on file-backed DB: `db.pragma('journal_mode = WAL')` returns `'wal'` (source: local Node.js verification)
- Query latency verified at ~0.012ms per query (1000 scoped queries in 11.77ms) (source: local benchmark in `/tmp/sqlite-test`)
- ESM default import works: `import Database from 'better-sqlite3'` (source: local `--input-type=module` verification)
- `node:sqlite` experimental in Node 22, prints `ExperimentalWarning` (source: local `require('node:sqlite')` verification)
- `better-sqlite3` API: `.pragma()`, `.prepare()`, `.transaction()`, `.exec()`, constructor options (source: [Context7 better-sqlite3 docs](https://context7.com/wiselibs/better-sqlite3/llms.txt))
- Fallback pattern proven in `native-parser-bridge.ts` with lazy require + sentinel (source: codebase `src/resources/extensions/gsd/native-parser-bridge.ts`)
- `@types/better-sqlite3` available as community-maintained package (source: [better-sqlite3 contribution docs](https://github.com/wiselibs/better-sqlite3/blob/master/docs/contribution.md))
