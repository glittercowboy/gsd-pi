# M001: Proactive Secret Management

**Vision:** Front-load API key collection into GSD's planning phase so auto-mode runs uninterrupted. When a milestone is planned, the LLM forecasts needed secrets, writes a manifest with setup guidance, and the user is prompted to enter keys before execution begins.

## Success Criteria

- A milestone planning run that involves external APIs produces a parseable secrets manifest with per-key guidance
- `/gsd auto` detects pending secrets and collects them before the first slice dispatch
- Keys already in `.env` or `process.env` are silently skipped
- The guided `/gsd` wizard triggers the same collection flow
- `npm run build` passes with no new errors
- `npm run test` passes with no new failures

## Key Risks / Unknowns

- **Prompt compliance** — LLM must reliably produce well-formatted manifest markdown. Mitigated by existing prompt instructions and a forgiving parser.
- **TUI layout** — Guidance steps displayed above the input must not break the masked editor layout at various terminal widths.

## Proof Strategy

- Prompt compliance → retire in S01 by proving plan-milestone prompt produces parseable manifest with a parser round-trip test
- TUI layout → retire in S02 by building the enhanced collection UI and verifying visually at multiple widths

## Verification Classes

- Contract verification: parser round-trip tests, build pass, existing test suite pass
- Integration verification: manifest-to-collection flow exercised through real function calls
- Operational verification: none (dev-time workflow)
- UAT / human verification: visual check of summary screen and guidance display in terminal

## Milestone Definition of Done

This milestone is complete only when all are true:

- Secrets manifest is produced during plan-milestone and is parseable by `parseSecretsManifest()`
- `secure_env_collect` renders guidance steps and shows a summary screen
- `startAuto()` checks for pending manifest and triggers collection before first dispatch
- Guided flow triggers the same collection
- All success criteria pass
- `npm run build` and `npm run test` pass

## Requirement Coverage

- Covers: R001, R002, R003, R004, R005, R006, R007, R008, R009, R010
- Partially covers: none
- Leaves for later: R011 (multi-milestone forecasting), R012 (rotation reminders)
- Orphan risks: none

## Slices

- [x] **S01: Manifest Wiring & Prompt Verification** `risk:medium` `depends:[]`
  > After this: running the plan-milestone prompt produces a `M00x-SECRETS.md` file that round-trips through `parseSecretsManifest()`, and the manifest status can be queried by calling `getManifestStatus()`.

- [x] **S02: Enhanced Collection TUI** `risk:medium` `depends:[S01]`
  > After this: calling `secure_env_collect` with guidance arrays shows a read-only summary screen, displays guidance steps above the masked input, and auto-skips keys already in the environment.

- [x] **S03: Auto-Mode & Guided Flow Integration** `risk:low` `depends:[S01,S02]`
  > After this: running `/gsd auto` on a milestone with a secrets manifest pauses for collection before slice execution, and the `/gsd` wizard triggers the same flow after planning.

## Boundary Map

### S01 → S02

Produces:
- `files.ts` → `parseSecretsManifest()`, `formatSecretsManifest()` (already exist, verified working)
- `types.ts` → `SecretsManifest`, `SecretsManifestEntry`, `SecretsManifestEntryStatus` (already exist)
- `paths.ts` → `resolveMilestoneFile(base, mid, "SECRETS")` resolves manifest path (already works)
- `auto.ts` / new helper → `getManifestStatus(base, mid)` returns `{ pending: string[], collected: string[], skipped: string[], existing: string[] }`

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- Same as S01 → S02 (manifest status helper is the primary contract)

Consumes:
- nothing (first slice)

### S02 → S03

Produces:
- `get-secrets-from-user.ts` → `collectOneSecret()` enhanced with guidance display
- `get-secrets-from-user.ts` → `showSecretsSummary()` new function showing read-only summary screen
- `get-secrets-from-user.ts` → `collectSecretsFromManifest()` orchestrator that shows summary, skips existing, collects pending, updates manifest status

Consumes from S01:
- `parseSecretsManifest()` to read the manifest
- `formatSecretsManifest()` to write status updates
- `checkExistingEnvKeys()` to detect already-set keys
- `detectDestination()` for destination inference
