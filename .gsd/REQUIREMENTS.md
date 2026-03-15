# Requirements

This file is the explicit capability and coverage contract for the project.

Use it to track what is actively in scope, what has been validated by completed work, what is intentionally deferred, and what is explicitly out of scope.

Guidelines:
- Keep requirements capability-oriented, not a giant feature wishlist.
- Requirements should be atomic, testable, and stated in plain language.
- Every **Active** requirement should be mapped to a slice, deferred, blocked with reason, or moved out of scope.
- Each requirement should have one accountable primary owner and may have supporting slices.
- Research may suggest requirements, but research does not silently make them binding.
- Validation means the requirement was actually proven by completed work and verification, not just discussed.

## Active

### R004 — Primary GSD workflow runs end-to-end in the browser without opening TUI
- Class: primary-user-loop
- Status: active
- Description: Users must be able to start or resume work, interact with the agent, answer prompts, and complete the primary GSD workflow entirely in the browser.
- Why it matters: If the core workflow still needs the TUI, web mode is only a sidecar.
- Source: user
- Primary owning slice: M001/S07
- Supporting slices: M001/S01, M001/S02, M001/S03, M001/S04, M001/S05, M001/S06
- Validation: mapped
- Notes: This closes only when the assembled system is exercised end-to-end in a real project.

### R005 — Existing skin becomes a live workspace rather than a mock shell
- Class: core-capability
- Status: active
- Description: The existing dashboard, terminal, power, roadmap, files, and activity surfaces in `web/` must be wired to real GSD data and actions.
- Why it matters: The user explicitly wants the exact skin preserved and integrated, not replaced with a new UI.
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: M001/S03, M001/S05, M001/S06
- Validation: mapped
- Notes: M001 uses the existing skin as the UI contract.

### R006 — Agent interruptions are handled in a focused web panel
- Class: continuity
- Status: validated
- Description: Confirmations, choices, text input, editor-style interruptions, and similar mid-run agent requests must be handled in a focused primary web surface rather than buried modals.
- Why it matters: The browser needs a clear interaction model for live agent work, or parity will break under real prompts.
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: M001/S07
- Validation: verified by `src/tests/web-live-interaction-contract.test.ts` (10/10 — UI request lifecycle, transcript streaming, steer/abort, fire-and-forget state, failure paths), `npm run build:web-host` (focused panel and terminal controls compile and mount), and existing bridge/onboarding tests (10/10 — no regressions).
- Notes: S03 proves the focused panel for all 4 blocking methods (select, confirm, input, editor) plus multi-request queue, dismiss/cancel, and failure visibility. Full end-to-end exercise with real agent prompts closes in S07.

### R007 — Session continuity works across refresh/reopen and supports resume inside web mode
- Class: continuity
- Status: validated
- Description: Users can refresh or reopen the browser workspace, reattach to the correct current-project session state, and resume work from the web UI.
- Why it matters: Browser mode stops feeling first-class if normal browser lifecycle behavior loses context or control.
- Source: inferred
- Primary owning slice: M001/S06
- Supporting slices: M001/S05, M001/S07
- Validation: verified by `src/tests/web-continuity-contract.test.ts` (14/14 — reconnect resync, visibility-return refresh, transcript cap, command timeout), sessionStorage view persistence in app-shell, and `npm run build:web-host` (all continuity components compile and mount).
- Notes: This covers current-project continuity, not cross-project switching.

### R008 — Live web mode never mixes mock data with real GSD state
- Class: constraint
- Status: active
- Description: Core web workspace views must not ship with mixed mock/live content once they are declared integrated.
- Why it matters: Fake/live mixing destroys trust and makes parity claims impossible to verify.
- Source: inferred
- Primary owning slice: M001/S04
- Supporting slices: M001/S07
- Validation: mapped
- Notes: M001 should remove placeholder data from core views rather than layering real state on top of it.

