# M001: models.dev Registry — Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

## Project Description

Replace the static model registry (`models.generated.ts`) with runtime fetching from models.dev, using the same pattern as opencode: lazy load, cached file, bundled snapshot fallback, periodic refresh.

## Why This Milestone

Model data becomes stale between releases. New models, pricing changes, and capability updates require code changes. Fetching from models.dev at runtime keeps the registry current without releases.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Use newly released models immediately (no gsd-2 update required)
- Run gsd-2 offline after first run (cached/snapshot data available)
- Continue using custom models via `~/.gsd/agent/models.json`

### Entry point / environment

- Entry point: `pi` CLI startup
- Environment: local dev / production
- Live dependencies involved: models.dev API (network)

## Completion Class

- Contract complete means: models.dev fetch/cache/fallback logic works with unit tests
- Integration complete means: ModelRegistry loads from models.dev, local overrides still work
- Operational complete means: Fresh install works offline, version bump triggers refresh

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- Start `pi` with expired cache → fetches from models.dev
- Start `pi` with no cache, no network → uses snapshot
- Start `pi` with valid cache → uses cache (no network)
- Start `pi` after version bump → cache invalidated, refresh triggered
- Local `models.json` overrides are applied correctly

## Risks and Unknowns

- **models.dev schema vs our Model type** — Mapping required, schema may have fields we don't use or vice versa
- **Bundled snapshot size** — models.generated.ts is 342KB; snapshot will be similar, acceptable

## Existing Codebase / Prior Art

- `packages/pi-ai/src/models.ts` — Registry access functions (getModels, getProviders, getModel)
- `packages/pi-ai/src/models.generated.ts` — Static model definitions (to be removed)
- `packages/pi-coding-agent/src/core/model-registry.ts` — Combines built-in + custom models
- `packages/pi-coding-agent/src/config.ts` — VERSION, getAgentDir(), getModelsPath()
- `src/update-check.ts` — Existing pattern for cached network fetch with TTL
- `~/Documents/kimi-coding-check/opencode/packages/opencode/src/provider/models.ts` — Reference implementation

## Relevant Requirements

- R001 — Fetch from models.dev
- R002 — 12-hour cache with fallback
- R003 — Version-triggered refresh
- R004 — Bundled snapshot
- R005 — Preserve local models.json
- R006 — Remove generated file

## Scope

### In Scope

- Fetch models.dev/api.json at runtime
- Cache to ~/.gsd/agent/cache/models-dev.json with 12h TTL
- Fallback chain: cache → snapshot → live fetch
- Network failure → use cache even if stale
- Version change → force refresh
- Bundle snapshot at build time
- Map models.dev schema to our Model type
- Remove models.generated.ts

### Out of Scope / Non-Goals

- Periodic background refresh (only refresh on startup when cache expired)
- UI for model registry status
- Custom models.dev URL (hardcode for now)

## Technical Constraints

- Must work in Node.js and Bun runtimes
- Must not block CLI startup on network (use cache/snapshot first, fetch async if expired)
- Cache file must be JSON for debugging

## Integration Points

- **models.dev** — External API, 10s timeout, graceful failure
- **ModelRegistry** — Consumes fetched models, merges with local overrides
- **Build process** — Snapshot committed to repo (not generated at build time)

## Open Questions

- None — approach confirmed with user
