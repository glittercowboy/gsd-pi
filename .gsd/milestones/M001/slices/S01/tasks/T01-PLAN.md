---
estimated_steps: 5
estimated_files: 3
---

# T01: Implement verification gate types, preferences, and core logic

**Slice:** S01 — Built-in Verification Gate
**Milestone:** M001

## Description

Build the core verification gate: type definitions, preference keys, and the pure `runVerificationGate()` function. This is the foundational piece that S02–S05 and the auto.ts integration (T03) depend on. The gate discovers verification commands from three sources (preference override → task plan verify field → package.json scripts), runs them sequentially via `spawnSync`, and returns a structured result.

## Steps

1. **Add types to `types.ts`** — After the `TaskPlanEntry` interface (around line 48), add:
   ```ts
   /** Result of a single verification command execution */
   export interface VerificationCheck {
     command: string;       // e.g. "npm run lint"
     exitCode: number;      // 0 = pass
     stdout: string;
     stderr: string;
     durationMs: number;
   }

   /** Aggregate result from the verification gate */
   export interface VerificationResult {
     passed: boolean;              // true if all checks passed (or no checks discovered)
     checks: VerificationCheck[];  // per-command results
     discoverySource: "preference" | "task-plan" | "package-json" | "none";
     timestamp: number;            // Date.now() at gate start
   }
   ```

2. **Add preference keys to `preferences.ts`** — Three changes:
   - Add `"verification_commands"`, `"verification_auto_fix"`, `"verification_max_retries"` to the `KNOWN_PREFERENCE_KEYS` set (around line 52)
   - Add to `GSDPreferences` interface (around line 149):
     ```ts
     verification_commands?: string[];
     verification_auto_fix?: boolean;
     verification_max_retries?: number;
     ```
   - Add to `mergePreferences()` function (around line 737):
     ```ts
     verification_commands: mergeStringLists(base.verification_commands, override.verification_commands),
     verification_auto_fix: override.verification_auto_fix ?? base.verification_auto_fix,
     verification_max_retries: override.verification_max_retries ?? base.verification_max_retries,
     ```
   - Add validation in `validatePreferences()` (find the validation section, add type checks):
     - `verification_commands`: must be array of strings if present
     - `verification_auto_fix`: must be boolean if present
     - `verification_max_retries`: must be number >= 0 if present

3. **Create `verification-gate.ts`** — New file at `src/resources/extensions/gsd/verification-gate.ts`. Structure:
   - Import `spawnSync` from `child_process`, `existsSync`, `readFileSync` from `fs`, and types from `./types.ts`
   - `discoverCommands(options: { preferenceCommands?: string[], taskPlanVerify?: string, cwd: string }): { commands: string[], source: VerificationResult["discoverySource"] }` — implements the first-non-empty-wins discovery per D003:
     1. If `preferenceCommands` is non-empty array → return those, source = "preference"
     2. If `taskPlanVerify` is non-empty string → split on `&&`, trim each → return those, source = "task-plan"
     3. Read `package.json` at `cwd/package.json`. If it exists and has `scripts`, look for keys: `typecheck`, `lint`, `test`. For each that exists, add `npm run <name>`. Return those, source = "package-json"
     4. Otherwise return `[]`, source = "none"
   - `runVerificationGate(options: { basePath: string, unitId: string, cwd: string, preferenceCommands?: string[], taskPlanVerify?: string }): VerificationResult` — discovers commands, runs each via `spawnSync(command, { shell: true, cwd, stdio: 'pipe', encoding: 'utf-8' })`. Capture exit code (status), stdout, stderr, and duration. Aggregate into `VerificationResult`. `passed` = all exit codes are 0 (or no checks).
   - Export both functions (tests need `discoverCommands` too)

4. **Handle spawnSync edge cases:**
   - `spawnSync` returns `{ status, stdout, stderr, error }`. If `error` is set (e.g. command not found), treat as exit code 127 with error message in stderr
   - `status` can be `null` if killed by signal — treat as exit code 1
   - Truncate stdout/stderr to first 10KB each to prevent unbounded memory in results

5. **Validate compilation** — Run `npx --yes tsx src/resources/extensions/gsd/verification-gate.ts` to confirm imports resolve and types compile. Run `npm run test:unit -- --test-name-pattern "preferences-schema"` to confirm preference changes don't break existing validation tests.

## Must-Haves

- [ ] `VerificationCheck` and `VerificationResult` interfaces exported from `types.ts`
- [ ] `verification_commands`, `verification_auto_fix`, `verification_max_retries` in `KNOWN_PREFERENCE_KEYS`, `GSDPreferences`, `mergePreferences`, and `validatePreferences`
- [ ] `discoverCommands()` implements first-non-empty-wins: preference → task-plan → package.json → none
- [ ] `runVerificationGate()` runs discovered commands via `spawnSync`, captures exit codes, stdout, stderr
- [ ] Missing package.json / no scripts → returns passed=true with 0 checks
- [ ] spawnSync error (command not found) → treated as failure with exit code 127

## Verification

- `npx --yes tsx src/resources/extensions/gsd/verification-gate.ts` compiles without error
- `npm run test:unit -- --test-name-pattern "preferences-schema"` still passes
- Code review: `discoverCommands` follows D003 discovery order; `runVerificationGate` uses `spawnSync` not `execSync`

## Inputs

- `src/resources/extensions/gsd/types.ts` — existing interfaces file; add new interfaces after `TaskPlanEntry` (line ~48)
- `src/resources/extensions/gsd/preferences.ts` — existing preferences; follow exact patterns for KNOWN_PREFERENCE_KEYS (line 52), GSDPreferences (line 149), mergePreferences (line 737), validatePreferences (line 779)
- Decision D003: discovery order is preference → task plan → package.json, first-non-empty-wins

## Observability Impact

- **New signals:** `VerificationResult` struct returned from `runVerificationGate()` with per-command exit codes, stdout/stderr, and duration. `discoverySource` field tells downstream consumers which discovery path activated.
- **Inspection:** Call `discoverCommands()` with a cwd to see what commands the gate would run without executing them. Inspect `VerificationResult.checks` for per-command pass/fail after gate execution.
- **Failure visibility:** Failed commands produce `VerificationCheck` entries with non-zero `exitCode`, stderr content, and truncated stdout. `VerificationResult.passed === false` is the top-level failure signal.
- **Preference validation:** Invalid `verification_commands` / `verification_auto_fix` / `verification_max_retries` values produce validation errors surfaced in `LoadedGSDPreferences.warnings`.

## Expected Output

- `src/resources/extensions/gsd/verification-gate.ts` — new file exporting `discoverCommands` and `runVerificationGate`
- `src/resources/extensions/gsd/types.ts` — modified with `VerificationCheck` and `VerificationResult` interfaces
- `src/resources/extensions/gsd/preferences.ts` — modified with 3 new preference keys in 4 locations
