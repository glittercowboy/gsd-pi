# API Breaking Change Workflow

<template_meta>
name: api-breaking-change
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: .gsd/workflows/api-breaks/
</template_meta>

<purpose>
Remove or redesign a public API in a controlled way. Surveys all callers,
migrates them, deprecates the old surface, and schedules the removal release.
Built for APIs consumed by other modules in the repo AND by external
dependents where feasible.
</purpose>

<phases>
1. survey     — Identify all callers, draft the new design
2. migrate    — Land the new API and migrate internal callers
3. deprecate  — Mark the old API deprecated, communicate the change
4. release    — Remove the old API in a future release
</phases>

<process>

## Phase 1: Survey

**Goal:** Understand the blast radius before touching anything.

1. **Identify the old API:**
   - What's the symbol/route/contract? Where is it defined?
   - Is it internal-only, exported to the SDK, or a public network endpoint?

2. **Map callers:**
   - Internal: `grep` the symbol across the repo. List every call site with
     file:line.
   - External (if applicable): check the package registry for direct
     dependents, look for GitHub code search results, check the docs.

3. **Draft the new shape:**
   - What's changing? (rename, signature change, semantic change?)
   - What's the migration pattern for a typical caller?
   - Can callers migrate incrementally, or is it all-or-nothing?

4. **Produce `SURVEY.md`** with:
   - Old signature vs new signature.
   - Full caller list (internal + best-effort external).
   - Migration difficulty per caller type.
   - Timeline proposal: deprecate in release X, remove in release Y.

5. **Gate:** Review the survey with the user. This is the "do we actually want
   to do this?" checkpoint. Don't proceed if the blast radius is larger than
   the benefit.

## Phase 2: Migrate

**Goal:** Land the new API and move internal callers to it.

1. **Introduce the new API alongside the old one:**
   - Export the new function/class/endpoint.
   - The old API still works unchanged.
   - Add tests for the new API.

2. **Migrate internal callers:**
   - One file at a time, atomic commits: `refactor(api): migrate <caller> to <new-api>`.
   - Run tests after each batch.

3. **Add a feature flag** if helpful — some callers may need runtime toggles
   during a staged rollout.

4. **Gate:** All internal callers migrated, tests green. Confirm before
   proceeding to the deprecation phase.

## Phase 3: Deprecate

**Goal:** Tell external callers to migrate.

1. **Mark the old API deprecated:**
   - Add `@deprecated` JSDoc / language-equivalent annotations.
   - Log a runtime deprecation warning on first use (if feasible and the
     language supports it). Include the migration path in the message.

2. **Update docs:**
   - Changelog: a prominent `### Deprecated` section with migration guidance.
   - README / API docs: note the deprecation timeline.
   - If there's a `MIGRATIONS.md`, add an entry.

3. **Communicate:**
   - Draft a release-notes entry with before/after code examples.
   - If the API has external users, draft an issue or blog post.

4. **Ship** the deprecation release (coordinate with `/gsd workflow release`).

5. **Gate:** Deprecation is live, callers have had time to migrate. Decide
   the removal timeline (typically next minor or next major).

## Phase 4: Release (removal)

**Goal:** Delete the old API in a future release.

1. **Verify ecosystem readiness:**
   - Have internal consumers upgraded?
   - Have known external consumers upgraded? If not, is it OK to force it?

2. **Remove the old API:**
   - Delete the deprecated code paths.
   - Update tests.
   - Update docs to remove references.

3. **Release** as part of a major version bump (semver). Document the removal
   prominently in the changelog.

4. **Close the loop:** update `SURVEY.md` with the final outcome — what
   shipped, what's still outstanding, any lessons learned.

</process>
