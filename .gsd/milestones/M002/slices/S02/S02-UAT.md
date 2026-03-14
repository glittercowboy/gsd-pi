# S02: Production-Like Scenario Testing — UAT

**Milestone:** M002
**Written:** 2026-03-14

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: This slice delivers automated tests with clear pass/fail criteria. The verification is fully captured by test execution output.

## Preconditions

- `@gsd/pi-ai` package built successfully
- `@gsd/pi-coding-agent` package built successfully
- Node.js runtime available with `--test` flag support

## Smoke Test

```bash
node --test packages/pi-coding-agent/dist/core/model-registry-scenario.test.js
```

**Expected:** 9 tests pass, 0 fail, output shows TAP format with ✔ marks

## Test Cases

### 1. Fresh Install Scenario

1. Run scenario test suite
2. **Expected:** Test "falls back to snapshot or static MODELS when cache doesn't exist" passes with ✔

### 2. Cache Hit Scenario

1. Run scenario test suite
2. **Expected:** Tests "uses cached models.dev data when cache is valid" and "preserves models.dev data fields in cache hit" both pass

### 3. Stale Cache Scenario

1. Run scenario test suite
2. **Expected:** Test "gracefully handles stale cache (fetchedAt > 12h ago)" passes

### 4. Version Mismatch Scenario

1. Run scenario test suite
2. **Expected:** Test "handles version-triggered refresh when cache version doesn't match" passes

### 5. Offline Fallback Scenario

1. Run scenario test suite
2. **Expected:** Test "uses stale cache when network is unavailable" passes

### 6. Override Application Scenario

1. Run scenario test suite
2. **Expected:** Tests "applies provider-level baseUrl override", "applies per-model override", and "applies both provider and per-model overrides together" all pass

## Edge Cases

### Test Isolation Verification

1. Run `grep -r "homedir()" packages/pi-coding-agent/src/core/model-registry-scenario.test.ts`
2. **Expected:** No matches (exit code 1), proving tests never write to user's home directory

### Repeatability Check

1. Run test suite 3 consecutive times
2. **Expected:** All 9 tests pass each time, no flakiness from async timing

## Failure Signals

- Any test shows `✖` or `fail N` where N > 0
- Test output mentions `homedir()` or `~/.gsd/agent/` (indicates isolation failure)
- Tests fail intermittently across multiple runs (indicates async timing issues)

## Requirements Proved By This UAT

- R008 — Production-like startup scenarios verified through 6 scenario suites covering fresh state, cache hit, stale cache, version change, offline behavior, and models.json overrides

## Not Proven By This UAT

- Live models.dev API verification (S03)
- Production network conditions (tests simulate network failure via fetch rejection)
- Real user home directory behavior (tests use tmpdir isolation by design)

## Notes for Tester

- This slice is test-only; no user-facing features were added
- The 500ms delay after ModelRegistry instantiation allows async refresh to settle — if tests become flaky, this is the first place to investigate
- Merge conflict markers were found and fixed in pi-ai test files during execution, but this was unrelated to the slice's core deliverable
