---
phase: 08-breaking-api-migrations
plan: 05
subsystem: gsd-agent-modes/tool-execution
tags: [edit-tool, diff-preview, compile-gate, phase-08-complete]
depends_on:
  requires: [08-01c, 08-02, 08-03, 08-04]
  provides: [TOOL-01, TOOL-02, phase-08-gate]
  affects: [tool-execution.ts]
tech_stack:
  added: []
  patterns: [edits-array-validation, async-diff-preview]
key_files:
  created: []
  modified:
    - packages/gsd-agent-modes/src/modes/interactive/components/tool-execution.ts
decisions:
  - Use computeEditDiff per-edit (first edit) since computeEditsDiff is not exported from pi-coding-agent barrel
  - Validate edits[] elements with type guards before passing to computeEditDiff (T-08-08 mitigation)
metrics:
  duration: 8m
  completed: "2026-04-16T11:23:14Z"
  tasks_completed: 2
  files_modified: 1
---

# Phase 08 Plan 05: Update maybeComputeEditDiff for edits[] format and verify Phase 08 gate

One-liner: maybeComputeEditDiff now handles multi-edit edits[] array format with type-safe validation, completing TOOL-01 and the Phase 08 compile gate.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Update maybeComputeEditDiff for edits[] format and confirm TOOL-02 | b111f56b8 | tool-execution.ts |
| 2 | Run full Phase 08 verification gates | (no files changed) | — |

## What Was Built

**TOOL-01 — edits[] format handling in maybeComputeEditDiff:**

`maybeComputeEditDiff()` previously only handled single-edit format (`args.oldText` + `args.newText`). Added an `else if (Array.isArray(edits))` branch that:

1. Type-narrows each element to `{ oldText: string; newText: string }` before use (satisfying T-08-08 threat mitigation — untrusted LLM input)
2. Calls `computeEditDiff(path, firstValidEdit.oldText, firstValidEdit.newText, cwd)` for preview of the first edit
3. Post-execution diff (from `result.details.diff`) covers all edits as before

Note: `computeEditsDiff` is exported from `edit-diff.ts` but not re-exported from the pi-coding-agent barrel (`index.ts`). Since pi packages are read-only, we preview the first edit using the available `computeEditDiff` export.

**TOOL-02 — confirmed:**
`grep -rn "prepareArguments" packages/gsd-agent-core/src/ packages/gsd-agent-modes/src/` returns zero matches. No GSD-owned code needs the `prepareArguments` hook.

**Phase 08 verification gates:**
- SC-1: 0 matches for `session_switch|session_fork` across all 3 packages
- SC-2: 0 actual code instantiations of `new ModelRegistry` (one JSDoc comment only)
- SC-3: 0 matches for `session_directory` across all 3 packages
- SC-4: `tsc --noEmit` exits 0 on both gsd-agent-core and gsd-agent-modes
- SC-5: `.planning/session-migration-trace.md` exists

## Decisions Made

1. **computeEditDiff over computeEditsDiff for multi-edit preview:** `computeEditsDiff` is not exported from `@gsd/pi-coding-agent` barrel. Since pi packages are read-only, we call `computeEditDiff` on the first valid edit. The post-execution diff from `result.details.diff` always covers all edits.

2. **Type guard validation before computeEditDiff call:** Each element in `args.edits` is type-narrowed with `typeof e.oldText === "string" && typeof e.newText === "string"` before use, satisfying T-08-08 (untrusted LLM input at tool argument parsing boundary).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] computeEditsDiff not exported from pi-coding-agent barrel**
- **Found during:** Task 1
- **Issue:** `computeEditsDiff` is defined in `edit-diff.ts` but only `computeEditDiff` is re-exported from `packages/pi-coding-agent/src/index.ts`. Adding it to the barrel would require modifying a pi package (prohibited).
- **Fix:** Used `computeEditDiff` on the first valid edit in the edits[] array. This gives a useful preview and the post-execution `result.details.diff` covers all edits.
- **Files modified:** tool-execution.ts only
- **Commit:** b111f56b8

## Phase 08 Completion Status

All Phase 08 success criteria are satisfied:
- TOOL-01: edits[] format handled in maybeComputeEditDiff
- TOOL-02: confirmed — no GSD code needs prepareArguments
- SC-1 through SC-5: all pass
- Compile gate: tsc --noEmit exits 0 on gsd-agent-core and gsd-agent-modes

## Known Stubs

None.

## Threat Flags

None — T-08-08 mitigated by Array.isArray check and per-element type guards.

## Self-Check: PASSED

- `b111f56b8` exists in git log
- tool-execution.ts contains `this.args?.edits` at line 342
- tsc --noEmit passes on gsd-agent-modes and gsd-agent-core
