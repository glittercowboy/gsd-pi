# Issue #82: Hard-Steer — Implementation Plan

## Problem Statement

During GSD auto-mode execution, plan documents (T##-PLAN.md, S##-PLAN.md, DECISIONS.md, etc.) are treated as the **authoritative execution contract**. When a wrong decision gets baked into these docs during planning, regular steering only affects the current task turn — the next dispatched task re-reads the same flawed documents from disk and repeats the mistake. The user has no way to propagate a correction across all active documentation without manually editing every file or spawning a separate agent to do it.

## Approach: Hybrid Override + Document Rewrite

Combines immediate override injection (so the current and next task honor the change) with a deferred document rewrite unit (so the docs themselves are corrected before further execution).

---

## Phase 1: Override Register (Immediate Effect)

### 1.1 — New file: `.gsd/OVERRIDES.md`

An append-only file where each override entry captures:

```markdown
## Override: <timestamp>

**Change:** <user's description of what to change>
**Scope:** <active | resolved>
**Applied-at:** <milestone/slice/task when override was issued>

---
```

- Active overrides are injected into every task prompt until resolved
- Resolved overrides remain for audit trail but are no longer injected

### 1.2 — New command: `/gsd steer <description>`

**File:** `src/resources/extensions/gsd/commands.ts`

Add a new subcommand `steer` to the existing `/gsd` command handler:

```
/gsd steer Use Postgres instead of SQLite for all persistence
```

**Behavior:**
1. If auto-mode is running, pause it (`pauseAuto()`)
2. Append the override to `.gsd/OVERRIDES.md` with timestamp, scope `active`, and current milestone/slice/task context
3. Queue a `rewrite-docs` unit as the next dispatch (see Phase 2)
4. Resume auto-mode

**Changes required:**
- `commands.ts` — add `steer` case in the subcommand router (~20 lines)
- New helper `appendOverride()` in `files.ts` — format and append override entry
- New helper `loadActiveOverrides()` in `files.ts` — parse OVERRIDES.md and return active entries

### 1.3 — Override injection into task prompts

**Files:** `auto.ts` (buildExecuteTaskPrompt), `index.ts` (buildTaskExecutionContextInjection)

Both prompt-building functions need to:
1. Call `loadActiveOverrides(basePath)`
2. If active overrides exist, prepend an `## Active Overrides (supersede plan content)` section at the **top** of the injected context, before the task plan inline
3. Language: *"The following overrides were issued by the user and supersede any conflicting content in plan documents below. Follow these overrides even if they contradict the inlined task plan."*

**Injection point in `buildExecuteTaskPrompt` (auto.ts:2416):**
```typescript
return loadPrompt("execute-task", {
  // ... existing params
  overridesSection,  // NEW — injected before taskPlanInline
});
```

**Injection point in `buildTaskExecutionContextInjection` (index.ts:603):**
```typescript
return [
  "[GSD Guided Execute Context]",
  "...",
  "",
  overridesSection,  // NEW — before resumeSection
  "",
  resumeSection,
  // ... rest unchanged
].join("\n");
```

**Template change in `execute-task.md`:**
Add `{{overridesSection}}` placeholder before `{{taskPlanInline}}`.

### 1.4 — Override injection into planning/research prompts

Active overrides should also be injected into:
- `plan-slice.md` / `guided-plan-slice.md` — so replanning respects overrides
- `research-slice.md` / `guided-research-slice.md` — so research doesn't pursue invalidated approaches
- `replan-slice.md` — so replans honor overrides
- `complete-slice.md` — so completion verification accounts for overrides

Each of these prompt builders in `auto.ts` needs to call `loadActiveOverrides()` and inject the section.

---

## Phase 2: Document Rewrite Unit (Lasting Fix)

### 2.1 — New unit type: `rewrite-docs`

**File:** `auto.ts`

Add `rewrite-docs` to the unit type system alongside existing types (plan-slice, execute-task, complete-slice, replan-slice, etc.).

**Changes required in auto.ts:**
- `unitTypeLabel()` — add `case "rewrite-docs": return "rewriting";`
- `unitTypeTag()` — add `case "rewrite-docs": return "REWRITE";`
- `unitTypeNextHint()` — add `case "rewrite-docs": return "continue execution";`
- `resolveExpectedArtifactPath()` — return null (no single artifact)
- `unitArtifactsExist()` — return true for rewrite-docs (like replan-slice)
- Branch handling — rewrite-docs stays on the current slice branch

### 2.2 — New prompt: `rewrite-docs.md`

**File:** `src/resources/extensions/gsd/prompts/rewrite-docs.md`

```markdown
You are executing GSD auto-mode.

## UNIT: Rewrite Documents — Apply Override

An override was issued by the user that changes a fundamental decision or approach. Your job is to propagate this change across all active planning documents so they are internally consistent and future tasks execute correctly.

## Active Override

{{overrideContent}}

## Documents to Review and Update

{{documentList}}

## Instructions

1. Read each document listed above
2. Identify all references to the overridden decision/approach
3. Rewrite each document to reflect the new direction
4. For task plans (T##-PLAN.md):
   - Do NOT modify completed tasks ([x]) — they are historical
   - Rewrite incomplete tasks ([ ]) to align with the override
   - If a task is no longer needed due to the override, remove it
   - If new tasks are needed, add them following the ID sequence
5. For DECISIONS.md:
   - Append a new decision entry documenting the override and why
   - Do NOT delete prior decisions — mark them as superseded
6. For slice plans (S##-PLAN.md):
   - Update Goal, Demo, Verification sections if affected
   - Update Files Likely Touched if the override changes scope
7. Write a brief summary of all changes made
8. Mark the override as `resolved` in `.gsd/OVERRIDES.md`
9. Do not commit manually — the system auto-commits

When done, say: "Override applied across all documents."
```

### 2.3 — Dispatch logic

**File:** `auto.ts` — `dispatchNextUnit()`

After pausing and appending the override (Phase 1.2), the next `dispatchNextUnit` call needs to:

1. Check `loadActiveOverrides(basePath)` — if any active overrides exist
2. Before dispatching the normal next unit, dispatch a `rewrite-docs` unit instead
3. Build the prompt with:
   - The active override content
   - A list of all documents that should be reviewed:
     - Active slice plan: `S##-PLAN.md`
     - All incomplete task plans: `T##-PLAN.md` where `[ ]` in slice plan
     - `DECISIONS.md`
     - `REQUIREMENTS.md` (if exists)
     - Milestone context: `M##-CONTEXT.md` (read-only reference, not rewritten)
     - `PROJECT.md` (if override changes project-level facts)
4. After the rewrite unit completes, continue normal dispatch

**Insert point in dispatchNextUnit (~line 1660):**
```typescript
// ── Override rewrite gate ──
const activeOverrides = loadActiveOverrides(basePath);
if (activeOverrides.length > 0) {
  unitType = "rewrite-docs";
  unitId = `${mid}/${state.activeSlice?.id ?? "global"}`;
  prompt = await buildRewriteDocsPrompt(mid, midTitle!, state.activeSlice, basePath, activeOverrides);
  // dispatch this unit, then normal flow resumes
}
```

### 2.4 — Post-rewrite cleanup

After the `rewrite-docs` unit completes in `handleAgentEnd`:
1. Verify each override in OVERRIDES.md is now marked `resolved`
2. If any remain active, log a warning but continue (don't loop)
3. Dispatch the normal next unit

---

## Phase 3: Guided Mode Support

### 3.1 — `/gsd steer` in guided (non-auto) mode

When not in auto-mode, `/gsd steer` should:
1. Append the override to OVERRIDES.md (same as auto-mode)
2. Send a message to the current session with the override content, similar to how `deliverAs: "steer"` works but also including: *"An override has been registered. Before continuing, read `.gsd/OVERRIDES.md` and update the current plan documents to reflect this change."*
3. The LLM handles the rewrite inline (no separate unit needed since it's interactive)

### 3.2 — Override visibility in `/gsd status`

**File:** `dashboard-overlay.ts` or status rendering

Add a section to the status dashboard showing active overrides:
```
⚠ Active Overrides (1):
  • Use Postgres instead of SQLite [issued during M001/S02/T03]
```

---

## File Change Summary

| File | Change Type | Description |
|------|------------|-------------|
| `commands.ts` | Edit | Add `steer` subcommand (~30 lines) |
| `files.ts` | Edit | Add `appendOverride()` and `loadActiveOverrides()` helpers (~60 lines) |
| `auto.ts` | Edit | Add `rewrite-docs` unit type support, override injection in prompt builders, dispatch gate (~120 lines) |
| `index.ts` | Edit | Add override injection in `buildTaskExecutionContextInjection` (~15 lines) |
| `prompts/execute-task.md` | Edit | Add `{{overridesSection}}` placeholder |
| `prompts/rewrite-docs.md` | New | Rewrite-docs unit prompt (~40 lines) |
| `prompts/plan-slice.md` | Edit | Add `{{overridesSection}}` placeholder |
| `prompts/replan-slice.md` | Edit | Add `{{overridesSection}}` placeholder |
| `prompts/complete-slice.md` | Edit | Add `{{overridesSection}}` placeholder |
| `prompts/research-slice.md` | Edit | Add `{{overridesSection}}` placeholder |
| `dashboard-overlay.ts` | Edit | Show active overrides in status (~15 lines) |
| `templates/overrides.md` | New | Template for OVERRIDES.md format |

**Estimated total:** ~300 lines of new/modified code

---

## Edge Cases & Considerations

1. **Multiple overrides before rewrite runs:** If user issues multiple overrides rapidly, all active overrides should be batched into a single `rewrite-docs` unit rather than one per override.

2. **Override conflicts:** If two overrides contradict each other, the rewrite agent should flag this and ask the user (via blocker mechanism) rather than guessing.

3. **Override during rewrite:** If user issues a new override while a `rewrite-docs` unit is running, it should be queued for the next rewrite pass, not injected mid-unit.

4. **Completed tasks:** Overrides must never modify completed (`[x]`) tasks or their summaries. The rewrite prompt is explicit about this.

5. **Cross-slice overrides:** An override might affect multiple slices (e.g., "use Postgres everywhere"). The rewrite unit should scan the entire active milestone, not just the current slice.

6. **Override scope:** Some overrides are slice-scoped (implementation detail change), others are milestone-scoped (architectural shift). The `rewrite-docs` prompt should handle both by scanning all relevant docs.

7. **Escape hatch:** If the rewrite makes things worse, the user can:
   - Git revert the rewrite commit (auto-mode commits after each unit)
   - Issue a new override correcting the rewrite
   - Manually edit docs while paused

---

## Implementation Order

1. **files.ts helpers** — `appendOverride()`, `loadActiveOverrides()`, OVERRIDES.md format
2. **commands.ts** — `/gsd steer` subcommand
3. **Override injection** — modify prompt builders in auto.ts and index.ts
4. **Template changes** — add `{{overridesSection}}` to prompt .md files
5. **rewrite-docs unit** — new unit type, prompt, dispatch logic
6. **Dashboard** — show overrides in status
7. **Tests** — unit tests for override parsing, injection, and dispatch gating
