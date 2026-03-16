---
estimated_steps: 5
estimated_files: 1
---

# T01: Add DB-aware helpers and rewire all prompt builders

**Slice:** S03 — Surgical Prompt Injection + Dual-Write
**Milestone:** M004

## Description

Add 3 DB-aware inline helper functions to `auto-prompts.ts` and replace all 19 `inlineGsdRootFile` data-artifact calls across 9 prompt builders. The helpers query the SQLite DB for scoped context (decisions filtered by milestone, requirements filtered by slice) and fall back to filesystem loading when DB is unavailable or returns empty results.

## Steps

1. Add 3 DB-aware helper functions after the existing `inlineGsdRootFile` export (around line 97). Use the memory-db reference pattern:

   **`inlineDecisionsFromDb(base, milestoneId?, scope?)`**: Check `isDbAvailable()`, dynamic import `context-store.js` and `gsd-db.js`, call `queryDecisions({milestoneId, scope})`. If results non-empty, format with `formatDecisionsForPrompt()` and wrap as `### Decisions\nSource: \`.gsd/DECISIONS.md\`\n\n<content>`. Otherwise fall back to `inlineGsdRootFile(base, "decisions.md", "Decisions")`. Return type: `Promise<string | null>`.

   **`inlineRequirementsFromDb(base, sliceId?)`**: Same pattern. Call `queryRequirements({sliceId})`, format with `formatRequirementsForPrompt()`, wrap as `### Requirements\nSource: \`.gsd/REQUIREMENTS.md\`\n\n<content>`. Fall back to `inlineGsdRootFile(base, "requirements.md", "Requirements")`.

   **`inlineProjectFromDb(base)`**: Check `isDbAvailable()`, dynamic import `context-store.js`, call `queryProject()`. If non-null, wrap as `### Project\nSource: \`.gsd/PROJECT.md\`\n\n<content>`. Fall back to `inlineGsdRootFile(base, "project.md", "Project")`.

2. Replace all 19 `inlineGsdRootFile` data-artifact calls per this exact map:

   | Builder | Line | Old Call | New Call |
   |---------|------|----------|---------|
   | `buildResearchMilestonePrompt` | 374 | `inlineGsdRootFile(base, "project.md", "Project")` | `inlineProjectFromDb(base)` |
   | `buildResearchMilestonePrompt` | 376 | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base)` |
   | `buildResearchMilestonePrompt` | 378 | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` |
   | `buildPlanMilestonePrompt` | 409 | `inlineGsdRootFile(base, "project.md", "Project")` | `inlineProjectFromDb(base)` |
   | `buildPlanMilestonePrompt` | 411 | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base)` |
   | `buildPlanMilestonePrompt` | 413 | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` |
   | `buildResearchSlicePrompt` | 453 | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` |
   | `buildResearchSlicePrompt` | 455 | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base, sid)` |
   | `buildPlanSlicePrompt` | 493 | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` |
   | `buildPlanSlicePrompt` | 495 | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base, sid)` |
   | `buildCompleteSlicePrompt` | 603 | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base, sid)` |
   | `buildCompleteMilestonePrompt` | 667 | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base)` |
   | `buildCompleteMilestonePrompt` | 669 | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` |
   | `buildCompleteMilestonePrompt` | 671 | `inlineGsdRootFile(base, "project.md", "Project")` | `inlineProjectFromDb(base)` |
   | `buildReplanSlicePrompt` | 726 | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` |
   | `buildRunUatPrompt` | 762 | `inlineGsdRootFile(base, "project.md", "Project")` | `inlineProjectFromDb(base)` |
   | `buildReassessRoadmapPrompt` | 792 | `inlineGsdRootFile(base, "project.md", "Project")` | `inlineProjectFromDb(base)` |
   | `buildReassessRoadmapPrompt` | 794 | `inlineGsdRootFile(base, "requirements.md", "Requirements")` | `inlineRequirementsFromDb(base)` |
   | `buildReassessRoadmapPrompt` | 796 | `inlineGsdRootFile(base, "decisions.md", "Decisions")` | `inlineDecisionsFromDb(base, mid)` |

