# Requirements

This file is the explicit capability and coverage contract for the project.

## Active

### R001 - Fetch model registry from models.dev
- Class: core-capability
- Status: validated
- Description: Model data is fetched from https://models.dev/api.json at runtime instead of being statically compiled
- Why it matters: Keeps model registry current without code releases; new models available immediately
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S02
- Validation: S01 - Unit tests prove fetch with 10s timeout works (contract-level)
- Notes: Must handle network failures gracefully

### R002 - 12-hour cache with fallback on network failure
- Class: quality-attribute
- Status: validated
- Description: Fetched model data is cached locally for ~12 hours; network failures fall back to cached data even if stale
- Why it matters: Reduces network requests, enables offline use, graceful degradation
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: S01 - Unit tests prove 12h TTL and fallback chain (contract-level)
- Notes: Cache file stored in ~/.gsd/agent/cache/

### R003 - Version-triggered cache refresh
- Class: core-capability
- Status: validated
- Description: When gsd-2 version changes, the cache is force-refreshed on next startup
- Why it matters: New releases may need updated model data; ensures consistency
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: S01 - Unit tests prove version comparison triggers refresh (contract-level)
- Notes: Compare cached version with current VERSION

### R004 - Bundled snapshot for offline-first cold start
- Class: quality-attribute
- Status: validated
- Description: A snapshot of models.dev data is bundled at build time for offline/fresh-install use
- Why it matters: Fresh installs work without network; faster cold start
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: none
- Validation: S03 - Snapshot file committed, generation script works, fallback verified
- Notes: Generated via `npm run generate-snapshot`

### R005 - Preserve local models.json override capability
- Class: core-capability
- Status: validated
- Description: Users can still override/add models via ~/.gsd/agent/models.json
- Why it matters: Custom providers, local models, and overrides must continue to work
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: S02 - Implementation proves provider-level and per-model overrides work with models.dev data
- Notes: Existing ModelRegistry merge logic preserved

### R006 - Remove models.generated.ts and generation script
- Class: operability
- Status: validated
- Description: The static models.generated.ts file and any generation scripts are removed
- Why it matters: Eliminates stale generated code, simplifies build
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: none
- Validation: S03 - File deleted, grep shows no source references
- Notes: Replaced by models-dev-snapshot.ts with different generation script

### R007 - Registry path build/test workflow must be trustworthy
- Class: operability
- Status: validated
- Description: The model-registry-related code path can be built and tested through the project's standard workflows without the current registry-specific build or resolver failures
- Why it matters: Test files and verification only count if the normal workflow can actually run them
- Source: user
- Primary owning slice: M002/S01
- Supporting slices: none
- Validation: S01 - npm run build and npm test succeed with all 31 tests passing
- Notes: Includes repairing registry-path-specific import, type, and test-runner seams as needed

### R008 - Registry behavior must be proven through production-like startup scenarios
- Class: quality-attribute
- Status: validated
- Description: Model registry behavior is verified using production-like filesystem and startup scenarios covering fresh state, cache hit, stale cache, version change, snapshot fallback, offline behavior, and models.json overrides
- Why it matters: Contract-level unit tests alone do not prove the real startup path behaves correctly
- Source: user
- Primary owning slice: M002/S02
- Supporting slices: none
- Validation: S02 - Nine scenario tests pass with tmpdir isolation covering all lifecycle scenarios
- Notes: Prefer temporary home/cache/models.json setups over deep mocks where practical

### R009 - Live models.dev verification in main suite
- Class: quality-attribute
- Status: active
- Description: The main test suite includes live verification against models.dev as part of registry-path coverage
- Why it matters: Upstream compatibility should be checked against the real service, not only fixtures
- Source: user
- Primary owning slice: M002
- Supporting slices: none
- Validation: Pending - main suite runs live models.dev verification with explicit failure surface
- Notes: This intentionally accepts network-dependent test behavior by user choice

### R010 - Model registry path quality hardening
- Class: operability
- Status: active
- Description: Code review findings in the model registry path are addressed with targeted cleanup and refactoring where needed to improve correctness, maintainability, and observability without changing intended behavior
- Why it matters: Better tests alone are not enough if the underlying design remains brittle or misleading
- Source: user
- Primary owning slice: M002
- Supporting slices: none
- Validation: Pending - review findings resolved and revised code proven by the stronger verification path
- Notes: Scope includes adjacent infrastructure only when necessary to harden the registry path

### R011 - Reconcile milestone work with current upstream mainline
- Class: operability
- Status: active
- Description: Local milestone work is reconciled with the current `gsd-build/gsd-2` upstream `main` branch without regressing the intended behavior delivered by M001 and completed M002 work
- Why it matters: The registry work must be upstreamable against the real current codebase, not only correct on a stale local branch
- Source: user
- Primary owning slice: M003
- Supporting slices: none
- Validation: Pending - reconciled branch proves M001/M002 behavior still holds after integrating current upstream main
- Notes: Includes conflict resolution and bounded proactive alignment to upstream conventions where materially beneficial

### R012 - Leave reconciled work in verified PR-ready state
- Class: operability
- Status: active
- Description: After upstream reconciliation, the branch is buildable, testable, reviewable, and locally ready to become a pull request without additional restructuring
- Why it matters: A successful merge is not enough if the resulting branch is noisy, unverified, or difficult to review upstream
- Source: user
- Primary owning slice: M003
- Supporting slices: none
- Validation: Pending - relevant verification workflows pass and the reconciled diff is coherent for review
- Notes: Does not include opening the GitHub pull request itself

## Validated

- R001 — Fetch model registry from models.dev (S01: contract-level unit tests)
- R002 — 12-hour cache with fallback (S01: contract-level unit tests)
- R003 — Version-triggered cache refresh (S01: contract-level unit tests)
- R004 — Bundled snapshot for offline-first cold start (S03: snapshot file + generation script + fallback verified)
- R005 — Preserve local models.json override capability (S02: implementation + code review)
- R006 — Remove models.generated.ts and generation script (S03: file deleted, no source references)
- R007 — Registry path build/test workflow must be trustworthy (M002/S01: npm run build && npm test succeed)
- R008 — Registry behavior proven through production-like scenarios (M002/S02: 9 scenario tests with tmpdir isolation)

## Deferred

(none)

## Out of Scope

(none)

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | core-capability | validated | M001/S01 | M001/S02 | S01 unit tests |
| R002 | quality-attribute | validated | M001/S01 | none | S01 unit tests |
| R003 | core-capability | validated | M001/S01 | none | S01 unit tests |
| R004 | quality-attribute | validated | M001/S03 | none | S03 snapshot + generation script |
| R005 | core-capability | validated | M001/S02 | none | S02 implementation + code review |
| R006 | operability | validated | M001/S03 | none | S03 file deletion + grep verification |
| R007 | operability | validated | M002/S01 | none | S01 build + test workflow |
| R008 | quality-attribute | validated | M002/S02 | none | S02 9 scenario tests |
| R009 | quality-attribute | active | M002 | none | Pending |
| R010 | operability | active | M002 | none | Pending |
| R011 | operability | active | M003 | none | Pending |
| R012 | operability | active | M003 | none | Pending |

## Coverage Summary

- Active requirements: 4
- Mapped to slices: 12
- Validated: 8
- Unmapped active requirements: 0
