# S06: Structured LLM Tools + /gsd inspect — UAT

**Milestone:** M004
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All deliverables are pure functions or DB-write contracts testable via the automated test suite. The `/gsd inspect` output format is validated by 32 assertions in gsd-inspect.test.ts. The tool DB-write contracts are validated by 35 assertions in gsd-tools.test.ts. No runtime UI session is required to prove the contracts.

## Preconditions

1. Working directory is the M004 worktree: `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/M004`
2. Node.js v22.5+ (v25.5.0 is present — node:sqlite built-in, no extra flags needed)
3. `npx tsc --noEmit` passes clean
4. `npm test` passes (excluding pre-existing pack-install.test.ts failure)

## Smoke Test

Run the tool assertion count check — if both numbers are ≥ 3, the registrations are present:

```bash
grep -c "gsd_save_decision\|gsd_update_requirement\|gsd_save_summary" src/resources/extensions/gsd/index.ts
# Expected: 9
grep "inspect" src/resources/extensions/gsd/commands.ts | wc -l
# Expected: ≥ 4
```

## Test Cases

### 1. TypeScript compilation clean

```bash
npx tsc --noEmit
```

**Expected:** No output, exit code 0.

---

### 2. gsd_save_decision: ID auto-assignment and DECISIONS.md regeneration

Run gsd-tools.test.ts and look for the `gsd_save_decision` section:

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-tools.test.ts
```

**Expected:**
- Section heading `── gsd_save_decision ──` appears in output
- `35 passed, 0 failed`
- Test covers: first call returns `D001`, second call returns `D002` (sequential ID), DB row exists with matching decision/choice/rationale, DECISIONS.md is written to disk and contains the decision text

---

### 3. gsd_update_requirement: field merge and REQUIREMENTS.md regeneration

Same test run as above (gsd-tools.test.ts covers all 3 tools in sequence).

**Expected:**
- Section heading `── gsd_update_requirement ──` appears in output
- Test covers: updating status/description fields on an existing requirement, REQUIREMENTS.md written to disk, error path when requirement ID does not exist (throws with ID in message — stderr shows `gsd-db: updateRequirementInDb failed: Requirement R999 not found`)

---

### 4. gsd_save_summary: artifact written to DB and disk

Same test run as above (gsd-tools.test.ts covers saveArtifactToDb).

**Expected:**
- Section heading `── gsd_save_summary ──` appears
- Test covers: artifact row inserted with correct path, content written to disk at slice-level path (`milestones/M001/slices/S01/S01-SUMMARY.md`), milestone-level path, and task-level path

---

### 5. DB-unavailable error paths — all 3 tools return isError:true

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-tools.test.ts
```

**Expected:**
- Section heading `── DB unavailable error paths ──` appears
- Test proves: with `isDbAvailable()` returning false, `nextDecisionId()` returns `'D001'` (no throw); each tool's isError contract tested

---

### 6. /gsd inspect output format — formatInspectOutput

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-inspect.test.ts
```

**Expected:**
- `32 passed, 0 failed`
- 5 scenario headings appear: `full output formatting`, `empty data`, `null schema version`, `five recent entries`, `output format`
- Test proves: output begins with `=== GSD Database Inspect ===`, shows schema version (or "unknown" when null), shows counts for all 3 tables, shows recent decisions as `DXXX: decision → choice`, shows recent requirements as `RXXX [status]: description`, output is multiline text (not JSON)

---

### 7. inspect subcommand wired in handler

```bash
grep -n "inspect" src/resources/extensions/gsd/commands.ts
```

**Expected output includes:**
- Line matching `"inspect"` in the subcommands array
- Line matching `trimmed === "inspect"` in the handler dispatch
- Line matching `handleInspect`
- Line matching `formatInspectOutput`
- Line matching the error string including `inspect`

---

### 8. Full test suite — no regressions

```bash
npm test 2>&1 | grep -E "^(Results:|✖)" | grep -v "pack-install"
```

**Expected:** All `Results:` lines show `0 failed`. The only `✖` line is pack-install (pre-existing, unrelated to S06).

---

## Edge Cases

### DB unavailable — tool returns isError:true immediately

With DB unavailable, each tool must return `{ isError: true, details: { error: "db_unavailable" } }` without attempting any DB call.

**Verified by:** gsd-tools.test.ts "DB unavailable error paths" section (35-assertion suite).

---

### null schema version in formatInspectOutput

When the DB returns null for `MAX(version)` from schema_version, `formatInspectOutput` must render "unknown" not "null".

**Verified by:** gsd-inspect.test.ts "null schema version" scenario.

---

### Empty arrays in formatInspectOutput

When decisions and requirements arrays are empty, `formatInspectOutput` must render the sections without crashing and without emitting "(none)" or similar placeholder — sections simply have no entries.

**Verified by:** gsd-inspect.test.ts "empty data" scenario (32 assertions cover this path).

---

### updateRequirementInDb on non-existent ID

Calling `updateRequirementInDb` with a requirement ID that doesn't exist in the DB must throw with the ID in the error message and write a structured message to stderr.

**Verified by:** gsd-tools.test.ts error path test; stderr output `gsd-db: updateRequirementInDb failed: Requirement R999 not found` confirmed in test output.

---

## Failure Signals

- `tsc --noEmit` produces errors → compilation regression, likely a type mismatch in the tool schema or commands.ts export
- gsd-tools.test.ts fails on ID sequencing → `nextDecisionId()` not incrementing correctly in db-writer.ts
- gsd-tools.test.ts fails on DECISIONS.md content → `generateDecisionsMd()` output format changed since S02
- gsd-inspect.test.ts fails on format assertions → `formatInspectOutput` output structure diverged from expected format
- `grep` for inspect in commands.ts returns fewer than 4 matches → handler dispatch or autocomplete not wired

## Requirements Proved By This UAT

- R055 — 35 gsd-tools.test.ts assertions prove all 3 tools: ID assignment, DB write, markdown regeneration, error paths, unavailable fallback
- R056 — 32 gsd-inspect.test.ts assertions prove formatInspectOutput format; handler wiring verified by grep
- R050 — DB→markdown direction now complete; combined with S03's markdown→DB re-import, both directions of dual-write are wired

## Not Proven By This UAT

- End-to-end: LLM actually calling `gsd_save_decision` during a live auto-mode session — this requires a live agent invocation, deferred to S07
- `/gsd inspect` output when DB is absent (no gsd.db file present) — the error path writes to stderr and calls `ctx.ui.notify` with an error message; this path is described in the observability section but not exercised by the artifact-driven UAT (requires a live command context)
- Token savings measurement — deferred to S07 (R057)
- Round-trip fidelity of the complete dual-write loop (LLM saves decision → DECISIONS.md regenerated → handleAgentEnd re-import → DB query returns updated row) — deferred to S07 integration verification

## Notes for Tester

- The test runner command is `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test <file>`, not the ts-node command shown in the S06-PLAN.md verification section. ts-node is not installed in this environment.
- `--experimental-sqlite` flag is not needed on Node v25.5.0 — node:sqlite is built-in without it.
- The pack-install.test.ts failure in `npm test` is pre-existing (needs a built dist/ directory) and is unrelated to S06.