### R009 — Web mode feels snappy and fast
- Class: quality-attribute
- Status: active
- Description: Streaming, navigation, updates, and prompt handling in web mode must feel snappy and fast under normal local use.
- Why it matters: The user explicitly called out speed as a non-negotiable quality bar.
- Source: user
- Primary owning slice: M001/S06
- Supporting slices: M001/S01, M001/S03, M001/S04, M001/S05, M001/S07
- Validation: mapped
- Notes: Preserve the user's exact phrasing: "snappy and fast."

### R010 — Failures are visible and recoverable in-browser
- Class: failure-visibility
- Status: validated
- Description: Setup failures, bridge disconnects, blocked actions, and agent/runtime errors must be visible in-browser with a clear recovery path.
- Why it matters: A browser-first path becomes fragile if the user has to guess what failed or fall back to terminal debugging.
- Source: research
- Primary owning slice: M001/S06
- Supporting slices: M001/S03, M001/S04, M001/S07
- Validation: verified by `src/tests/web-continuity-contract.test.ts` (command timeout clears stuck state with error visibility, reconnect resync recovers from bridge disconnects), error banner retry button in app-shell (`data-testid="workspace-error-banner"`), and `npm run build:web-host` (all failure surfaces compile).
- Notes: This is especially important because `--web` intentionally suppresses TUI fallback.

### R011 — Remaining lower-frequency TUI capabilities reach browser parity after the primary loop
- Class: core-capability
- Status: active
- Description: After the primary browser-first loop is real, the remaining lower-frequency TUI capabilities should be brought into browser parity as needed for daily use.
- Why it matters: The stated goal is full parity with what the TUI can do, not just a browser path for the main happy path.
- Source: user
- Primary owning slice: M002 (provisional)
- Supporting slices: none
- Validation: mapped
- Notes: Exact ownership should be refined after M001 exposes the real gap list.

## Validated

### R001 — Browser-only `--web` launch path
- Class: launchability
- Status: validated
- Description: Running `gsd --web` starts browser mode for the current project, auto-opens the web workspace, and does not launch the Pi/GSD TUI.
- Why it matters: The browser-first product path is not real if it still depends on the TUI at startup.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S07
- Validation: verified by `src/tests/web-mode-cli.test.ts`, the slice-level runtime integration test, and a fresh browser launch with no console errors.
- Notes: S01 proved the launch path itself; broader browser-first workflow coverage remains with later slices.

### R002 — Browser onboarding validates required setup and unlocks the workspace entirely in-browser
- Class: launchability
- Status: validated
- Description: A first-run `gsd --web` user must be able to complete required setup in-browser, validate required credentials, and reach an unlocked usable workspace without touching the TUI.
- Why it matters: Browser mode is not operationally real if first-run setup still needs terminal fallback or lets invalid credentials silently through.
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: M001/S01, M001/S07
- Validation: verified by `src/tests/web-onboarding-contract.test.ts`, `src/tests/integration/web-mode-onboarding.test.ts`, `npm run build:web-host`, and a fresh-profile runtime spot-check of `/api/boot`, `/api/onboarding`, and blocked `/api/session/command` responses.
- Notes: S02 proves onboarding gating, validation, bridge-auth refresh, and first-command unlock inside the preserved shell; full end-to-end browser workflow still closes in S07.

### R003 — Web mode opens into the current project/cwd workspace
- Class: primary-user-loop
- Status: validated
- Description: `gsd --web` should open directly into the current working directory's GSD workspace rather than a generic launcher.
- Why it matters: This keeps the web path aligned with how GSD is launched today and avoids friction at the point of use.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S04
- Validation: verified by `/api/boot`, the slice-level runtime integration test, and browser rendering of the live current-project scope/state.
- Notes: Broader project switching is allowed later, but current-project launch is now real.

## Deferred

### R020 — Cross-project launcher / recent-project hub beyond current cwd
- Class: admin/support
- Status: deferred
- Description: Support broader project/session switching beyond the current-project launch contract.
- Why it matters: It may become useful once browser mode is established, but it is not required to make `gsd --web` real.
- Source: inferred
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Current-project launch is the primary requirement for now.

