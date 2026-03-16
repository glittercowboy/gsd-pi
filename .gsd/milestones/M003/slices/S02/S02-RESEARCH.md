# S02 — Browser slash-command dispatch for all upstream commands — Research

**Date:** 2026-03-16
**Depth:** Targeted

## Summary

S02 extends the browser slash-command dispatch system to cover all upstream `/gsd` subcommands. The current dispatch file (`browser-slash-command-dispatch.ts`) handles 12 built-in pi commands (settings, model, thinking, git, resume, name, fork, compact, login, logout, session, export) and lets everything else — including all `/gsd *` commands — fall through as `kind: "prompt"` to the bridge.

The key architectural insight is that `/gsd` is **not** a built-in slash command. When a user types `/gsd status` in the browser, `parseSlashCommand` produces `{ name: "gsd", args: "status" }`. Since `"gsd"` is not in `BUILTIN_SLASH_COMMANDS` and not in `SURFACE_COMMANDS`, the dispatch returns `kind: "prompt"` and the full text goes to the bridge as a prompt message. The bridge's CLI process then runs the extension command handler.

This works for commands that only use `ctx.ui.notify` (which the bridge supports), but fails silently for commands using `ctx.ui.custom` (TUI overlay — status, visualize) or `ctx.ui.input`/`ctx.ui.select` (interactive prompts — prefs wizard, config, forensics with problem description). S02 must intercept `/gsd` subcommands in the browser dispatch layer and route them to browser-native surfaces.

The existing pattern is clear and well-tested. `BrowserSlashCommandSurface` is a union type, `SURFACE_COMMANDS` is a Map routing command names to surfaces, `IMPLEMENTED_BROWSER_COMMAND_SURFACES` gates rendering, and `command-surface-contract.ts` provides typed state for each surface. The existing parity contract test (`web-command-parity-contract.test.ts`) already validates that built-in commands never fall through silently.

## Recommendation

Add a **GSD subcommand dispatch layer** that intercepts `/gsd *` input before it falls through to prompt. The dispatch should:

1. Parse the GSD subcommand from `args` (e.g., `/gsd status` → subcommand `status`)
2. Route to one of three outcomes:
   - **surface** — opens a browser-native surface (visualize, forensics, doctor, skill-health, knowledge, captures, status, quick, history, inspect, prefs, config, hooks)
   - **bridge-execute** — passes through to bridge for commands that work fine via `ctx.ui.notify` (auto, next, stop, pause, capture, triage, steer, knowledge, undo, export, cleanup, skip, mode, run-hook, discuss, migrate, remote)
   - **reject** — commands that cannot work in browser (none expected — everything gets either a surface or bridge execution)

The implementation extends the existing dispatch architecture by adding a GSD-specific code path after the `parseSlashCommand` call, before the generic BUILTIN_COMMAND_NAMES check.

## Implementation Landscape

### Key Files

- **`web/lib/browser-slash-command-dispatch.ts`** (179 lines) — The dispatch function. Needs a GSD subcommand routing layer. Currently has `BrowserSlashCommandSurface` union, `SURFACE_COMMANDS` map, `parseSlashCommand()`, and `dispatchBrowserSlashCommand()`. The new GSD dispatch inserts after `parseSlashCommand()` returns `{ name: "gsd", args: "..." }`.

- **`web/lib/command-surface-contract.ts`** (935 lines) — Typed state for command surfaces. Needs new `CommandSurfaceSection` members for GSD surfaces and corresponding `CommandSurfaceTarget` kinds. Currently has sections: model, thinking, queue, compaction, retry, recovery, auth, admin, git, resume, name, fork, session, compact. New GSD surfaces need their own sections.

- **`web/components/gsd/command-surface.tsx`** (1948 lines) — Renders command surface sections. S02 only needs to add section routing stubs (the actual UI content is S04–S07 scope). The command surface Sheet component already handles opening/closing and section tabs.

- **`web/lib/gsd-workspace-store.tsx`** (4600+ lines) — The workspace store. Contains `IMPLEMENTED_BROWSER_COMMAND_SURFACES` set and `submitInput()` which gates surface rendering. Needs updates to the implemented set and `openCommandSurface` routing for new GSD surfaces.

