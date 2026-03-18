---
depends_on: [M009]
---

# M010: Upstream Sync v2.22→v2.28

**Gathered:** 2026-03-18
**Status:** Draft — needs dedicated discussion before planning

## What This Milestone Does

Merge 349+ upstream commits (v2.22.0→v2.28.0) into the fork, resolve all conflicts, fix all errors/warnings/failing tests, and build selective web UI for new upstream features (park/discard milestone actions, session picker, /gsd keys evaluation).

## Why It Matters

The fork is 6 minor versions behind upstream. The upstream has major structural refactoring (auto.ts decomposed into 6 modules, commands.ts into 5, preferences.ts and doctor.ts decomposed). Staying behind risks increasingly painful merges and missing important fixes.

## Key Facts from Current Investigation

- 349 commits, 777 files changed, 83K insertions, 21K deletions
- 58 refactoring commits that decomposed major files
- Last merge (M003, v2.12→v2.22, 415 commits) was 9 slices
- Key upstream features needing web UI: park/discard (#1107), session picker (#721), /gsd keys (#1089)
- Features explicitly excluded from web UI: headless query, onboarding wizard, export --html --all
- CI/CD additions upstream: three-stage promotion pipeline, Dockerfile for CI
- Major refactors: auto.ts→6 modules, commands.ts→5 modules, preferences.ts decomposed, doctor.ts decomposed, bg-shell split from 1604-line god file

## User Decisions

- Build web UI for park/discard and session picker during merge
- Build /gsd keys web panel ONLY if current settings UI is insufficient
- Do NOT build web UI for headless query, onboarding wizard, or export --html
- All errors, warnings, and failing tests must be resolved

## Relevant Requirements

- R125 — Merge upstream v2.22→v2.28, resolve conflicts, both builds green
- R126 — Zero errors, warnings, or failing tests after merge
- R127 — Web UI for park/discard actions
- R128 — Web UI for session picker
- R129 — Web UI for /gsd keys (conditional)

## Open Questions for Dedicated Discussion

- Merge strategy: incremental (version by version) vs big-bang (direct to v2.28)?
- How to handle the decomposed auto.ts — our fork has web services that import from auto modules
- Whether the upstream CI/CD additions (Dockerfile, promotion pipeline) are useful for our fork
- Conflict prediction: which fork files are most at risk given the refactoring commits?
