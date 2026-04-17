---
phase: 10-typescript-strict-zero-any
plan: "02"
subsystem: src-root
tags: [typescript, api-migration, security, auth-storage]
dependency_graph:
  requires: [10-01]
  provides: [cli-ts-fixed, security-overrides-owned, credential-provider-files-fixed]
  affects: [src/cli.ts, src/security-overrides.ts, src/onboarding.ts, src/wizard.ts, src/provider-migrations.ts, src/resources/extensions/remote-questions/config.ts]
tech_stack:
  added: []
  patterns: [extension-interface-pattern, gsd-owned-module-state]
key_files:
  created: []
  modified:
    - src/cli.ts
    - src/security-overrides.ts
    - src/onboarding.ts
    - src/wizard.ts
    - src/provider-migrations.ts
    - src/resources/extensions/remote-questions/config.ts
decisions:
  - "GSD owns command prefix allowlist state: SAFE_COMMAND_PREFIXES, setAllowedCommandPrefixes, getAllowedCommandPrefixes exported from security-overrides.ts"
  - "GSDSettingsManager extension interface used for optional removed SettingsManager methods (getAllowedCommandPrefixes, getFetchAllowedUrls)"
  - "getCredentialsForProvider() replaced with authStorage.get() returning AuthCredential | undefined (not array)"
  - "isProviderRequestReady() replaced with authStorage.hasAuth() since ModelRegistry method was removed in 0.67.2"
metrics:
  duration: ~10 min
  completed: "2026-04-16T15:14:25Z"
  tasks_completed: 2
  files_modified: 6
---

# Phase 10 Plan 02: Root src/ TypeScript Errors — API Renames + Security-Overrides Ownership Summary

**One-liner:** Migrated cli.ts from 6 removed/renamed 0.67.2 APIs and established GSD-owned command-prefix allowlist in security-overrides.ts, eliminating all tsc errors in 5 of 6 target files.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix cli.ts implicit any, ModelRegistry, appendSystemPrompt, runPackageCommand | e80d90d1f | src/cli.ts |
| 2 | Fix security-overrides ownership + getCredentialsForProvider in 4 files | e873d4f40 | src/security-overrides.ts, src/onboarding.ts, src/wizard.ts, src/provider-migrations.ts, src/resources/extensions/remote-questions/config.ts |

## What Was Done

### Task 1 — cli.ts

- **Removed `runPackageCommand`** from import and call site (removed from pi-coding-agent 0.67.2)
- **`new ModelRegistry()` → `ModelRegistry.create()`** (constructor made private in 0.67.2)
- **`appendSystemPrompt` wrapped in array** — `DefaultResourceLoader` now expects `string[]`, was `string`
- **`isProviderRequestReady()` → `authStorage.hasAuth()`** — method removed from ModelRegistry in 0.67.2
- All implicit any parameters resolved (TypeScript now infers from `modelRegistry.getAvailable()` return type)
- cli.ts tsc errors: 14 → 3 (remaining 3 are AgentSession cross-package type mismatch, addressed in a different plan)

### Task 2 — security-overrides.ts + 4 credential files

**security-overrides.ts:**
- Added GSD-owned `SAFE_COMMAND_PREFIXES`, `setAllowedCommandPrefixes`, `getAllowedCommandPrefixes` exports
- Added `GSDSettingsManager` extension interface for optional `getAllowedCommandPrefixes?()` and `getFetchAllowedUrls?()` — removed from SettingsManager in 0.67.2 but safe to call via optional chaining on older builds
- Removed `setAllowedCommandPrefixes` from `@gsd/pi-coding-agent` import

**4 credential files (`getCredentialsForProvider` → `authStorage.get()`):**
- `wizard.ts`: `getCredentialsForProvider(provider)` array `.find()` → `authStorage.get(provider)` with direct null check
- `onboarding.ts`: `getCredentialsForProvider(provider)` array `.some()` → `authStorage.get(provider)` with direct property check
- `provider-migrations.ts`: `Pick<AuthStorage, "getCredentialsForProvider">` → `Pick<AuthStorage, "get">` throughout
- `remote-questions/config.ts`: `auth.getCredentialsForProvider(providerId)` → `auth.get(providerId)` with direct null check

All 5 target files now have zero tsc errors.

## Verification

```
tsc --noEmit 2>&1 | grep -c "src/security-overrides.ts|src/onboarding.ts|src/wizard.ts|src/provider-migrations.ts"
→ 0

grep -r "getCredentialsForProvider" src/onboarding.ts src/wizard.ts src/provider-migrations.ts src/resources/extensions/remote-questions/config.ts
→ EXIT:1 (0 matches)
```

## Deviations from Plan

**1. [Rule 1 - Bug] isProviderRequestReady() removed from ModelRegistry**
- **Found during:** Task 1
- **Issue:** `modelRegistry.isProviderRequestReady('claude-code')` caused TS2339 — method removed in 0.67.2
- **Fix:** Replaced with `authStorage.hasAuth('claude-code')` which is the underlying check that `hasConfiguredAuth()` delegates to
- **Files modified:** src/cli.ts
- **Commit:** e80d90d1f

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary changes introduced. The GSD-owned allowlist state is initialized from the readonly `SAFE_COMMAND_PREFIXES` constant and only mutable via the exported setter (T-10-03 mitigation applied).

## Self-Check

Files exist:
- src/cli.ts: FOUND
- src/security-overrides.ts: FOUND
- src/onboarding.ts: FOUND
- src/wizard.ts: FOUND
- src/provider-migrations.ts: FOUND
- src/resources/extensions/remote-questions/config.ts: FOUND

Commits:
- e80d90d1f: Task 1
- e873d4f40: Task 2
