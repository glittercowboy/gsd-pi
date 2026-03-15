# M001: Web mode foundation

**Vision:** Use the existing web skin in `web/` as the browser-first front end for GSD. This milestone adds `gsd --web`, validated in-browser first-run setup, a live bridge to the agent and project state, and enough real browser workflow to start or resume work and complete the primary GSD loop without ever opening the TUI.

## Success Criteria

- Running `gsd --web` starts browser mode for the current project, opens the browser automatically, and does not open the TUI.
- A first-time user can complete browser onboarding, enter required keys, validate them, and reach a usable workspace without touching the terminal again.
- The existing dashboard, terminal, power, roadmap, files, and activity surfaces in `web/` are backed by real GSD state/actions instead of mock data.
- A user can start or resume work, interact with the live agent, answer prompts in the focused panel, and complete the primary workflow entirely in-browser.
- The assembled browser path feels snappy and fast in normal local use and exposes failures/recovery in-browser.

## Key Risks / Unknowns

- The current RPC/event surface may not expose enough state and control for full browser-first operation.
- The existing Next.js skin may be the right host shell or unnecessary runtime weight; this has to be proven by integration rather than preference.
- Browser onboarding must validate required credentials without making startup feel slow or fragile.
- Current-project continuity and prompt interruptions may feel awkward in-browser unless the contracts are designed deliberately.

## Proof Strategy

- RPC/event surface gaps → retire in S03 by proving the browser can drive live prompting, stream output, and answer focused interruption requests without TUI fallback.
- Next.js-vs-React / local host uncertainty → retire in S01 by proving the existing skin can run as a live current-project workspace behind the chosen local host/bridge shape.
- Browser onboarding viability → retire in S02 by proving a fresh user can enter and validate required credentials and reach the workspace entirely in-browser.
- Continuity / browser lifecycle risk → retire in S06 by proving refresh/reopen and failure visibility keep the user attached to the correct current-project session.

## Verification Classes

- Contract verification: CLI flag parsing checks, host/bridge contract tests, onboarding validation tests, state/view-model wiring checks, and mock-data removal assertions for integrated views.
- Integration verification: real local `gsd --web` runs against an actual project, live RPC session, real onboarding state, and real browser interaction.
- Operational verification: browser auto-open, no-TUI startup, refresh/reopen continuity, current-project reattachment, and visible recovery from expected failure states.
- UAT / human verification: quick subjective pass that the exact skin still feels intact and that the browser path stays snappy and fast.

## Milestone Definition of Done

This milestone is complete only when all are true:

- all M001 slices are complete
- the `gsd --web` entrypoint exists and is exercised in a real project
- browser onboarding blocks on required credentials until validation passes
- the exact existing skin is wired to real state/actions for its core views
- start/resume, live interaction, and focused prompt handling work entirely in-browser
- refresh/reopen continuity and browser-visible recovery paths work for normal local use
- success criteria are re-checked against live behavior, not just artifacts
- the final integrated acceptance scenario passes without opening the TUI

## Requirement Coverage

- Covers: R001, R002, R003, R004, R005, R006, R007, R008, R009, R010
- Partially covers: R011
- Leaves for later: R020, R021, R022
- Orphan risks: none

## Slices

- [x] **S01: Web host + agent bridge** `risk:high` `depends:[]`
  > After this: running `gsd --web` opens a live browser workspace for the current project, and the UI can connect to real GSD session state/events through a local bridge instead of placeholders.

- [x] **S02: First-run setup wizard** `risk:high` `depends:[S01]`
  > After this: a fresh user can complete required/optional setup in-browser, required keys are tested, and the workspace stays gated until setup passes.

- [x] **S03: Live terminal + focused prompt handling** `risk:high` `depends:[S01,S02]`
  > After this: the browser can send prompts, stream agent output, and answer agent questions/confirmations/editor requests in the focused panel without TUI fallback.

- [x] **S04: Current-project state surfaces** `risk:medium` `depends:[S01,S03]`
  > After this: dashboard, roadmap, files, and activity views show real current-project data and live session context rather than mock values.

- [x] **S05: Start/resume workflow controls** `risk:medium` `depends:[S03,S04]`
  > After this: users can start new work or resume interrupted work from the skin’s controls instead of typing hidden terminal commands.

- [x] **S06: Power mode + continuity + failure visibility** `risk:medium` `depends:[S03,S04,S05]`
  > After this: richer control surfaces stay attached across refresh/reopen, show recoverable failure states, and keep the experience snappy and fast under normal use.

- [x] **S07: End-to-end web assembly proof** `risk:high` `depends:[S01,S02,S03,S04,S05,S06]`
  > After this: `gsd --web` works end-to-end in a real project—launch, onboard, start or resume, interact with the agent, and complete the primary workflow entirely in-browser.

## Boundary Map

### S01 → S02

Produces:
- CLI contract: `gsd --web` selects browser mode and suppresses TUI launch.
- Local host contract: the browser workspace is served on loopback with auto-open behavior.
- Current-project boot payload: cwd, project metadata, onboarding status, available sessions.
- Live bridge transport: request/response plus streaming event channel between browser workspace and a GSD RPC session.

Consumes:
- nothing (first slice)

### S01 + S02 → S03

Produces:
- Onboarding gate contract: workspace blocks interactive actions until required setup passes.
- Credential validation results surface: provider/tool key validity, error states, and completion state.
- Prompt/interrupt contract: browser can render and answer `extension_ui_request` payloads (`select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`).
- Live terminal command surface: send `prompt`, `steer`, `follow_up`, `abort`, and receive streaming agent/tool events.

Consumes from S01:
- Live bridge transport.
- Current-project boot payload.

Consumes from S02:
- Onboarding completion state and validated credentials.

### S01 + S03 → S04

Produces:
- Real workspace store/view models for dashboard, roadmap, files, and activity.
- State mapping from GSD project artifacts/sessions to UI view models.
- Mock-data removal invariant for core views.

Consumes from S01:
- Current-project boot payload.
- Bridge access to session and project state.

Consumes from S03:
- Live agent/session events for activity/status surfaces.

### S03 + S04 → S05

Produces:
- UI actions for start work, resume work, continue active session, and key GSD workflow entrypoints.
- Mapping from skin controls/buttons to GSD commands/session operations.

Consumes from S03:
- Live terminal/prompt execution surface.

Consumes from S04:
- Real roadmap/state/files/activity context to decide what actions are available.

### S03 + S04 + S05 → S06

Produces:
- Power mode contract backed by real session streams and controls.
- Continuity contract for refresh/reopen/current-project reattachment.
- Failure visibility surfaces for disconnected bridge, failed validation, agent errors, and blocked actions.
- Performance budget/invariants for "snappy and fast" browser interaction.

Consumes from S03:
- Live event and prompt surface.

Consumes from S04:
- Real UI state models.

Consumes from S05:
- Start/resume workflow actions.

### S01 + S02 + S03 + S04 + S05 + S06 → S07

Produces:
- Integrated `gsd --web` flow proven against a real project.
- End-to-end acceptance checks for launch, onboarding, start/resume, live interaction, and no-TUI execution.

Consumes from S01-S06:
- The assembled web host, onboarding, bridge, live state, workflow controls, continuity, and failure surfaces as one real system.
