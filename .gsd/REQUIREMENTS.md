# Requirements

This file is the explicit capability and coverage contract for the project.

## Active

### R001 — Fetch model registry from models.dev
- Class: core-capability
- Status: active
- Description: Model data is fetched from https://models.dev/api.json at runtime instead of being statically compiled
- Why it matters: Keeps model registry current without code releases; new models available immediately
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S02
- Validation: unmapped
- Notes: Must handle network failures gracefully

### R002 — 12-hour cache with fallback on network failure
- Class: quality-attribute
- Status: active
- Description: Fetched model data is cached locally for ~12 hours; network failures fall back to cached data even if stale
- Why it matters: Reduces network requests, enables offline use, graceful degradation
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: unmapped
- Notes: Cache file stored in ~/.gsd/agent/cache/

### R003 — Version-triggered cache refresh
- Class: core-capability
- Status: active
- Description: When gsd-2 version changes, the cache is force-refreshed on next startup
- Why it matters: New releases may need updated model data; ensures consistency
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: unmapped
- Notes: Compare cached version with current VERSION

### R004 — Bundled snapshot for offline-first cold start
- Class: quality-attribute
- Status: active
- Description: A snapshot of models.dev data is bundled at build time for offline/fresh-install use
- Why it matters: Fresh installs work without network; faster cold start
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: none
- Validation: unmapped
- Notes: Generated at build time from models.dev

### R005 — Preserve local models.json override capability
- Class: core-capability
- Status: active
- Description: Users can still override/add models via ~/.gsd/agent/models.json
- Why it matters: Custom providers, local models, and overrides must continue to work
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: unmapped
- Notes: Existing ModelRegistry merge logic preserved

### R006 — Remove models.generated.ts and generation script
- Class: operability
- Status: active
- Description: The static models.generated.ts file and any generation scripts are removed
- Why it matters: Eliminates stale generated code, simplifies build
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: none
- Validation: unmapped
- Notes: Verify no references remain

## Validated

(none yet)

## Deferred

(none)

## Out of Scope

(none)

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | core-capability | active | M001/S01 | M001/S02 | unmapped |
| R002 | quality-attribute | active | M001/S01 | none | unmapped |
| R003 | core-capability | active | M001/S01 | none | unmapped |
| R004 | quality-attribute | active | M001/S03 | none | unmapped |
| R005 | core-capability | active | M001/S02 | none | unmapped |
| R006 | operability | active | M001/S03 | none | unmapped |

## Coverage Summary

- Active requirements: 6
- Mapped to slices: 6
- Validated: 0
- Unmapped active requirements: 0
