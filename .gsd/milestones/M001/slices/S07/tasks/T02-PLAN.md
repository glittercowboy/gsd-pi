---
estimated_steps: 5
estimated_files: 1
---

# T02: Validate R001 + R019 and update REQUIREMENTS.md

**Slice:** S07 — Integration Verification + Polish
**Milestone:** M001

## Description

Update REQUIREMENTS.md to move R001 and R019 from "active" to "validated" with proof summaries referencing the integration test evidence from T01. Update the traceability table and coverage summary to reflect 0 active requirements remaining.

## Steps

1. In the Active section, update R001:
   - Change `Status: active` → `Status: validated`
   - Update Validation field: "S01 — DB opens, schema inits, versioned migrations, typed wrappers, WAL mode. S02 — Forward-only migration v1→v2 proven. S07 — Full lifecycle integration test proves end-to-end composition across gsd-db, md-importer, context-store, and db-writer modules."

2. In the Active section, update R019:
   - Change `Status: active` → `Status: validated`
   - Update Validation field: "S07 — Lifecycle integration test proves 'same data in = same prompt out' across the full pipeline: migration → scoped queries → formatted output → re-import → round-trip consistency. ≥30% savings maintained with correct scoping. UAT for subjective LLM output quality is a separate operational concern."

3. Add R001 and R019 to the Validated section with proof summaries.

4. Update traceability table: R001 status → `validated`, R019 status → `validated`.

5. Update coverage summary: Active requirements → 0, Validated → 21.

## Must-Haves

- [ ] R001 status = validated with proof referencing S01, S02, S07
- [ ] R019 status = validated with proof referencing S07 lifecycle test
- [ ] Both added to Validated section
- [ ] Traceability table updated
- [ ] Coverage summary: 0 active, 21 validated

## Verification

- Active section has 0 requirements with `Status: active`
- Validated section has 21 entries
- Traceability table shows R001 and R019 as `validated`
- Coverage summary line reads "Active requirements: 0" and "Validated: 21"

## Inputs

- T01 integration test results — confirms both requirements are proven
- Current `.gsd/REQUIREMENTS.md` — the file to update

## Expected Output

- `.gsd/REQUIREMENTS.md` — R001 and R019 validated, all counts updated

## Observability Impact

- **No runtime signals change**: This task is a documentation-only update to `.gsd/REQUIREMENTS.md`. No code, logs, metrics, or error paths are modified.
- **Inspection**: Verify via `grep "Status: active" .gsd/REQUIREMENTS.md` — should return 0 matches in the Active section. `grep -c "^### R" .gsd/REQUIREMENTS.md` in the Validated section should return 21.
- **Failure state**: If a future task incorrectly references R001 or R019 as "active", the traceability table and coverage summary in REQUIREMENTS.md are the authoritative sources to check.
