# Requirements

## Active

### R001 — Validators reject malformed artifacts
- Class: core-capability
- Status: active
- Description: validateArtifact returns ok=false when required sections are missing
- Why it matters: prevents malformed PROJECT.md/REQUIREMENTS.md from propagating to downstream stages
- Source: spec
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: unmapped
- Notes: contract spec at 11-CONTRACTS.md

## Validated

## Deferred

### R020 — Schema versioning
- Class: operability
- Status: deferred
- Description: schema_version field in DISCUSSION-MANIFEST.json
- Why it matters: enables backward-compat migrations
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: lands with manifest extension in M002

## Out of Scope

### R030 — Real-time validation
- Class: anti-feature
- Status: out-of-scope
- Description: file watcher that validates on every save
- Why it matters: prevents scope creep into IDE tooling
- Source: inferred
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: out of scope for Phase 11

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | core-capability | active | M001/S01 | none | unmapped |
| R020 | operability | deferred | none | none | unmapped |
| R030 | anti-feature | out-of-scope | none | none | n/a |

## Coverage Summary

- Active requirements: 1
- Mapped to slices: 1
- Validated: 0
- Unmapped active requirements: 0
