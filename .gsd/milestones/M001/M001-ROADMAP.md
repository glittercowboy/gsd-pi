# M001: models.dev Registry

**Vision:** Model registry fetches data from models.dev at runtime with caching, eliminating the need for static generated files and code releases to update model information.

## Success Criteria

- `pi --list-models` shows models from models.dev (or cache/snapshot)
- Fresh install works offline via bundled snapshot
- Network failure falls back to cached data
- GSD version change triggers cache refresh
- Local `~/.gsd/agent/models.json` overrides still work
- `models.generated.ts` removed, no generation script

## Key Risks / Unknowns

- **Schema mismatch:** models.dev schema differs from our Model type — S01 proves mapping works
- **Bundled snapshot:** Build-time generation needed — S03 handles this

## Proof Strategy

- Schema mismatch → retire in S01 by building and testing the mapper
- Bundled snapshot → retire in S03 by adding build step and verifying offline use

## Verification Classes

- Contract verification: unit tests for fetch/cache/fallback logic
- Integration verification: `pi --list-models` works with models.dev data
- Operational verification: fresh install + offline works, network failure → cache
- UAT / human verification: spot-check model list matches models.dev

## Milestone Definition of Done

This milestone is complete only when all are true:

- All slice deliverables complete
- ModelRegistry uses models.dev data
- Cache/snapshot/fallback chain verified by tests
- `models.generated.ts` deleted
- `pi --list-models` works offline (snapshot) and online (fetched)

## Requirement Coverage

- Covers: R001, R002, R003, R004, R005, R006
- Partially covers: none
- Leaves for later: none
- Orphan risks: none

## Slices

- [ ] **S01: models.dev fetching with caching** `risk:medium` `depends:[]`
  > After this: Unit tests prove fetch → cache → fallback chain works, version change triggers refresh

- [ ] **S02: Integrate into ModelRegistry** `risk:low` `depends:[S01]`
  > After this: `pi` starts with models from models.dev, local models.json still overrides

- [ ] **S03: Build-time snapshot + cleanup** `risk:low` `depends:[S01,S02]`
  > After this: Fresh install works offline (uses snapshot), models.generated.ts deleted

## Boundary Map

### S01 → S02

Produces:
- `packages/pi-ai/src/models-dev.ts` — fetchModelsDev(), getCachedModelsDev(), getModelsDevSnapshot()
- `packages/pi-ai/src/models-dev-types.ts` — ModelsDevProvider, ModelsDevModel types
- `packages/pi-ai/src/models-dev-mapper.ts` — mapToModelRegistry() converts models.dev schema to Model<Api>[]
- Cache file: `~/.gsd/agent/cache/models-dev.json` with { version, fetchedAt, data }

Consumes:
- `packages/pi-coding-agent/src/config.ts` — VERSION, getAgentDir()
- `https://models.dev/api.json` — external API

### S02 → S03

Produces:
- `packages/pi-coding-agent/src/core/model-registry.ts` — loadModels() calls getModelsDev() instead of importing MODELS
- Models from models.dev merged with local models.json overrides

Consumes:
- S01 outputs (fetchModelsDev, mapToModelRegistry)

### S03

Produces:
- `packages/pi-ai/src/models-dev-snapshot.ts` — bundled snapshot (committed)
- Build step to regenerate snapshot (manual for now, run before releases)

Consumes:
- S01 fetch infrastructure for snapshot generation
