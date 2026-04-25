# Dependency Upgrade Workflow

<template_meta>
name: dep-upgrade
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: .gsd/workflows/upgrades/
</template_meta>

<purpose>
Upgrade project dependencies safely. Assess breaking changes before upgrading,
fix issues incrementally, and verify everything works. Handles both single-package
upgrades and bulk dependency refresh.
</purpose>

<phases>
1. assess  — Analyze what's outdated and what will break
2. upgrade — Apply upgrades incrementally
3. fix     — Resolve breaking changes
4. verify  — Full test suite and build validation
</phases>

<process>

## Phase 1: Assess

**Goal:** Know what you're getting into before changing versions.

1. **List outdated dependencies:** Run `npm outdated` / equivalent
2. **For each target upgrade:**
   - Read the changelog / release notes
   - Identify breaking changes
   - Check for known migration guides
   - Assess impact on the codebase (grep for affected APIs)
3. **Prioritize:** Which upgrades to do now, which to defer
4. **Produce:** Write `ASSESSMENT.md` with:
   - Dependency list with current → target versions
   - Breaking changes per dependency
   - Upgrade order (dependencies before dependents)
   - Risk assessment

5. **Gate:** Review assessment with user. Confirm upgrade scope.

## Phase 2: Upgrade

**Goal:** Apply version bumps incrementally.

1. Upgrade one dependency (or one group of related dependencies) at a time
2. Run tests after each upgrade
3. Commit each upgrade: `chore(deps): upgrade <package> to <version>`
4. If tests fail, move to Phase 3 for that dependency before continuing

## Phase 3: Fix

**Goal:** Resolve any breaking changes from upgrades.

1. Fix API changes, type errors, deprecations
2. Update configuration if needed
3. Commit fixes separately from the upgrade: `fix(deps): adapt to <package> v<version> changes`

## Phase 4: Verify

**Goal:** Ensure everything works together.

1. Run the full test suite
2. Run the build
3. Run the linter
4. Check for deprecation warnings in output
5. **Produce:** Write `SUMMARY.md` with:
   - Dependencies upgraded (from → to)
   - Breaking changes encountered and how they were resolved
   - Any deferred upgrades and why

</process>
