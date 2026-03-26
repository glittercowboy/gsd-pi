# Plan: Left Pane Native TUI on Main Bridge Session

## Goal

Make the **left pane in Power User Mode** render the **real native GSD/pi TUI** while staying attached to the **same authoritative main session** already used by:

- the web chat view
- dashboard / progress / status surfaces
- command surfaces
- session browser / recovery surfaces

At the same time, keep the **right pane unchanged** as a **separate PTY-backed GSD session**.

## Required outcome

### Main session surfaces must all stay in sync

The following must all reflect the **same main session** at the same time:

- left Power User pane
- web chat main transcript
- dashboard / progress / status
- command surfaces and settings surfaces
- session browser active-session state

### Right pane remains separate

The current right-side PTY session remains:

- PTY-backed
- independent
- detached from the main bridge session
- useful as a scratch / secondary interactive session

## Current architecture

### Left pane today

The left pane is currently `web/components/gsd/terminal.tsx`, which is **not** the native TUI. It is a browser-native summary / interaction surface backed by:

- `/api/boot`
- `/api/session/events`
- `/api/session/command`
- `web/lib/gsd-workspace-store.tsx`

It renders bridge state, transcript summaries, tool activity, and an input box, but not the real pi/GSD terminal UI.

### Right pane today

The right pane is `web/components/gsd/shell-terminal.tsx`, backed by:

- `node-pty`
- `/api/terminal/stream`
- `/api/terminal/input`
- `/api/terminal/resize`
- `/api/terminal/sessions`
- `web/lib/pty-manager.ts`

It launches a separate interactive `gsd` process.

### Main bridge today

The authoritative main web session is hosted through `src/web/bridge-service.ts` by spawning a child in RPC mode. That main session already drives:

- boot payload
- SSE event streaming
- browser command routing
- current web transcript and live tool state

## Correct target architecture

## Two runtimes, one shared main-session runtime surface

### Runtime A — authoritative main session

This runtime owns **one AgentSession** and must power all of the following:

- web chat
- dashboard / status / progress
- command surfaces
- session browser active session state
- **left native TUI pane**

### Runtime B — separate PTY session

This remains the existing right-side PTY path and powers:

- **right pane only**

## Non-goals

The following are explicitly out of scope for this change:

- changing the right PTY session semantics
- merging the right PTY into the main session
- making the right PTY share the main session file/runtime
- replacing browser chat/dashboard with TUI parsing
- using session files as a multi-writer sync mechanism

## Core implementation strategy

## 1. Add a terminal injection seam to native interactive mode

Today `InteractiveMode` constructs `ProcessTerminal` directly. To render the native TUI in the browser, interactive mode must be able to run against an injected terminal implementation instead.

### Required refactor

Refactor interactive-mode construction so it can accept a `Terminal` implementation from `@gsd/pi-tui` rather than always using `ProcessTerminal`.

### Constraints

- existing CLI behavior must remain unchanged
- normal terminal launches should still default to `ProcessTerminal`
- this must be a safe refactor with no product behavior change outside the new web path

## 2. Build a browser-backed terminal adapter for the main session

Add a new terminal host for the left pane that implements the `@gsd/pi-tui` `Terminal` contract using browser transport instead of process stdin/stdout.

### Browser-backed terminal responsibilities

- receive keyboard input from the browser
- receive resize events from the browser
- emit ANSI output to the browser
- support clear / cursor / title operations expected by the native TUI
- maintain reconnect-safe session attachment behavior

### Important distinction

This is **not** a PTY.

It is a **remote terminal transport for the native TUI of the main bridge session**.

## 3. Upgrade the main bridge host into a hybrid runtime

The main session host must expose two front doors into the **same AgentSession**:

- existing RPC command/event path for browser store/chat/dashboard
- native TUI path for the left pane

This likely requires extending `src/web/bridge-service.ts` or adding a dedicated main-session host abstraction above it.

### Invariant

There must be **one main AgentSession**, not one per surface.

## 4. Replace the left pane with a native-TUI browser terminal

In `web/components/gsd/dual-terminal.tsx`, replace the current left browser summary terminal with a new component that renders the real native TUI attached to the main session.

### Desired component behavior

- connect to the browser-backed main-session terminal transport
- render the actual native GSD/pi TUI
- send keyboard input and resize events
- never spawn a second main session
- reconnect cleanly after panel toggles / page reloads

## 5. Preserve sync for TUI-originated state changes

This is the main correctness risk.

Today the browser store stays accurate because browser mutations mostly flow through RPC commands and explicit bridge refreshes. Once the left native TUI can change settings/session state directly, the web surfaces must still update immediately.

### State changes that must remain synchronized

- model changes
- thinking level changes
- steering mode changes
- follow-up mode changes
- session rename
- new session / switch session
- auto-compaction toggle
- auto-retry toggle
- retry cancellation

### Required hardening

Add explicit session-state refresh or invalidation from the main runtime whenever the native TUI mutates session state.

Acceptable approaches:

- emit a dedicated session-state-changed event
- trigger bridge snapshot refresh internally on known mutation points
- add explicit state fanout from the shared main runtime host

### Unacceptable approach

Do **not** rely on session-file persistence alone to keep browser state correct.

## 6. Keep the current browser-native chat/dashboard path

The browser-native store and chat rendering should remain the source for:

