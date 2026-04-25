# PRD: Pi Clean Seam Refactor

**Author:** Tom Boucher
**Date:** 2026-04-14
**ADR:** [ADR-010-pi-clean-seam-architecture.md](./ADR-010-pi-clean-seam-architecture.md)
**Priority:** High — blocks safe pi-mono upstream updates

---

## Problem Statement

GSD is built on top of pi-mono, an open-source agent framework maintained by Mario Zechner at [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono). GSD takes pi-mono as vendored source copies — four packages (`pi-agent-core`, `pi-ai`, `pi-tui`, `pi-coding-agent`) are copied directly into `/packages/` and modified in-place.

This worked as a starting point but has created a structural problem: **GSD-authored code lives inside the pi packages**. The 98KB `agent-session.ts`, the compaction system, three run modes (interactive, RPC, print), the CLI utilities, and the `createAgentSession()` factory are all authored by GSD but stored inside `pi-coding-agent`. Approximately 79 GSD-authored TypeScript files are mixed in with pi's upstream source.

The consequence is that every pi-mono update requires manually diffing GSD's modifications against the incoming upstream changes file-by-file. There is no reliable way to tell which files are GSD's and which are pi's without reading them. Updates that should take hours become multi-day archaeology projects. Pi-mono is currently 10 versions behind upstream (0.57.1 vs 0.67.2 as of April 2026), with a blocking API change (`session_switch`/`session_fork` removal in v0.65.0) unresolved.

Beyond update pain, there is a project risk: if pi-mono stops being maintained or changes direction, GSD's business logic is entangled with a dependency it no longer controls.

## Vision

GSD's code is clearly separated from pi's code at the module system level. The vendored pi packages contain only upstream code (plus the extension system, which is intentionally pi-typed). GSD's agent logic lives in GSD-owned packages that **depend on** pi but do not live inside it. When a new pi release comes out, a maintainer updates the vendored pi packages, runs the TypeScript compiler, and fixes the errors that surface in the GSD packages — without ever needing to diff individual files to find what's ours vs. theirs.

## Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| Zero GSD business logic in vendored pi packages | `pi-coding-agent/src/` contains no files that import from `@gsd/` packages (except the extension system's bundled module map) |
| Module boundary is compiler-enforced | TypeScript `paths` config or package `exports` prevents pi packages from importing GSD packages |
| Applying a pi-mono update is scoped | Updating pi packages produces type errors only in `@gsd/agent-core` and `@gsd/agent-modes` — no changes required in pi package source files |
| Install experience is unchanged | `npm install -g gsd-pi@latest` produces an identical binary from the user's perspective |
| Existing extensions continue to work | All built-in GSD extensions load and execute without modification |
| Build time does not regress significantly | Full build completes within 120% of current baseline |

## Non-Goals

- **Not** moving pi packages from vendored source to npm dependencies (that is a potential Phase 2)
- **Not** creating an abstraction layer that hides pi types from GSD code — GSD packages may freely use pi's `AgentMessage`, `Model`, `TUI`, etc.
- **Not** upstreaming GSD's modifications to pi-mono (desirable long-term but out of scope)
- **Not** changing the published npm package name, install command, or any user-facing CLI behavior
- **Not** removing or replacing the extension system — it stays in `pi-coding-agent` and remains typed against pi's types

## Stakeholders

- **Maintainers applying pi updates** — primary beneficiary; this work directly reduces their update burden
- **Extension authors** — must not be broken; the extension API surface stays in `@gsd/pi-coding-agent`
- **End users** — not impacted; the refactor is entirely internal

## Requirements

### R1 — New package: `@gsd/agent-core`

A new workspace package at `packages/gsd-agent-core/` that owns all GSD session orchestration logic. It depends on `@gsd/pi-coding-agent`, `@gsd/pi-agent-core`, and `@gsd/pi-ai`. Nothing in the vendored pi packages depends on it.

Must contain:
- `agent-session.ts` and all `AgentSession` types
- `compaction/` (orchestrator, branch summarization, utilities)
- `system-prompt.ts`
- `bash-executor.ts`
- `fallback-resolver.ts`
- `lifecycle-hooks.ts`
- `image-overflow-recovery.ts`
- `contextual-tips.ts`
- `keybindings.ts`
- `sdk.ts` (the `createAgentSession()` factory — the primary public API of this package)
- `artifact-manager.ts`, `blob-store.ts`
- `export-html/`

### R2 — New package: `@gsd/agent-modes`

A new workspace package at `packages/gsd-agent-modes/` that owns all run-mode and CLI code. It depends on `@gsd/agent-core`, `@gsd/pi-coding-agent`, and `@gsd/pi-tui`. It is the layer the top-level `gsd-pi` binary entry point assembles.

Must contain:
- `modes/interactive/` (full TUI interactive mode and all components)
- `modes/rpc/` (RPC server, RPC client, JSON protocol)
- `modes/print/` (print/headless mode)
- `cli/` (arg parsing, config selector, session picker, model lister, file processor)
- `main.ts` entry point logic

### R3 — `pi-coding-agent` contains only upstream code and the extension system

After the migration, the vendored `pi-coding-agent` source must not contain files that:
- Import from `@gsd/agent-core` or `@gsd/agent-modes`
- Contain GSD business logic (compaction, session management, run modes, CLI)

The extension system (`src/core/extensions/`) remains in `pi-coding-agent` because it is legitimately pi-typed: extension authors write against pi's `AgentMessage`, `Model`, and `TUI` types. The virtual module map in `extensions/loader.ts` must be updated to include `@gsd/agent-core` and `@gsd/agent-modes` so extensions can import from them.

### R4 — Public API surfaces are explicit

Each new package must have an `index.ts` that declares its public API. Internal files must not be imported by path from outside the package. Specifically:
- `web/bridge-service.ts` currently imports `AgentSessionEvent` from an internal path in `pi-coding-agent` — this must be fixed to use the public export from `@gsd/agent-core`
- Any other internal-path imports identified during migration must be fixed

### R5 — Build order is updated

The workspace build script must be updated to build packages in dependency order:
1. `@gsd/pi-agent-core`, `@gsd/pi-ai`, `@gsd/pi-tui` (parallel, no dependencies between them)
2. `@gsd/pi-coding-agent`
3. `@gsd/agent-core`
4. `@gsd/agent-modes`
5. `gsd-pi` (top-level binary)

### R6 — No change to the extension loader's public interface

Extensions are loaded by `pi-coding-agent`'s jiti-based loader. The virtual module map (`STATIC_BUNDLED_MODULES`) must be updated to resolve `@gsd/agent-core` and `@gsd/agent-modes` alongside the existing pi package mappings. This requires both a map entry and a top-level bundle import in `loader.ts` (see ADR-009 for the exact diff). Extension authors must not need to change their import paths.

## Open Questions

1. Does `clearQueue()` on `AgentSession` need to be added to a public type export, or is it already accessible to the auto-mode extension that uses it?
2. Does `buildSessionContext()` on `SessionManager` need a public re-export from `@gsd/agent-core`?
3. Should `@gsd/agent-modes` re-export `createAgentSession()` as a convenience, or should consumers always import it from `@gsd/agent-core` directly?
