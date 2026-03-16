# S03: Surgical Prompt Injection + Dual-Write — Research

**Date:** 2026-03-15

## Summary

S03 is a high-surface-area but mechanically repetitive slice. The work breaks into three independent units: (1) three DB-aware inline helper functions in `auto-prompts.ts`, (2) rewiring all 19 `inlineGsdRootFile` calls across 9 prompt builders to use those helpers, and (3) wiring DB init/migration into `startAuto()` and re-import into `handleAgentEnd()` in `auto.ts`.

The memory-db reference worktree has a complete working implementation of all three pieces. The pattern is a 1:1 drop-in replacement: each `inlineGsdRootFile(base, "decisions.md", "Decisions")` becomes `inlineDecisionsFromDb(base, mid)` — same return type (`string | null`), same wrapping format (`### Label\nSource: ...\n\n<content>`), same conditional push into the `inlined[]` array. The only structural difference is that the DB-aware helpers accept scoping parameters (`milestoneId` for decisions, `sliceId` for requirements) that are already available in every builder's function signature.

The dual-write re-import is a 6-line block in `handleAgentEnd`: after doctor + rebuildState + auto-commit, call `migrateFromMarkdown(basePath)` guarded by `isDbAvailable()`. The DB init in `startAuto()` is ~25 lines: auto-migrate if `gsd.db` doesn't exist but markdown files do, then open existing DB if present.

## Recommendation

Port directly from the memory-db reference with minimal adaptation:

1. **Add 3 DB-aware helpers** to `auto-prompts.ts` — `inlineDecisionsFromDb`, `inlineRequirementsFromDb`, `inlineProjectFromDb`. These use dynamic `import("./context-store.js")` to avoid circular imports and fall back to `inlineGsdRootFile` when DB unavailable or query returns empty.

2. **Replace all 19 calls** across 9 builders. Two builders (`buildExecuteTaskPrompt`, `buildRewriteDocsPrompt`) don't use `inlineGsdRootFile` — leave them untouched.

3. **Wire DB lifecycle** into `auto.ts`: init + auto-migrate in `startAuto()`, re-import in `handleAgentEnd()`, cleanup in `stopAuto()`.

4. **Port `prompt-db.test.ts`** from memory-db — it tests the query+format+wrap pattern without needing to call the actual prompt builders (avoids template loading complexity).

## Implementation Landscape

### Key Files

- `src/resources/extensions/gsd/auto-prompts.ts` (880 lines) — All 11 `build*Prompt()` functions live here. 19 `inlineGsdRootFile` calls to replace across 9 of them. The file already exports `inlineGsdRootFile` which the DB-aware helpers wrap. No other consumers of `inlineGsdRootFile` exist outside this file.

- `src/resources/extensions/gsd/auto.ts` (~2300 lines) — `startAuto()` (line 478), `handleAgentEnd()` (line 805), `stopAuto()` (line 371). DB init goes at end of `startAuto()` before `dispatchNextUnit()` (line ~790). Re-import goes in `handleAgentEnd()` after the doctor + rebuildState + auto-commit block (after line ~858). DB close goes in `stopAuto()`.

- `src/resources/extensions/gsd/context-store.ts` (195 lines) — S01 output. Provides `queryDecisions()`, `queryRequirements()`, `queryProject()`, `formatDecisionsForPrompt()`, `formatRequirementsForPrompt()`. All consumed by the new DB-aware helpers.

- `src/resources/extensions/gsd/gsd-db.ts` (~550 lines) — S01 output. Provides `openDatabase()`, `closeDatabase()`, `isDbAvailable()`. Consumed by `auto.ts` for lifecycle.

- `src/resources/extensions/gsd/md-importer.ts` (526 lines) — S02 output. Provides `migrateFromMarkdown()`. Consumed by both `startAuto()` (initial migration) and `handleAgentEnd()` (re-import).

- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/auto.ts` — Reference implementation. Lines 2479–2555 have the 3 DB-aware helpers. Lines 635–668 have DB init in startAuto. Line 875–882 have re-import in handleAgentEnd.

- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/prompt-db.test.ts` — Reference test file (381 lines, ~40 assertions). Tests query+format+wrap pattern, scoped filtering, fallback behavior, and re-import.

### Exact Call Replacement Map

Each row = one `inlineGsdRootFile` call to replace:

| Builder | Current call | DB-aware replacement | Scoping params |
|---------|-------------|---------------------|----------------|
| `buildResearchMilestonePrompt` | `inlineGsdRootFile(base, "project.md", "Project")` | `inlineProjectFromDb(base)` | none |
| `buildResearchMilestonePrompt` | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base)` | unscoped (milestone-level) |
| `buildResearchMilestonePrompt` | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` | milestoneId=mid |
| `buildPlanMilestonePrompt` | `inlineGsdRootFile(base, "project.md", "Project")` | `inlineProjectFromDb(base)` | none |
| `buildPlanMilestonePrompt` | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base)` | unscoped (milestone-level) |
| `buildPlanMilestonePrompt` | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` | milestoneId=mid |
| `buildResearchSlicePrompt` | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` | milestoneId=mid |
| `buildResearchSlicePrompt` | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base, sid)` | sliceId=sid |
| `buildPlanSlicePrompt` | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` | milestoneId=mid |
| `buildPlanSlicePrompt` | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base, sid)` | sliceId=sid |
| `buildCompleteSlicePrompt` | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base, sid)` | sliceId=sid |
| `buildCompleteMilestonePrompt` | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base)` | unscoped |
| `buildCompleteMilestonePrompt` | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` | milestoneId=mid |
| `buildCompleteMilestonePrompt` | `inlineGsdRootFile(base, "project.md", "Project")` | `inlineProjectFromDb(base)` | none |
| `buildReplanSlicePrompt` | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` | milestoneId=mid |
| `buildRunUatPrompt` | `inlineGsdRootFile(base, "project.md", "Project")` | `inlineProjectFromDb(base)` | none |
| `buildReassessRoadmapPrompt` | `inlineGsdRootFile(base, "project.md", "Project")` | `inlineProjectFromDb(base)` | none |
| `buildReassessRoadmapPrompt` | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base)` | unscoped |
| `buildReassessRoadmapPrompt` | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` | milestoneId=mid |

**Scoping logic:**
- Decisions always scoped by `milestoneId` (every builder has `mid`)
- Requirements scoped by `sliceId` only in slice-level builders (research-slice, plan-slice, complete-slice); unscoped in milestone-level builders (research-milestone, plan-milestone, complete-milestone, reassess-roadmap)
- Project never scoped (no filtering, just DB vs filesystem source)
- `buildExecuteTaskPrompt` and `buildRewriteDocsPrompt` have zero `inlineGsdRootFile` calls — no changes needed

### Build Order

1. **DB-aware helpers (auto-prompts.ts)** — Write the 3 helper functions first. These are self-contained (import from `gsd-db.js` and `context-store.js`) and can be tested in isolation.

2. **Prompt builder rewiring (auto-prompts.ts)** — Replace all 19 calls. Pure find-and-replace with scoping parameter injection. Can be verified by TypeScript compilation (same return type, same variable names).

3. **DB lifecycle in auto.ts** — Wire `openDatabase`/`migrateFromMarkdown` into `startAuto()`, `migrateFromMarkdown` into `handleAgentEnd()`, `closeDatabase` into `stopAuto()`. Order matters: in `startAuto()`, DB init must happen after `.gsd/` bootstrap (line ~568) and after auto-worktree creation (line ~686), but before `dispatchNextUnit()` (line ~793).

4. **Tests** — Port `prompt-db.test.ts` from memory-db. It tests the helpers at the query+format+wrap level without needing to invoke full prompt builders.

### Verification Approach