- main chat transcript
- tool execution summaries
- command surfaces
- dashboard status
- recovery/session browser UI

The left pane should become **another front-end onto the same main runtime**, not a replacement for those browser-native surfaces.

## Phased execution plan

## Phase 1 — interactive-mode terminal injection

### Objective

Make native interactive mode runnable on an injected terminal implementation.

### Likely files

- `packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts`
- possibly small supporting constructor / export updates in mode wiring

### Deliverable

Interactive mode can be instantiated with either:

- default `ProcessTerminal`
- injected browser-backed terminal

## Phase 2 — main-session browser terminal transport

### Objective

Create the transport layer for the left pane.

### Likely additions

- browser-terminal host inside the main bridge runtime
- new API routes under something like `web/app/api/bridge-terminal/*`
- new browser component under `web/components/gsd/`

### Deliverable

A browser terminal can attach to the main session and receive native TUI output.

## Phase 3 — hybrid main-session host

### Objective

Make the main bridge session expose both:

- RPC/event API
- native TUI terminal stream

### Likely files

- `src/web/bridge-service.ts`
- bridge child/runtime bootstrap logic
- any supporting runtime/session abstractions

### Deliverable

The same main session powers both the browser store and the left native TUI.

## Phase 4 — left pane replacement

### Objective

Swap Power User Mode left pane from browser summary terminal to the native TUI terminal view.

### Likely files

- `web/components/gsd/dual-terminal.tsx`
- new left terminal component

### Deliverable

Left pane visually and behaviorally matches native GSD/pi TUI while remaining attached to the main session.

## Phase 5 — state synchronization hardening

### Objective

Ensure left-TUI-originated changes immediately update browser-native surfaces.

### Likely files

- `packages/pi-coding-agent/src/core/agent-session.ts`
- `src/web/bridge-service.ts`
- `web/lib/gsd-workspace-store.tsx`

### Deliverable

Chat, dashboard, session browser, command surfaces, and left TUI all stay aligned when state changes from either side.

## Phase 6 — reconnect and lifecycle handling

### Objective

Make left terminal attachment robust across browser lifecycle events.

### Behaviors to support

- tab reload
- Power User Mode hide/show
- SSE reconnects
- stale client disconnects

### Deliverable

The left pane reattaches to the main runtime without creating a new main session.

## Verification plan

## Functional verification

Verify that all of the following use the same main session:

- boot snapshot active session
- chat transcript updates
- left native TUI session title / state
- dashboard / progress state
- command-surface session operations

## Sync verification

From the left native TUI, verify that changing:

- model
- thinking
- session name
- queue/retry settings

is reflected in the browser surfaces without requiring manual refresh.

## Isolation verification

Verify that the right pane remains separate:

- different session/runtime
- its actions do not mutate the main bridge session unless explicitly designed to
- no accidental reuse of the main bridge runtime for the right pane

## Regression verification

Ensure existing bridge contract behavior still holds for:

- `/api/boot`
- `/api/session/events`
- `/api/session/command`
- session browser parity
- browser slash-command routing

## Test updates to add

Add or extend tests for the following contracts:

### Main-session terminal parity

- left terminal attaches to the same active session as bridge/chat/dashboard
- no second main session is created for the left pane

### TUI-originated state mutation sync

- model/thinking/session changes from the left TUI propagate to browser state

### Right-pane isolation

- right pane still launches independent PTY session
- right pane does not become authoritative for main-session state

### Reconnect behavior

- page reload preserves attachment to the same main session
- left terminal can reconnect without respawning main session

## Key risks

## Risk 1 — interactive mode still assumes process terminal behavior

Even after constructor injection, there may be hidden assumptions in interactive mode or pi-tui that need cleanup for remote-terminal hosting.

## Risk 2 — state mutation fanout gaps

The current bridge/store path assumes many mutations happen via RPC. Left-TUI-originated mutations will expose gaps unless explicit state refresh is added.

## Risk 3 — lifecycle complexity in the main bridge host

The bridge currently handles RPC child startup, onboarding auth refresh, and SSE subscribers. Adding native TUI hosting increases lifecycle complexity and will need careful attachment/reconnect rules.

## Risk 4 — accidental blending with right-pane PTY logic

The right-pane PTY path should remain independent. Reusing PTY-specific assumptions for the left pane would reintroduce detached-session drift.

## Initial file map

### Main runtime / session ownership
- `src/web/bridge-service.ts`
- `src/web/cli-entry.ts`

### Native TUI runtime seam
- `packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/pi-tui/src/terminal.ts`
- `packages/pi-tui/src/tui.ts`

### Web left-pane UI
- `web/components/gsd/dual-terminal.tsx`
- new bridge-native terminal component under `web/components/gsd/`

### Existing right-pane UI to keep stable
- `web/components/gsd/shell-terminal.tsx`
- `web/lib/pty-manager.ts`
- `web/app/api/terminal/*`

### Browser sync surfaces
- `web/lib/gsd-workspace-store.tsx`
- `web/components/gsd/chat-mode.tsx`
- `web/components/gsd/dashboard.tsx`
- `web/components/gsd/command-surface.tsx`

## Final architecture rule

### Runtime A — authoritative main session
Powers:
- left native TUI
- chat
- dashboard/status
- command surfaces
- session browser active session state

### Runtime B — separate PTY session
Powers:
- right pane only

This rule should be treated as the invariant for implementation and tests.
