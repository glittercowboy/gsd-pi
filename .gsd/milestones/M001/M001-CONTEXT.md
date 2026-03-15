# M001: Proactive Secret Management — Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

## Project Description

Add proactive secret forecasting and guided collection to GSD's milestone planning phase. When a milestone is planned, the LLM analyzes what external services and API keys will be needed, writes a secrets manifest with step-by-step guidance for each key, and collects them all before auto-mode begins execution.

## Why This Milestone

Auto-mode's value proposition is autonomous execution — plan it, walk away, come back to finished work. But if a task at S02/T03 needs a Stripe API key, auto-mode blocks and sits there for hours waiting. The user comes back expecting progress and finds a prompt asking for a key. This milestone eliminates that failure mode by front-loading secret collection into the planning phase.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Describe a project during `/gsd` discuss that involves external APIs (Stripe, Supabase, OpenAI, etc.) and see a secrets manifest produced during planning with step-by-step guidance for each key
- See a read-only summary screen listing all needed keys with status (pending/already set), then enter only pending keys one-by-one with guidance displayed above the input field
- Run `/gsd auto` and have it collect any uncollected secrets at the entry point before dispatching the first slice, so auto-mode runs uninterrupted

### Entry point / environment

- Entry point: `/gsd` wizard and `/gsd auto` CLI commands
- Environment: local dev terminal (pi TUI)
- Live dependencies involved: `secure_env_collect` tool, .env files, optionally Vercel/Convex CLIs

## Completion Class

- Contract complete means: planning prompts produce secrets manifests, the manifest parser works, the collection TUI shows guidance and skips existing keys, and auto-mode dispatches collection at the right time
- Integration complete means: a real `/gsd auto` run with a milestone that needs API keys triggers collection before slice execution
- Operational complete means: none — this is a dev-time workflow, not a running service

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A milestone planning run that involves external APIs produces a parseable secrets manifest with per-key guidance
- `/gsd auto` detects the manifest and pauses for collection before dispatching the first slice
- Keys already in the environment are silently skipped in the summary screen
- The guided `/gsd` flow triggers the same collection
- `npm run build` passes
- `npm run test` passes (no new failures beyond pre-existing ones)

## Risks and Unknowns

- **Prompt compliance** — The LLM must reliably produce a well-formatted secrets manifest during planning. If the format is inconsistent, the parser won't find the keys. Mitigated by clear prompt instructions and a forgiving parser. Already partially proven: the prompt instructions exist.
- **Guidance accuracy** — LLM-generated guidance for finding API keys (dashboard URLs, navigation steps) may be outdated or wrong. This is best-effort and explicitly accepted by the user.
- **State machine insertion** — Adding collection to `startAuto` (not `dispatchNextUnit`) keeps the state machine untouched. Lower risk than a new unit type.

## Existing Codebase / Prior Art

- `src/resources/extensions/get-secrets-from-user.ts` — The existing `secure_env_collect` tool. Has paged masked TUI input, writes to .env/Vercel/Convex. Has a `guidance` field in the schema but doesn't render it. Has `checkExistingEnvKeys()` and `detectDestination()` as exported utilities.
- `src/resources/extensions/gsd/auto.ts` — The auto-mode state machine. `startAuto()` is the entry point. Collection hooks in here before the first `dispatchNextUnit()` call.
- `src/resources/extensions/gsd/guided-flow.ts` — The `/gsd` wizard. `showSmartEntry()` handles all entry paths. Has `pendingAutoStart` mechanism for discuss→auto transitions.
- `src/resources/extensions/gsd/prompts/plan-milestone.md` — The planning prompt template. Already has `## Secret Forecasting` section with instructions to write `{{secretsOutputPath}}`.
- `src/resources/extensions/gsd/state.ts` — State derivation from disk files. May need to expose whether a secrets manifest exists and whether collection is complete.
- `src/resources/extensions/gsd/files.ts` — File parsing utilities. Already has `parseSecretsManifest()` and `formatSecretsManifest()`.
- `src/resources/extensions/gsd/types.ts` — Core type definitions. Already has `SecretsManifest`, `SecretsManifestEntry`, `SecretsManifestEntryStatus`.
- `src/resources/extensions/gsd/paths.ts` — Path resolution. Uses `resolveMilestoneFile(base, mid, "SECRETS")` pattern (already works with existing resolvers).
- `src/resources/extensions/gsd/templates/secrets-manifest.md` — Template for the manifest format.

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- R001 — Secret forecasting during milestone planning (core capability)
- R002 — Secrets manifest file persisted in .gsd/ (continuity)
- R003 — LLM-generated step-by-step guidance per key (primary user loop)
- R004 — Summary screen before collection (primary user loop)
- R005 — Existing key detection and silent skip (primary user loop)
- R006 — Smart destination detection (integration)
- R007 — Auto-mode integration (core capability)
- R008 — Guided /gsd wizard integration (core capability)
- R009 — Planning prompts instruct LLM to forecast secrets (integration)
- R010 — secure_env_collect enhanced with guidance field (primary user loop)

## Scope

### In Scope

- Secret forecasting during plan-milestone phase
- Secrets manifest file format and parser (already built)
- Enhanced secure_env_collect with guidance display and summary screen
- Existing key detection (.env and process.env)
- Smart destination detection from project context
- Auto-mode collection at `/gsd auto` entry point (in startAuto)
- Guided flow collection trigger
- Manifest status tracking (collected/pending/skipped)

### Out of Scope / Non-Goals

- Multi-milestone secret forecasting (deferred — R011)
- Secret rotation reminders (deferred — R012)
- Curated service knowledge base (out of scope — R013)
- Just-in-time collection enhancement (out of scope — R014)
- Modifying how secure_env_collect writes to Vercel/Convex (existing behavior preserved)
- Adding a new unit type to dispatchNextUnit (collection at entry point instead)

## Technical Constraints

- Must not break existing auto-mode phase flow — collection happens at entry, not in dispatch loop
- `secure_env_collect` changes must be backward compatible — existing callers unaffected
- Secrets manifest is parsed by existing `parseSecretsManifest()` in `files.ts`
- Guidance renders on the same page as the masked input (no separate info page)
- Summary screen is read-only with auto-skip (no interactive deselection)

## Integration Points

- `secure_env_collect` tool — Enhanced with guidance display and summary screen
- `startAuto()` in auto.ts — Collection check before first dispatch
- `plan-milestone.md` prompt — Already has forecasting instructions
- `guided-flow.ts` — Collection trigger after planning via startAuto
- `files.ts` / `types.ts` — Manifest parsing (already implemented)
- `.env` file / process.env — Existing key detection via `checkExistingEnvKeys()`

## Open Questions

- None remaining. Key decisions locked:
  - Manifest format: Markdown (consistent with other .gsd files, parser exists)
  - Destination inference: Simple file-presence checks via existing `detectDestination()`
  - Summary screen: Read-only with auto-skip
  - Guidance display: Same page as input
  - Auto-mode insertion: At `/gsd auto` entry point, not in dispatch loop