### R021 — Deep historical analytics beyond the live activity surfaces
- Class: operability
- Status: deferred
- Description: Add deeper analytics/history views beyond the live dashboard and activity surfaces required for the core web workflow.
- Why it matters: This may improve long-term observability, but it is not part of the initial browser-first contract.
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Revisit only if live usage shows the built-in activity surfaces are too thin.

### R022 — Remote / LAN / shared access to the web workspace
- Class: operability
- Status: deferred
- Description: Support using the browser workspace from outside the local machine or sharing it across users.
- Why it matters: This may matter later, but it adds security and lifecycle complexity that is not needed for the initial local browser-first path.
- Source: inferred
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: M001 should stay local and current-project scoped.

## Out of Scope

### R030 — Open TUI alongside `--web`
- Class: anti-feature
- Status: out-of-scope
- Description: `gsd --web` should not launch the TUI in parallel or rely on a visible TUI session.
- Why it matters: This prevents the browser path from becoming a disguised sidecar.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: This is a hard product boundary for M001.

### R031 — Re-skin or redesign the current UI during initial integration
- Class: anti-feature
- Status: out-of-scope
- Description: M001 should not spend time redesigning the current UI skin instead of wiring it into live GSD behavior.
- Why it matters: It keeps scope focused on integration and parity rather than aesthetic churn.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: "Just use the exact skin in the test UI and wire it into GSD."

### R032 — Separate cloud backend for core web mode
- Class: constraint
- Status: out-of-scope
- Description: Core web mode should not depend on a separate cloud-hosted backend to function.
- Why it matters: The requested scope is "just gsd," running locally from the CLI launch path.
- Source: inferred
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Local host + local agent bridge is the expected shape.

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | launchability | validated | M001/S01 | M001/S07 | validated |
| R002 | launchability | validated | M001/S02 | M001/S01, M001/S07 | validated |
| R003 | primary-user-loop | validated | M001/S01 | M001/S04 | validated |
| R004 | primary-user-loop | active | M001/S07 | M001/S01, M001/S02, M001/S03, M001/S04, M001/S05, M001/S06 | mapped |
| R005 | core-capability | active | M001/S04 | M001/S03, M001/S05, M001/S06 | mapped |
| R006 | continuity | validated | M001/S03 | M001/S07 | validated |
| R007 | continuity | validated | M001/S06 | M001/S05, M001/S07 | validated |
| R008 | constraint | active | M001/S04 | M001/S07 | mapped |
| R009 | quality-attribute | active | M001/S06 | M001/S01, M001/S03, M001/S04, M001/S05, M001/S07 | mapped |
| R010 | failure-visibility | validated | M001/S06 | M001/S03, M001/S04, M001/S07 | validated |
| R011 | core-capability | active | M002 (provisional) | none | mapped |
| R020 | admin/support | deferred | none | none | unmapped |
| R021 | operability | deferred | none | none | unmapped |
| R022 | operability | deferred | none | none | unmapped |
| R030 | anti-feature | out-of-scope | none | none | n/a |
| R031 | anti-feature | out-of-scope | none | none | n/a |
| R032 | constraint | out-of-scope | none | none | n/a |

## Coverage Summary

- Active requirements: 3
- Mapped to concrete M001 slices: 2
- Validated: 8
- Unmapped active requirements: 0
irements: 0
/S05, M001/S07 | mapped |
| R010 | failure-visibility | validated | M001/S06 | M001/S03, M001/S04, M001/S07 | validated |
| R011 | core-capability | active | M002 (provisional) | none | mapped |
| R020 | admin/support | deferred | none | none | unmapped |
| R021 | operability | deferred | none | none | unmapped |
| R022 | operability | deferred | none | none | unmapped |
| R030 | anti-feature | out-of-scope | none | none | n/a |
| R031 | anti-feature | out-of-scope | none | none | n/a |
| R032 | constraint | out-of-scope | none | none | n/a |

## Coverage Summary

- Active requirements: 5
- Mapped to concrete M001 slices: 5
- Validated: 6
- Unmapped active requirements: 0
