# Hotfix Workflow

<template_meta>
name: hotfix
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: null
</template_meta>

<purpose>
Minimal ceremony for urgent fixes. Fix it, test it, ship it. No planning artifacts,
no research phase, no lengthy documentation. For when production is broken and
speed matters.
</purpose>

<phases>
1. fix  — Identify and fix the issue
2. ship — Test, commit, and create PR
</phases>

<process>

## Phase 1: Fix

**Goal:** Find and fix the issue as fast as possible.

1. Identify the broken behavior
2. Locate the root cause
3. Implement the minimal fix
4. Add a regression test if possible (don't block on this if the fix is urgent)
5. Commit: `fix(<scope>): <description>`

## Phase 2: Ship

**Goal:** Get the fix deployed.

1. Run tests — fix any failures
2. Run the build
3. Push and create PR with:
   - What broke
   - What the fix does
   - How to verify
4. Present PR to user for approval

</process>