1. **TypeScript compilation**: `npx tsc --noEmit` must pass. The DB-aware helpers have the same return type (`Promise<string | null>`) as `inlineGsdRootFile`, so the builders need zero other changes.

2. **Existing tests**: All 361+ existing tests must pass — the rewiring must not break any test that exercises prompt builders or auto lifecycle.

3. **New test suite**: `prompt-db.test.ts` — proves:
   - DB-aware helpers return scoped content when DB has data
   - Helpers fall back to filesystem when DB unavailable or empty
   - Scoped filtering actually reduces content size
   - Re-import after markdown changes updates DB state
   - Wrapper format matches `### Label\nSource: ...\n\n<content>` pattern

4. **Test command**: `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/prompt-db.test.ts`

5. **Zero remaining `inlineGsdRootFile` calls for data artifacts**: After rewiring, `grep -c 'inlineGsdRootFile' auto-prompts.ts` should show zero calls in prompt builders (the function definition and export remain for the helpers' fallback path).

## Constraints

- **Dynamic imports in helpers**: The 3 DB-aware helpers must use `await import("./context-store.js")` (not static import) because `auto-prompts.ts` does not import `context-store.ts` today, and adding a static import could create circular dependency issues or unnecessary module loading when DB is unavailable.
- **`inlineGsdRootFile` must remain exported**: The DB-aware helpers call it as their fallback path. Other code might also use it. Don't remove the function — just stop calling it directly from builders.
- **DB init placement in `startAuto()`**: Must happen AFTER auto-worktree creation (which may `chdir` and change `basePath`) and AFTER `.gsd/` bootstrap, but BEFORE secrets collection and `dispatchNextUnit()`. The DB path depends on the final `basePath` (which might be a worktree path).
- **Re-import placement in `handleAgentEnd()`**: Must happen AFTER doctor + rebuildState + auto-commit (the markdown files need to be in their final state before re-import), but BEFORE post-unit hooks (which dispatch the next unit and need fresh DB data).
- **`closeDatabase()` is optional for correctness** — memory-db didn't call it in `stopAuto()`. SQLite file handles get cleaned up on process exit. Adding it in `stopAuto()` is hygiene, not a requirement.

## Common Pitfalls

- **Wrong scoping in milestone-level builders** — `buildResearchMilestonePrompt` and `buildPlanMilestonePrompt` should NOT scope requirements by slice (there's no active slice yet). Only slice-level builders (`buildResearchSlicePrompt`, `buildPlanSlicePrompt`, `buildCompleteSlicePrompt`) scope requirements by `sid`. The memory-db reference gets this right — follow its pattern exactly.
- **Empty DB returns triggering double-loading** — When DB has zero matching rows (e.g., fresh project with no decisions), `formatDecisionsForPrompt([])` returns `''`. The helper checks `decisions.length > 0` before using DB content and falls back to filesystem. This means an empty DB won't produce a "no decisions" empty string — it'll load the (also empty or missing) markdown file instead. This is correct behavior.
- **basePath vs base confusion in auto.ts** — `startAuto()` uses both `base` (the parameter) and `basePath` (the module variable that may change after worktree setup). DB init must use `basePath` (the final path), not `base` (the original path). The `gsdDir` variable at line 568 uses `base`, but by the time DB init runs, `basePath` may have changed to a worktree path.

## Open Risks

- **`buildRewriteDocsPrompt` lists doc paths but doesn't inline content** — it checks `existsSync(decisionsPath)` etc. to build a doc list. This does NOT need DB-aware replacement because it's listing file paths, not loading file content. However, if a future change makes it load content, it would need updating. Low risk.
- **Re-import in `handleAgentEnd` overwrites DB with markdown state** — if the LLM writes a malformed DECISIONS.md, the re-import will parse what it can and skip malformed rows (per `parseDecisionsTable` behavior). This could cause data loss for individual decisions. The memory-db accepted this risk. Mitigation: the parsers are proven against current formats (S02 validated).