- **`src/tests/web-command-parity-contract.test.ts`** (330 lines) — The authoritative parity contract test. Currently tests that built-in commands don't fall through, and that `/gsd *` commands stay on the prompt path. Must be updated to test that every `/gsd` subcommand dispatches to a defined outcome (surface, bridge-execute, or explicit reject).

- **`src/resources/extensions/gsd/commands.ts`** (1900+ lines) — The authoritative list of all `/gsd` subcommands. S02 reads this but doesn't modify it. The registered subcommands are: `help, next, auto, stop, pause, status, visualize, queue, quick, discuss, capture, triage, history, undo, skip, export, cleanup, mode, prefs, config, hooks, run-hook, skill-health, doctor, forensics, migrate, remote, steer, inspect, knowledge`.

### Upstream Subcommand Classification

Every `/gsd` subcommand maps to one of these browser dispatch outcomes:

**New browser-native surfaces** (dispatch kind: `"surface"`, new `BrowserSlashCommandSurface` members):
| Subcommand | Surface Name | Future Slice | Notes |
|---|---|---|---|
| `status` | `"gsd-status"` | (existing dashboard) | Already has dashboard component — surface opens it |
| `visualize` | `"gsd-visualize"` | S03 | Dedicated page with 7 tabs |
| `forensics` | `"gsd-forensics"` | S04 | Panel for forensic anomaly scanning |
| `doctor` | `"gsd-doctor"` | S04 | Panel for health checks and auto-fix |
| `skill-health` | `"gsd-skill-health"` | S04 | Panel for skill lifecycle telemetry |
| `knowledge` | `"gsd-knowledge"` | S05 | Combined knowledge/captures page |
| `capture` | `"gsd-capture"` | S05 | Input for quick-capture text |
| `triage` | `"gsd-triage"` | S05 | Triage pending captures |
| `quick` | `"gsd-quick"` | S07 | Quick-task surface |
| `history` | `"gsd-history"` | S07 | Execution history with filters |
| `undo` | `"gsd-undo"` | S07 | Revert last unit |
| `inspect` | `"gsd-inspect"` | S07 | DB diagnostics |
| `prefs` | `"gsd-prefs"` | S06 | Preferences wizard |
| `config` | `"gsd-config"` | S07 | API key config |
| `hooks` | `"gsd-hooks"` | S07 | Hook configuration view |
| `mode` | `"gsd-mode"` | S06 | Workflow mode |
| `steer` | `"gsd-steer"` | S07 | User override input |
| `export` | `"gsd-export"` | S07 | Milestone/slice export |
| `cleanup` | `"gsd-cleanup"` | S07 | Branch/snapshot cleanup |

**Bridge-execute passthrough** (dispatch kind: `"prompt"`, unchanged behavior — these work via bridge already):
| Subcommand | Reason |
|---|---|
| `auto` | Starts auto-mode via bridge process — only uses `ctx.ui.notify` |
| `next` | Same as auto with step mode |
| `stop` | Sends stop signal — only `ctx.ui.notify` |
| `pause` | Sends pause signal — only `ctx.ui.notify` |
| `skip` | Registers skip — only `ctx.ui.notify` |
| `discuss` | Starts guided flow — uses `sendMessage` which works via bridge |
| `run-hook` | Triggers hook — only `ctx.ui.notify` |
| `migrate` | Migration flow — uses `sendMessage` |
| `remote` | Remote control — only `ctx.ui.notify` |
| `queue` | Shows queue — uses `sendMessage` for guided flow |

**Help** (dispatch kind: `"local"` or inline):
| Subcommand | Notes |
|---|---|
| `help` | Can render help text inline in terminal — no surface needed |
| (bare `/gsd`) | Equivalent to `/gsd next` — passthrough to bridge |

### Design Decision: GSD Surface vs Existing Surface Pattern

Two options for routing `/gsd` subcommands to surfaces:

**Option A: Extend `BrowserSlashCommandSurface` union** — Add `"gsd-forensics"`, `"gsd-doctor"`, etc. as new members. Reuse the existing command-surface Sheet component with new sections.

