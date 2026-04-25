# Small Feature Workflow

<template_meta>
name: small-feature
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: .gsd/workflows/features/
</template_meta>

<purpose>
Build a small-to-medium feature with lightweight planning. Designed for work that
needs more structure than /gsd quick but doesn't warrant full milestone ceremony.
Typical scope: a new command, endpoint, component, or module.
</purpose>

<phases>
1. scope      — Define what we're building and confirm boundaries
2. plan       — Break into 2-5 implementable tasks
3. implement  — Execute the plan with atomic commits
4. verify     — Run tests, build, and validate
</phases>

<process>

## Phase 1: Scope

**Goal:** Align on what to build and what's out of scope.

1. **Understand the request:** Clarify the feature's purpose and user-facing behavior
2. **Identify gray areas:** Surface 3-4 design decisions that need answers:
   - API shape / interface design
   - Where in the codebase this fits
   - What existing patterns to follow
   - Edge cases to handle (or explicitly skip)
3. **Define boundaries:** What's in scope vs out of scope for this workflow
4. **Produce:** Write a brief `CONTEXT.md` in the artifact directory with:
   - Feature description
   - Key decisions made
   - Scope boundaries

5. **Gate:** Confirm scope with user before planning.

## Phase 2: Plan

**Goal:** Create a clear, executable plan.

1. **Research (if needed):** Read relevant existing code to understand patterns
2. **Break into tasks:** 2-5 tasks, each independently committable:
   - Each task should take ~10-30 minutes of AI work
   - Include file paths and specific changes
   - Include verification steps per task
3. **Produce:** Write `PLAN.md` in the artifact directory

4. **Gate:** Present plan to user for approval. Adjust if needed.

## Phase 3: Implement

**Goal:** Build the feature following the plan.

1. Execute tasks in order
2. After each task:
   - Verify the specific task's acceptance criteria
   - Commit with message: `feat(<scope>): <description>`
3. If a task reveals the plan needs adjustment, note the deviation and adapt
4. Run incremental tests as you go (don't wait until the end)

## Phase 4: Verify

**Goal:** Ensure everything works together.

1. Run the full test suite
2. Run the build
3. Run the linter
4. Manual smoke check if applicable
5. **Produce:** Write a brief `SUMMARY.md` with:
   - What was built
   - Files changed
   - How to test/use the feature
6. Present summary to user

</process>