3. **Scoping rules** (critical — do NOT mix these up):
   - Decisions: always pass `mid` (every builder has it in its function signature)
   - Requirements in **slice-level** builders (`buildResearchSlicePrompt`, `buildPlanSlicePrompt`, `buildCompleteSlicePrompt`): pass `sid`
   - Requirements in **milestone-level** builders (`buildResearchMilestonePrompt`, `buildPlanMilestonePrompt`, `buildCompleteMilestonePrompt`, `buildReassessRoadmapPrompt`): pass NO `sliceId` (unscoped — no active slice at milestone level)
   - Project: never scoped (no filtering parameters)

4. Do NOT modify `buildExecuteTaskPrompt` or `buildRewriteDocsPrompt` — they have zero `inlineGsdRootFile` calls.

5. Keep the `inlineGsdRootFile` function definition and its `export` keyword — it's the fallback path used by all 3 helpers.

## Must-Haves

- [ ] 3 DB-aware helpers added with dynamic imports and `isDbAvailable()` guard
- [ ] All 19 `inlineGsdRootFile` data-artifact calls replaced
- [ ] Scoping correct: decisions by `mid`, requirements by `sid` only in slice-level builders
- [ ] `inlineGsdRootFile` still exported
- [ ] TypeScript compiles clean

## Verification

- `npx tsc --noEmit` — zero errors
- `grep 'inlineGsdRootFile(base' src/resources/extensions/gsd/auto-prompts.ts` — returns 0 matches (the function definition uses different param names on separate lines)
- Count check: `grep -c 'inlineDecisionsFromDb\|inlineRequirementsFromDb\|inlineProjectFromDb' src/resources/extensions/gsd/auto-prompts.ts` — should be ≥22 (3 definitions + 19 call sites)

## Inputs

- `src/resources/extensions/gsd/auto-prompts.ts` — current file with 19 `inlineGsdRootFile` calls to replace
- `src/resources/extensions/gsd/gsd-db.ts` — provides `isDbAvailable()` (S01 output)
- `src/resources/extensions/gsd/context-store.ts` — provides `queryDecisions()`, `queryRequirements()`, `queryProject()`, `formatDecisionsForPrompt()`, `formatRequirementsForPrompt()` (S01 output)
- Reference implementation: the memory-db worktree has the 3 helpers at lines 2489-2555 of its `auto.ts`. The pattern is identical — just located in `auto-prompts.ts` instead of `auto.ts` in the current architecture.

## Expected Output

- `src/resources/extensions/gsd/auto-prompts.ts` — modified with 3 new helper functions and 19 call site replacements. File grows by ~60 lines (the 3 helpers). Zero `inlineGsdRootFile(base` calls remain in prompt builder bodies.

## Observability Impact

- **Signals changed:** Prompt builders now attempt DB queries before filesystem reads. When DB is available, prompts contain scoped (filtered) decisions/requirements instead of full-file dumps. When DB is unavailable, behavior is identical to pre-change (filesystem fallback).
- **Inspection:** `isDbAvailable()` returns whether DB-sourced content is being injected. The 3 helpers log nothing on success; catch blocks silently fall through to filesystem (no stderr noise for expected fallback).
- **Failure visibility:** If dynamic imports fail (e.g., `gsd-db.js` or `context-store.js` missing/broken), the catch block in each helper degrades to `inlineGsdRootFile` — identical to pre-change behavior. No crash, no visible error to the dispatched agent.
- **Diagnostic command:** `grep -c 'inlineDecisionsFromDb\|inlineRequirementsFromDb\|inlineProjectFromDb' src/resources/extensions/gsd/auto-prompts.ts` — should return ≥22 (3 definitions + 19 call sites).
