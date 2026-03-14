# Project

## What This Is

GSD (Get Shit Done) is a CLI-based AI coding agent that helps users build software through natural language interaction. It supports multiple LLM providers, extensible tools, and session management.

## Core Value

The model registry must stay current with available models, pricing, and capabilities without requiring code changes or releases.

## Current State

- **M001 complete:** Model registry fetches from models.dev with 12h cache, fallback to bundled snapshot, local overrides preserved
- **M002 S01 complete:** Build/test infrastructure repaired — `npm run build && npm test` workflow works
- Models loaded at runtime from models.dev API or bundled snapshot (2311KB, 102 providers)
- Legacy `packages/pi-ai/src/models.generated.ts` deleted
- Users can override/add models via `~/.gsd/agent/models.json`
- `npm run generate-snapshot` regenerates bundled snapshot from live models.dev data

## Architecture / Key Patterns

- **Monorepo:** `packages/pi-ai` (core AI primitives), `packages/pi-coding-agent` (CLI app), `packages/pi-agent-core` (agent loop)
- **Model Registry:** `ModelRegistry` class in `pi-coding-agent` combines built-in models with user overrides
- **Config paths:** `~/.gsd/agent/` for user config, cache, auth

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: models.dev Registry — Complete
  - [x] S01: models.dev fetching with caching
  - [x] S02: Integrate into ModelRegistry
  - [x] S03: Build-time snapshot + cleanup
- [ ] M002: Model Registry Hardening and Real-Scenario Verification — In Progress
  - [x] S01: Build/Test Infrastructure Repair
  - [ ] S02: Production-Like Scenario Testing
  - [ ] S03: Live models.dev Verification
