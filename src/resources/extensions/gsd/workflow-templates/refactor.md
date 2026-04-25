# Refactor / Migration Workflow

<template_meta>
name: refactor
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: .gsd/workflows/refactors/
</template_meta>

<purpose>
Systematic code transformation with inventory-driven planning. Designed for
renames, restructures, pattern migrations, and API modernization. Executes in
waves to minimize risk and enable incremental verification.
</purpose>

<phases>
1. inventory — Catalog everything that needs to change
2. plan      — Group changes into safe waves
3. migrate   — Execute waves with verification between each
4. verify    — Full regression testing and cleanup
</phases>

<process>

## Phase 1: Inventory

**Goal:** Know the full scope before changing anything.

1. **Scan the codebase:** Find all instances of what needs to change
   - Files, functions, types, imports, tests, docs, config
   - Use grep/glob to be exhaustive — don't rely on memory
2. **Categorize:** Group by type (source, test, config, docs)
3. **Identify dependencies:** What order must changes happen in?
4. **Produce:** Write `INVENTORY.md` with:
   - Complete list of files/locations that need changes
   - Dependency relationships
   - Estimated scope (number of files, lines affected)

5. **Gate:** Review inventory with user. Confirm nothing is missing.

## Phase 2: Plan

**Goal:** Break the migration into safe, independently-verifiable waves.

1. **Define waves:** Group related changes so each wave:
   - Leaves the codebase in a working state
   - Can be committed and tested independently
   - Handles dependencies (change the definition before the consumers)
2. **Typical wave structure:**
   - Wave 1: Types/interfaces
   - Wave 2: Core implementation
   - Wave 3: Consumers/callers
   - Wave 4: Tests
   - Wave 5: Documentation and config
3. **Produce:** Write `PLAN.md` with waves and per-wave file lists

4. **Gate:** Confirm plan with user.

## Phase 3: Migrate

**Goal:** Execute waves one at a time with verification between each.

1. For each wave:
   - Make the changes
   - Run tests (at minimum, the build must pass)
   - Commit: `refactor(<scope>): wave N — <description>`
2. If a wave introduces failures, fix them before moving to the next wave
3. If unexpected scope is discovered, update the inventory and plan

## Phase 4: Verify

**Goal:** Ensure the full refactor is complete and clean.

1. Run the complete test suite
2. Run the build
3. Run the linter — fix any new warnings
4. Search for any remnants of the old pattern (grep for old names/patterns)
5. **Produce:** Write `SUMMARY.md` with:
   - What was changed and why
   - Files modified (count and list)
   - Any remaining follow-up items

</process>
