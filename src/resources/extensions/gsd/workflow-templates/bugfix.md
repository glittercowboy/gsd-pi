# Bugfix Workflow

<template_meta>
name: bugfix
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: .gsd/workflows/bugfixes/
</template_meta>

<purpose>
Fix a bug from identification through to PR submission. Designed for issues reported
via GitHub, user reports, or developer discovery. Emphasizes root cause analysis
before jumping to fixes.
</purpose>

<phases>
1. triage    — Identify root cause, reproduce the bug
2. fix       — Implement the fix with tests
3. verify    — Run full test suite, check for regressions
4. ship      — Create PR with detailed explanation
</phases>

<process>

## Phase 1: Triage

**Goal:** Understand the bug before touching any code.

1. **Gather context:**
   - If a GitHub issue was referenced, read the issue description, labels, and comments
   - Identify the expected behavior vs actual behavior
   - Note any error messages, stack traces, or reproduction steps provided

2. **Reproduce:**
   - Find the minimal reproduction path
   - Identify the affected code paths (files, functions, lines)
   - If the bug is intermittent, note the conditions that trigger it

3. **Root cause analysis:**
   - Trace the bug to its root cause (not just the symptom)
   - Identify when the bug was introduced if possible (git blame/log)
   - Assess blast radius: what else could be affected?

4. **Produce:** Write a brief `TRIAGE.md` in the artifact directory with:
   - Root cause explanation
   - Reproduction steps
   - Affected files/functions
   - Proposed fix approach

5. **Gate:** Present the triage findings and proposed fix to the user for confirmation.

## Phase 2: Fix

**Goal:** Implement a clean, tested fix.

1. **Plan the fix:** Write a brief plan (1-3 tasks max)
2. **Write the fix:** Implement the code change
3. **Write tests:** Add or update tests that:
   - Reproduce the original bug (test fails without fix)
   - Verify the fix works
   - Cover edge cases
4. **Commit:** Atomic commit with message: `fix(<scope>): <description>`

## Phase 3: Verify

**Goal:** Ensure the fix doesn't break anything else.

1. Run the project's full test suite
2. Run the build (if applicable)
3. Run the linter (if applicable)
4. Check for regressions in related functionality
5. If any failures, fix them before proceeding

## Phase 4: Ship

**Goal:** Create a well-documented PR.

1. Ensure all changes are committed on the workflow branch
2. Build the PR body:
   - Link to the original issue (if applicable)
   - Explain the root cause
   - Describe the fix approach
   - List the test coverage added
3. Present the PR details to the user for review
4. Create the PR via `gh pr create` (with user approval)

</process>
