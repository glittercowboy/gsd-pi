# M002: Model Registry Hardening and Real-Scenario Verification

**Vision:** Trust that the model registry works under realistic conditions through production-like testing, repaired build infrastructure, and live verification against models.dev.

## Success Criteria

- Standard `npm run build` and `npm test` workflows execute registry-path verification without import or type errors
- Starting from a production-like temporary home directory with no cache exercises the real registry startup path and yields correct behavior for cache hit, stale cache, version change, and offline fallback scenarios
- The main test suite includes at least one test that fetches from the live models.dev API and validates response structure, with clear diagnostics distinguishing network failures from assertion failures
- Registry-path tests use temporary directories instead of mutating `~/.gsd/agent/`, making tests repeatable and isolated

## Key Risks / Unknowns

- **Build infrastructure repairs may expose deeper issues** — The `.ts` extension imports and nullability bug are known, but fixing them may reveal additional test-runner or package-resolution problems that compound the work.
- **Live models.dev tests may be flaky in CI** — Network or upstream instability can fail CI unless failures are clearly diagnosed and the test has appropriate timeout/retry expectations.
- **Production-like scenario tests require proper async synchronization** — The current tests use `setTimeout()` delays which are fragile; a more deterministic mechanism may be needed for async refresh completion.

## Proof Strategy

- **Build infrastructure repairs may expose deeper issues** → retire in S01 by proving that `npm run build` succeeds in `@gsd/pi-ai` and all existing registry-path tests pass through standard test runner invocation.
- **Live models.dev tests may be flaky in CI** → retire in S03 by proving the live test runs successfully against real models.dev with clear failure diagnostics and appropriate timeout (30s).
- **Production-like scenario tests require proper async synchronization** → retire in S02 by proving all scenario tests pass reliably with temporary directory isolation and deterministic async handling.

## Verification Classes

- Contract verification: Unit tests for cache/fetch functions (existing), mapper tests (existing after import fix), scenario tests (new in S02)
- Integration verification: Real ModelRegistry startup path with temporary home/cache setups (S02), live models.dev fetch (S03)
- Operational verification: Standard build/test workflow executes registry-path verification (S01), live verification runs in main suite (S03)
- UAT / human verification: None required — all verification is automated

## Milestone Definition of Done

This milestone is complete only when all are true:

- All slice deliverables are complete (S01, S02, S03 all [x])
- `npm run build` succeeds in `@gsd/pi-ai` without TypeScript errors
- `npm test` in `@gsd/pi-ai` executes all registry-path tests including mapper tests
- Production-like scenario tests pass using temporary directories, proving real startup behavior
- Live models.dev verification test runs in main suite with clear diagnostics
- Registry-path tests no longer mutate `~/.gsd/agent/` during execution

## Requirement Coverage

- Covers: R007 (build/test workflow trustworthy), R008 (production-like scenarios), R009 (live models.dev verification), R010 (code quality hardening)
- Partially covers: none
- Leaves for later: none
- Orphan risks: none

## Slices

- [x] **S01: Build/Test Infrastructure Repair** `risk:high` `depends:[]`
  > After this: `npm run build` and `npm test` succeed in `@gsd/pi-ai`, enabling all downstream registry-path verification work.

- [ ] **S02: Production-Like Scenario Testing** `risk:high` `depends:[S01]`
  > After this: New integration tests prove the real ModelRegistry startup path works across fresh install, cache hit, stale cache, version change, offline fallback, and override scenarios using temporary directories.

- [ ] **S03: Live models.dev Verification** `risk:medium` `depends:[S01]`
  > After this: Main test suite includes live verification against models.dev API with schema validation and clear failure diagnostics.

## Boundary Map

### S01 → S02

Produces:
- Compilable `@gsd/pi-ai` package with working test runner
- Fixed nullability in `models-dev.ts` (cache.data access after validity check)
- Test files using `.js` import specifiers compatible with Node16 module resolution

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- Same as above — working build/test infrastructure

Consumes:
- nothing (first slice)

### S02 → (downstream milestones)

Produces:
- Test pattern for production-like registry verification using temporary directories
- Deterministic async test completion mechanism for background refresh
- Coverage of all lifecycle scenarios: fresh, cached, stale, version-mismatch, offline, override

Consumes:
- S01's fixed build/test infrastructure

### S03 → (downstream milestones)

Produces:
- Live models.dev verification test with clear diagnostics
- Schema validation against real API response structure

Consumes:
- S01's fixed build/test infrastructure
- Existing `ModelsDevData` Zod schema for validation