**Option B: New GSD dispatch result kind** — Add a `kind: "gsd-surface"` to the dispatch result union with a subcommand-specific payload. Handle routing in `submitInput()` separately from the built-in surface path.

**Recommendation: Option A** — The existing surface infrastructure is well-tested. Adding members to `BrowserSlashCommandSurface` and routing through the same `SURFACE_COMMANDS` map keeps the architecture consistent. However, the GSD surfaces need different treatment than built-in surfaces:
- The GSD subcommand comes from `args` not `name` (since `name` is always `"gsd"`)
- Some GSD surfaces need dedicated pages (visualize, knowledge) not the Sheet overlay
- Some GSD commands need both a surface AND data loading via new API routes

The cleanest approach: add a **GSD dispatch function** (`dispatchGSDSubcommand`) that `dispatchBrowserSlashCommand` calls when `name === "gsd"`. This function parses the subcommand from args and returns the appropriate dispatch result. New `BrowserSlashCommandSurface` union members use the `"gsd-"` prefix to distinguish from built-in surfaces.

### Build Order

1. **Dispatch layer first** — Extend `browser-slash-command-dispatch.ts` with GSD subcommand routing. This is the foundation everything else depends on. Deliverable: every `/gsd X` returns a defined dispatch result (surface, prompt passthrough, or reject). No command falls through silently.

2. **Contract types second** — Extend `command-surface-contract.ts` with new `BrowserSlashCommandSurface` union members, `CommandSurfaceSection` variants, and placeholder `CommandSurfaceTarget` kinds for each GSD surface.

3. **Store wiring third** — Update `IMPLEMENTED_BROWSER_COMMAND_SURFACES` in `gsd-workspace-store.tsx` and add routing in `submitInput()` for GSD surfaces. Add stub surface open handlers.

4. **Parity test last** — Update `web-command-parity-contract.test.ts` to assert every GSD subcommand has an explicit dispatch outcome. This is the acceptance gate.

### Verification Approach

- **Primary:** Updated `web-command-parity-contract.test.ts` passes — every `/gsd` subcommand has a defined dispatch outcome, no silent fallthrough.
- **Build:** `npm run build` and `npm run build:web-host` succeed with new types.
- **Exhaustive dispatch test:** A new test iterates all subcommands from `commands.ts` and asserts each dispatches to either `"surface"`, `"prompt"` (bridge passthrough), or `"reject"` — never undefined or unclassified.
- **Surface stubs:** Each new `BrowserSlashCommandSurface` member has a corresponding `CommandSurfaceSection` and placeholder target — surfaces open without runtime errors even before S04–S07 build real content.

## Constraints

- **`BrowserSlashCommandSurface` is used in the store, contract, and component files** — adding new members requires coordinated updates across 4+ files. All changes must compile together.
- **`/export` collision** — Built-in `/export` (session HTML export) is already a `BrowserSlashCommandSurface` member. `/gsd export` (milestone/slice data export) is a different command. The dispatch must handle both correctly — `/export` stays as-is, `/gsd export` routes to a new `"gsd-export"` surface.
- **Bridge passthrough commands still need to work** — Commands classified as bridge-execute must continue reaching the bridge. The dispatch must not accidentally intercept them as surfaces.
- **Existing test expects `/gsd` to be a prompt passthrough** — `web-command-parity-contract.test.ts` line ~135 asserts `/gsd status` returns `kind: "prompt"`. This test must be updated to expect the new dispatch outcomes.

## Common Pitfalls

- **Forgetting to update `IMPLEMENTED_BROWSER_COMMAND_SURFACES`** — Adding a new `BrowserSlashCommandSurface` member without adding it to this set causes the surface to be dispatched but never rendered. The `submitInput()` code falls through to the notice path instead of opening the surface.
- **GSD subcommand parsing edge cases** — `/gsd` with no args should passthrough to bridge (it defaults to `/gsd next`). `/gsd help` should render help inline. `/gsd unknown-command` should passthrough to bridge (the extension handler shows "Unknown: /gsd unknown-command").
- **`commandSurfaceSectionForRequest` must handle new surfaces** — If a new surface name isn't in the switch statement, `commandSurfaceSectionForRequest` returns `null`, which causes `openCommandSurfaceState` to set `section: null`. This breaks section tab rendering.
