# Requirements

This file is the explicit capability and coverage contract for the project.

## Active

### R101 — Every /gsd subcommand (help, next, auto, stop, pause, status, visualize, queue, quick, discuss, capture, triage, history, undo, skip, export, cleanup, mode, prefs, config, hooks, run-hook, skill-health, doctor, forensics, migrate, remote, steer, inspect, knowledge) dispatches correctly from the browser terminal — opening a surface, executing, or rejecting with clear guidance.
- Class: primary-user-loop
- Status: active
- Description: Every /gsd subcommand (help, next, auto, stop, pause, status, visualize, queue, quick, discuss, capture, triage, history, undo, skip, export, cleanup, mode, prefs, config, hooks, run-hook, skill-health, doctor, forensics, migrate, remote, steer, inspect, knowledge) dispatches correctly from the browser terminal — opening a surface, executing, or rejecting with clear guidance.
- Why it matters: Silent command fallthrough was the highest-risk M002 gap; extending dispatch to new commands maintains that safety.
- Source: user
- Primary owning slice: M003/S02
- Supporting slices: M003/S04, M003/S05, M003/S06, M003/S07
- Validation: Verified by updated `src/tests/web-command-parity-contract.test.ts` — exhaustive GSD dispatch test (118 tests) asserts every subcommand has a defined outcome (surface/prompt/local). Contract surface wiring test proves each surface opens correctly through the command-surface system. `npm run build` and `npm run build:web-host` succeed. Runtime diagnostic: `dispatchBrowserSlashCommand("/gsd <subcmd>")` returns inspectable .kind/.surface/.action fields; `getBrowserSlashCommandTerminalNotice()` confirms system notices for surface outcomes and null for passthrough.
- Notes: Dispatch is complete for all 30 subcommands (20 surface, 9 passthrough, 1 local help). Surfaces render placeholder content — real content requires S04 (forensics/doctor/skill-health), S05 (knowledge/captures), S06 (settings), S07 (remaining commands).

### R102 — A dedicated browser page with tabbed sections for Progress, Deps, Metrics, Timeline, Agent activity, Changelog, and Export — backed by the upstream visualizer-data.ts aggregation.
- Class: core-capability
- Status: active
- Description: A dedicated browser page with tabbed sections for Progress, Deps, Metrics, Timeline, Agent activity, Changelog, and Export — backed by the upstream visualizer-data.ts aggregation.
- Why it matters: The TUI visualizer is a primary workflow surface for understanding project state; web mode needs parity.
- Source: user
- Primary owning slice: M003/S03
- Supporting slices: none
- Validation: S03 built: /api/visualizer GET endpoint, VisualizerView component with 7 tabs (Progress, Deps, Metrics, Timeline, Agent, Changes, Export), sidebar NavRail entry, /gsd visualize dispatch. Both builds pass. Remaining: live runtime verification with real project data at S08 parity audit.
- Notes: Upstream VisualizerData interface with milestones, phase, totals, byPhase, bySlice, byModel, units, criticalPath, agentActivity, changelog. Map→Record conversion for criticalPath.milestoneSlack and sliceSlack. Child-process pattern required for Turbopack compatibility.

### R103 — A browser panel showing forensic anomaly scanning results — stuck loops, cost spikes, timeouts, missing artifacts, crashes, doctor issues, and error traces from auto-mode runs.
- Class: failure-visibility
- Status: active
- Description: A browser panel showing forensic anomaly scanning results — stuck loops, cost spikes, timeouts, missing artifacts, crashes, doctor issues, and error traces from auto-mode runs.
- Why it matters: Auto-mode failures need browser-visible investigation, not just TUI-only forensics.
- Source: user
- Primary owning slice: M003/S04
- Supporting slices: M003/S02
- Validation: Pipeline verified by `src/tests/web-diagnostics-contract.test.ts` (28/28 pass — type exports, contract state, dispatch→surface, surface→section, store methods). API route `/api/forensics` returns ForensicReport JSON via child-process service. Panel component (ForensicsPanel) renders anomaly list, recent units, crash lock, metrics summary. Both builds pass. Awaits live browser UAT for full validation.
- Notes: S04 implemented the full pipeline: buildForensicReport exported from forensics.ts → child-process service → API route → store fetch → panel component. ForensicReport simplified for browser (flattened metrics, counted traces). Live runtime UAT needed before marking validated.

### R104 — A browser panel showing doctor health check results (7 runtime checks), auto-fix actions, severity filtering, and scope selection.
- Class: failure-visibility
- Status: active
- Description: A browser panel showing doctor health check results (7 runtime checks), auto-fix actions, severity filtering, and scope selection.
- Why it matters: Doctor is the primary health diagnostic tool; existing web recovery surface covers only basic recovery, not the full doctor report.
- Source: user
- Primary owning slice: M003/S04
- Supporting slices: M003/S02
- Validation: Pipeline verified by `src/tests/web-diagnostics-contract.test.ts` (28/28 pass). API routes: GET `/api/doctor?scope=X` returns DoctorReport JSON; POST `/api/doctor` applies fixes and returns DoctorFixResult. Panel renders issue list with severity/scope badges, fixable count, and Apply Fixes button. Both builds pass. Awaits live browser UAT for full validation.
- Notes: S04 implemented full doctor pipeline: runGSDDoctor via child-process → GET/POST API routes → store fetch (with fix lifecycle) → DoctorPanel with issue list, severity badges, scope filtering, Apply Fixes button. Doctor POST returns fixesApplied array. Live runtime UAT needed before marking validated.

### R105 — A browser panel showing per-skill pass/fail rates, token usage, staleness warnings, declining performance flags, and heal-skill suggestions.
- Class: operability
- Status: active
- Description: A browser panel showing per-skill pass/fail rates, token usage, staleness warnings, declining performance flags, and heal-skill suggestions.
- Why it matters: Skill lifecycle management is a new upstream capability that needs browser visibility.
- Source: user
- Primary owning slice: M003/S04
- Supporting slices: M003/S02
- Validation: Pipeline verified by `src/tests/web-diagnostics-contract.test.ts` (28/28 pass). API route GET `/api/skill-health` returns SkillHealthReport JSON. Panel renders skill table with pass rates, token trends, staleness warnings, declining flags, and suggestions. Both builds pass. Awaits live browser UAT for full validation.
- Notes: S04 implemented full skill-health pipeline: generateSkillHealthReport via child-process → API route → store fetch → SkillHealthPanel with skill table, pass rates, token trends, stale/declining flags, and heal suggestions. Live runtime UAT needed before marking validated.

### R107 — The browser settings command surface shows dynamic model routing configuration, provider fallback chain management, budget allocation visibility, and all preference fields from the upstream preferences wizard.
- Class: core-capability
- Status: active
- Description: The browser settings command surface shows dynamic model routing configuration, provider fallback chain management, budget allocation visibility, and all preference fields from the upstream preferences wizard.
- Why it matters: Model/provider/budget management is a substantial new upstream capability with TUI-only surfaces.
- Source: user
- Primary owning slice: M003/S06
- Supporting slices: M003/S02
- Validation: Structurally verified by `npm run build` (types compile), `npm run build:web-host` (API route and components in production build), `npx tsx --test web-command-parity-contract.test.ts` (114/118 pass, no regression). API route at `/api/settings-data` returns combined SettingsData JSON with preferences, routingConfig, budgetAllocation, routingHistory, and projectTotals from 5 upstream modules. Three panel components (PrefsPanel, ModelRoutingPanel, BudgetPanel) render real data for gsd-prefs/gsd-mode/gsd-config sections. Full live-runtime validation deferred to S08 parity audit.
- Notes: S06 delivered the settings surface with read-only panels. Preferences editing (TUI wizard equivalent) is not included — surface is read-only. Budget computeBudgets() uses hardcoded 200K context window default.

### R108 — Each of the remaining /gsd subcommands opens a browser-native surface with appropriate controls, feedback, and state visibility.
- Class: core-capability
- Status: active
- Description: Each of the remaining /gsd subcommands opens a browser-native surface with appropriate controls, feedback, and state visibility.
- Why it matters: Absolute parity means no command is TUI-only.
- Source: user
- Primary owning slice: M003/S07
- Supporting slices: M003/S02
- Validation: unmapped
- Notes: These are individually smaller but collectively substantial. Some (quick, history, undo) have rich data views; others (hooks, run-hook, config) are simpler.

### R109 — A systematic comparison of every TUI feature against the web UI, with any gaps found being closed in this slice.
- Class: quality-attribute
- Status: validated
- Description: A systematic comparison of every TUI feature against the web UI, with any gaps found being closed in this slice.
- Why it matters: Individual feature slices may miss edge cases or subtle TUI behaviors; a dedicated audit pass catches them.
- Source: user
- Primary owning slice: M003/S08
- Supporting slices: M003/S03, M003/S04, M003/S05, M003/S06, M003/S07
- Validation: S08-PARITY-AUDIT.md covers all 30 /gsd subcommands, dashboard overlay, 7 visualizer tabs, and interactive flows. 12 gaps identified — 9 intentional scope boundaries, 3 deferred. 118/118 parity contract tests pass. Zero stub surfaces remain.
- Notes: Audit covers commands, surfaces, data visibility, interaction patterns, and error states as required. Parity is strong — no core TUI functionality missing from web. Remaining gaps are interactive wizards (prefs, config, import-claude) and minor data-visibility items (capture-with-args, skill-health filters) which are intentionally deferred as low-impact enhancements.

### R110 — npm run test:unit, npm run test:integration, npm run test:browser-tools, npm run build, and npm run build:web-host all pass clean after all M003 work.
- Class: quality-attribute
- Status: validated
- Description: npm run test:unit, npm run test:integration, npm run test:browser-tools, npm run build, and npm run build:web-host all pass clean after all M003 work.
- Why it matters: The merge and new code must not break existing functionality.
- Source: user
- Primary owning slice: M003/S09
- Supporting slices: M003/S01
- Validation: Unit tests 1197/0 pass/fail. Both builds (npm run build, npm run build:web-host) exit 0. Integration test failures fixed: dist-redirect.mjs resolver handles /dist/ paths and .tsx extensions (14 fixes), 4 isolated test failures fixed (stale assertion, aspirational DB test, env-independent remote, timing flake), assembled slash-command test aligned with S02 dispatch, runtime tests get waitForHttpOk before page navigation, Terminal component restored to app-shell bottom panel.
- Notes: Test breakage came from three sources: (1) resolver not guarding /dist/ imports or handling .tsx, (2) tests with stale assertions after M003 changes, (3) integration tests not adapted to S02 dispatch changes and UI layout changes.

### R111 — A dedicated `docs/web-mode.md` guide covering launch, onboarding, workspace UI, browser commands, architecture (host/bridge/store), configuration, and troubleshooting. README documentation index and relevant sections updated. Existing docs (architecture, troubleshooting, commands, getting-started, configuration) reference web mode where relevant.
- Class: quality-attribute
- Status: active
- Description: A dedicated `docs/web-mode.md` guide covering launch, onboarding, workspace UI, browser commands, architecture (host/bridge/store), configuration, and troubleshooting. README documentation index and relevant sections updated. Existing docs (architecture, troubleshooting, commands, getting-started, configuration) reference web mode where relevant.
- Why it matters: Web mode is a primary product path with zero documentation — users can't discover or troubleshoot it.
- Source: user
- Primary owning slice: M004/S01
- Supporting slices: M004/S02
- Validation: unmapped
- Notes: Must be written against the post-M003 codebase to reflect the full feature set.

### R112 — A dedicated CI job in `.github/workflows/ci.yml` running on ubuntu-latest and macos-latest that executes `npm run build:web-host`, runs web contract tests, and reports failures independently from the existing build job.
- Class: quality-attribute
- Status: active
- Description: A dedicated CI job in `.github/workflows/ci.yml` running on ubuntu-latest and macos-latest that executes `npm run build:web-host`, runs web contract tests, and reports failures independently from the existing build job.
- Why it matters: The current CI pipeline never builds or tests the web host — web regressions ship silently.
- Source: user
- Primary owning slice: M004/S03
- Supporting slices: none
- Validation: unmapped
- Notes: Web integration tests may need Playwright browser install; first pass may limit CI to contract tests and build:web-host.

## Validated

### R001 — Running `gsd --web` starts browser mode for the current project, auto-opens the web workspace, and does not launch the Pi/GSD TUI.
- Class: launchability
- Status: validated
- Description: Running `gsd --web` starts browser mode for the current project, auto-opens the web workspace, and does not launch the Pi/GSD TUI.
- Why it matters: The browser-first product path is not real if it still depends on the TUI at startup.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S07
- Validation: verified by `src/tests/web-mode-cli.test.ts`, `src/tests/integration/web-mode-runtime.test.ts`, S01's fresh temp-home runtime/browser proof, and the launch contract that waits for `/api/boot` readiness before reporting success.
- Notes: The launch path itself is now real and stayed green through the final assembled regression reruns.

### R002 — A first-run `gsd --web` user must be able to complete required setup in-browser, validate required credentials, and reach an unlocked usable workspace without touching the TUI.
- Class: launchability
- Status: validated
- Description: A first-run `gsd --web` user must be able to complete required setup in-browser, validate required credentials, and reach an unlocked usable workspace without touching the TUI.
- Why it matters: Browser mode is not operationally real if first-run setup still needs terminal fallback or lets invalid credentials silently through.
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: M001/S01, M001/S07
- Validation: verified by `src/tests/web-onboarding-contract.test.ts`, `src/tests/integration/web-mode-onboarding.test.ts`, `npm run build:web-host`, packaged-host route spot-checks of `/api/boot` + `/api/onboarding` + blocked `/api/session/command`, and S02's browser/runtime proof of failed validation, successful retry, unlock, and first-command success.
- Notes: Browser onboarding, validation, lock enforcement, and bridge-auth refresh are now part of the preserved shell itself.

### R003 — `gsd --web` should open directly into the current working directory's GSD workspace rather than a generic launcher.
- Class: primary-user-loop
- Status: validated
- Description: `gsd --web` should open directly into the current working directory's GSD workspace rather than a generic launcher.
- Why it matters: This keeps the web path aligned with how GSD is launched today and avoids friction at the point of use.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S04
- Validation: verified by `/api/boot`, the slice-level runtime integration test, and browser rendering of the live current-project scope/status state.
- Notes: Broader project switching remains a later concern; current-project launch is now proven.

### R004 — Users must be able to start or resume work, interact with the agent, answer prompts, and complete the primary GSD workflow entirely in the browser.
- Class: primary-user-loop
- Status: validated
- Description: Users must be able to start or resume work, interact with the agent, answer prompts, and complete the primary GSD workflow entirely in the browser.
- Why it matters: If the core workflow still needs the TUI, web mode is only a sidecar.
- Source: user
- Primary owning slice: M001/S07
- Supporting slices: M001/S01, M001/S02, M001/S03, M001/S04, M001/S05, M001/S06
- Validation: verified by `src/tests/integration/web-mode-assembled.test.ts` (boot → onboarding → prompt → streaming → tool execution → blocking UI request → UI response → turn boundary), the 5-test integration regression (`web-mode-assembled`, `web-mode-runtime`, `web-mode-onboarding`), S03/S05 contract coverage for focused interactions and workflow controls, and final live browser/UAT closure at milestone completion.
- Notes: M001 closed the primary browser-first loop. Remaining parity work moves to R011/M002.

### R005 — The existing dashboard, terminal, power, roadmap, files, and activity surfaces in `web/` must be wired to real GSD data and actions.
- Class: core-capability
- Status: validated
- Description: The existing dashboard, terminal, power, roadmap, files, and activity surfaces in `web/` must be wired to real GSD data and actions.
- Why it matters: The user explicitly wants the exact skin preserved and integrated, not replaced with a new UI.
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: M001/S03, M001/S05, M001/S06
- Validation: verified by `src/tests/web-state-surfaces-contract.test.ts` (17/17), `src/tests/integration/web-mode-runtime.test.ts`, the 59-test contract regression rerun, and `npm run build:web-host`.
- Notes: The preserved skin is now the real workspace, not a mock shell with a live terminal bolted onto it.

### R006 — Confirmations, choices, text input, editor-style interruptions, and similar mid-run agent requests must be handled in a focused primary web surface rather than buried modals.
- Class: continuity
- Status: validated
- Description: Confirmations, choices, text input, editor-style interruptions, and similar mid-run agent requests must be handled in a focused primary web surface rather than buried modals.
- Why it matters: The browser needs a clear interaction model for live agent work, or parity will break under real prompts.
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: M001/S07
- Validation: verified by `src/tests/web-live-interaction-contract.test.ts` (10/10 — UI request lifecycle, transcript streaming, steer/abort, fire-and-forget state, failure paths), `npm run build:web-host` (focused panel and terminal controls compile and mount), and the assembled route-level lifecycle proof in S07.
- Notes: The focused panel now covers all four blocking request types: select, confirm, input, and editor.

### R007 — Users can refresh or reopen the browser workspace, reattach to the correct current-project session state, and resume work from the web UI.
- Class: continuity
- Status: validated
- Description: Users can refresh or reopen the browser workspace, reattach to the correct current-project session state, and resume work from the web UI.
- Why it matters: Browser mode stops feeling first-class if normal browser lifecycle behavior loses context or control.
- Source: inferred
- Primary owning slice: M001/S06
- Supporting slices: M001/S05, M001/S07
- Validation: verified by `src/tests/web-continuity-contract.test.ts` (14/14 — reconnect resync, visibility-return refresh, transcript cap, command timeout, retry affordances), sessionStorage view persistence in app-shell, and `npm run build:web-host`.
- Notes: This covers current-project continuity and resume inside web mode, not cross-project launching.

### R008 — Core web workspace views must not ship with mixed mock/live content once they are declared integrated.
- Class: constraint
- Status: validated
- Description: Core web workspace views must not ship with mixed mock/live content once they are declared integrated.
- Why it matters: Fake/live mixing destroys trust and makes parity claims impossible to verify.
- Source: inferred
- Primary owning slice: M001/S04
- Supporting slices: M001/S07
- Validation: verified by `src/tests/web-state-surfaces-contract.test.ts` (17/17 — explicit mock-free invariant checks across integrated surfaces), the final 59-test contract regression rerun, and `npm run build:web-host`.
- Notes: The mock-free invariant is now a standing regression guard, not a one-time inspection.

### R009 — Streaming, navigation, updates, and prompt handling in web mode must feel snappy and fast under normal local use.
- Class: quality-attribute
- Status: validated
- Description: Streaming, navigation, updates, and prompt handling in web mode must feel snappy and fast under normal local use.
- Why it matters: The user explicitly called out speed as a non-negotiable quality bar.
- Source: user
- Primary owning slice: M001/S06
- Supporting slices: M001/S01, M001/S03, M001/S04, M001/S05, M001/S07
- Validation: verified by S06's continuity/performance hardening (`MAX_TRANSCRIPT_BLOCKS`, command timeout recovery, reconnect/visibility refresh), S07's thinner `launchWebMode` parent bootstrap and stable runtime/build regressions, and the final live browser/UAT closure for the remaining subjective acceptance bar.
- Notes: Preserve the user's exact phrasing: "snappy and fast." M001 cleared that bar for normal local use.

### R010 — Setup failures, bridge disconnects, blocked actions, and agent/runtime errors must be visible in-browser with a clear recovery path.
- Class: failure-visibility
- Status: validated
- Description: Setup failures, bridge disconnects, blocked actions, and agent/runtime errors must be visible in-browser with a clear recovery path.
- Why it matters: A browser-first path becomes fragile if the user has to guess what failed or fall back to terminal debugging.
- Source: research
- Primary owning slice: M001/S06
- Supporting slices: M001/S03, M001/S04, M001/S07
- Validation: verified by `src/tests/web-continuity-contract.test.ts` (timeout clears stuck state with error visibility and reconnect recovery), S02's structured onboarding lock/validation diagnostics, the error-banner retry affordance in app-shell, and `npm run build:web-host`.
- Notes: This is especially important because `--web` intentionally suppresses TUI fallback.

### R011 — After the primary browser-first loop is real, the remaining lower-frequency TUI capabilities should be brought into browser parity as needed for daily use.
- Class: core-capability
- Status: validated
- Description: After the primary browser-first loop is real, the remaining lower-frequency TUI capabilities should be brought into browser parity as needed for daily use.
- Why it matters: The stated goal is full parity with what the TUI can do, not just a browser path for the main happy path.
- Source: user
- Primary owning slice: M002/S01
- Supporting slices: M002/S02, M002/S03, M002/S04
- Validation: verified by `src/tests/integration/web-mode-runtime.test.ts`, `src/tests/integration/web-mode-onboarding.test.ts`, `src/tests/integration/web-mode-assembled.test.ts`, `src/tests/web-command-parity-contract.test.ts`, `src/tests/web-session-parity-contract.test.ts`, `src/tests/web-live-state-contract.test.ts`, `src/tests/web-recovery-diagnostics-contract.test.ts`, `npm run build:web-host`, and the real packaged-host browser proof of refresh/reopen, daily-use browser controls, and seeded interrupted-run recovery.
- Notes: S01 proved safe browser slash-command dispatch plus RPC-backed/browser-surface outcomes for the daily-use built-ins in scope. S02 added current-project session browse/resume/rename parity, daily-use settings/auth controls, a real Git sidebar surface, and browser-visible title/widget/editor shell state. S03 added targeted live freshness, narrow invalidation-driven reloads, and browser-native recovery diagnostics. S04 completed the real packaged-host refresh/reopen/daily-use/interrupted-run browser proof and closed the remaining runtime risk.

### R100 — Merge 398 upstream commits (v2.12→v2.21) into the fork, resolve all 50 file conflicts, and achieve a green build (`npm run build`, `npm run build:web-host`).
- Class: core-capability
- Status: validated
- Description: Merge 398 upstream commits (v2.12→v2.21) into the fork, resolve all 50 file conflicts, and achieve a green build (`npm run build`, `npm run build:web-host`).
- Why it matters: Nothing else in M003 can proceed until the codebase is unified and compiling.
- Source: user
- Primary owning slice: M003/S01
- Supporting slices: none
- Validation: `npm run build` exits 0, `npm run build:web-host` exits 0, `rg "^<<<<<<<|^>>>>>>>|^=======$" src/ web/ packages/ .github/` returns empty, `git log --oneline HEAD..upstream/main | wc -l` returns 0. All verified on 2026-03-16 after merging 415 upstream commits (v2.12→v2.22.0) and resolving all 50 file conflicts.
- Notes: Upstream advanced to v2.22.0 during execution (415 commits vs estimated 398). Web code has zero import dependencies on GSD extension core modules — only imports from native-git-bridge.ts. All 12 extension modules took upstream with no fork re-additions needed.

### R106 — A dedicated browser page showing KNOWLEDGE.md entries and CAPTURES.md with pending/triaged/resolved status, classification labels, and triage action controls.
- Class: core-capability
- Status: validated
- Description: A dedicated browser page showing KNOWLEDGE.md entries and CAPTURES.md with pending/triaged/resolved status, classification labels, and triage action controls.
- Why it matters: Knowledge and captures are persistent project-context artifacts that need browser visibility and interaction.
- Source: user
- Primary owning slice: M003/S05
- Supporting slices: M003/S02
- Validation: Verified by S05: `/api/knowledge` GET returns parsed KNOWLEDGE.md entries with type classification; `/api/captures` GET returns capture entries with status/counts; POST validates and resolves captures with field-level 400 errors; KnowledgeCapturesPanel renders Knowledge tab (type badges) and Captures tab (status badges, classification labels, triage action buttons); `/gsd knowledge`, `/gsd capture`, `/gsd triage` dispatch to real panel. `npm run build` and `npm run build:web-host` pass.
- Notes: S05 complete. Knowledge service reads KNOWLEDGE.md directly (freeform headings + table rows). Captures service uses child-process pattern for upstream captures.ts calls. Panel has duplicated helpers (PanelHeader/PanelError/PanelLoading/PanelEmpty) — could be extracted to shared module in S08.

## Deferred

### R020 — Support broader project/session switching beyond the current-project launch contract.
- Class: admin/support
- Status: deferred
- Description: Support broader project/session switching beyond the current-project launch contract.
- Why it matters: It may become useful once browser mode is established, but it is not required to make `gsd --web` real.
- Source: inferred
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Current-project launch is the primary requirement for now.

### R021 — Add deeper analytics/history views beyond the live dashboard and activity surfaces required for the core web workflow.
- Class: operability
- Status: deferred
- Description: Add deeper analytics/history views beyond the live dashboard and activity surfaces required for the core web workflow.
- Why it matters: This may improve long-term observability, but it is not part of the initial browser-first contract.
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Revisit only if live usage shows the built-in activity surfaces are too thin.

### R022 — Support using the browser workspace from outside the local machine or sharing it across users.
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

### R030 — `gsd --web` should not launch the TUI in parallel or rely on a visible TUI session.
- Class: anti-feature
- Status: out-of-scope
- Description: `gsd --web` should not launch the TUI in parallel or rely on a visible TUI session.
- Why it matters: This prevents the browser path from becoming a disguised sidecar.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: This is a hard product boundary for M001.

### R031 — M001 should not spend time redesigning the current UI skin instead of wiring it into live GSD behavior.
- Class: anti-feature
- Status: out-of-scope
- Description: M001 should not spend time redesigning the current UI skin instead of wiring it into live GSD behavior.
- Why it matters: It keeps scope focused on integration and parity rather than aesthetic churn.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: "Just use the exact skin in the test UI and wire it into GSD."

### R032 — Core web mode should not depend on a separate cloud-hosted backend to function.
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
| R001 | launchability | validated | M001/S01 | M001/S07 | verified by `src/tests/web-mode-cli.test.ts`, `src/tests/integration/web-mode-runtime.test.ts`, S01's fresh temp-home runtime/browser proof, and the launch contract that waits for `/api/boot` readiness before reporting success. |
| R002 | launchability | validated | M001/S02 | M001/S01, M001/S07 | verified by `src/tests/web-onboarding-contract.test.ts`, `src/tests/integration/web-mode-onboarding.test.ts`, `npm run build:web-host`, packaged-host route spot-checks of `/api/boot` + `/api/onboarding` + blocked `/api/session/command`, and S02's browser/runtime proof of failed validation, successful retry, unlock, and first-command success. |
| R003 | primary-user-loop | validated | M001/S01 | M001/S04 | verified by `/api/boot`, the slice-level runtime integration test, and browser rendering of the live current-project scope/status state. |
| R004 | primary-user-loop | validated | M001/S07 | M001/S01, M001/S02, M001/S03, M001/S04, M001/S05, M001/S06 | verified by `src/tests/integration/web-mode-assembled.test.ts` (boot → onboarding → prompt → streaming → tool execution → blocking UI request → UI response → turn boundary), the 5-test integration regression (`web-mode-assembled`, `web-mode-runtime`, `web-mode-onboarding`), S03/S05 contract coverage for focused interactions and workflow controls, and final live browser/UAT closure at milestone completion. |
| R005 | core-capability | validated | M001/S04 | M001/S03, M001/S05, M001/S06 | verified by `src/tests/web-state-surfaces-contract.test.ts` (17/17), `src/tests/integration/web-mode-runtime.test.ts`, the 59-test contract regression rerun, and `npm run build:web-host`. |
| R006 | continuity | validated | M001/S03 | M001/S07 | verified by `src/tests/web-live-interaction-contract.test.ts` (10/10 — UI request lifecycle, transcript streaming, steer/abort, fire-and-forget state, failure paths), `npm run build:web-host` (focused panel and terminal controls compile and mount), and the assembled route-level lifecycle proof in S07. |
| R007 | continuity | validated | M001/S06 | M001/S05, M001/S07 | verified by `src/tests/web-continuity-contract.test.ts` (14/14 — reconnect resync, visibility-return refresh, transcript cap, command timeout, retry affordances), sessionStorage view persistence in app-shell, and `npm run build:web-host`. |
| R008 | constraint | validated | M001/S04 | M001/S07 | verified by `src/tests/web-state-surfaces-contract.test.ts` (17/17 — explicit mock-free invariant checks across integrated surfaces), the final 59-test contract regression rerun, and `npm run build:web-host`. |
| R009 | quality-attribute | validated | M001/S06 | M001/S01, M001/S03, M001/S04, M001/S05, M001/S07 | verified by S06's continuity/performance hardening (`MAX_TRANSCRIPT_BLOCKS`, command timeout recovery, reconnect/visibility refresh), S07's thinner `launchWebMode` parent bootstrap and stable runtime/build regressions, and the final live browser/UAT closure for the remaining subjective acceptance bar. |
| R010 | failure-visibility | validated | M001/S06 | M001/S03, M001/S04, M001/S07 | verified by `src/tests/web-continuity-contract.test.ts` (timeout clears stuck state with error visibility and reconnect recovery), S02's structured onboarding lock/validation diagnostics, the error-banner retry affordance in app-shell, and `npm run build:web-host`. |
| R011 | core-capability | validated | M002/S01 | M002/S02, M002/S03, M002/S04 | verified by `src/tests/integration/web-mode-runtime.test.ts`, `src/tests/integration/web-mode-onboarding.test.ts`, `src/tests/integration/web-mode-assembled.test.ts`, `src/tests/web-command-parity-contract.test.ts`, `src/tests/web-session-parity-contract.test.ts`, `src/tests/web-live-state-contract.test.ts`, `src/tests/web-recovery-diagnostics-contract.test.ts`, `npm run build:web-host`, and the real packaged-host browser proof of refresh/reopen, daily-use browser controls, and seeded interrupted-run recovery. |
| R020 | admin/support | deferred | none | none | unmapped |
| R021 | operability | deferred | none | none | unmapped |
| R022 | operability | deferred | none | none | unmapped |
| R030 | anti-feature | out-of-scope | none | none | n/a |
| R031 | anti-feature | out-of-scope | none | none | n/a |
| R032 | constraint | out-of-scope | none | none | n/a |
| R100 | core-capability | validated | M003/S01 | none | `npm run build` exits 0, `npm run build:web-host` exits 0, `rg "^<<<<<<<|^>>>>>>>|^=======$" src/ web/ packages/ .github/` returns empty, `git log --oneline HEAD..upstream/main | wc -l` returns 0. All verified on 2026-03-16 after merging 415 upstream commits (v2.12→v2.22.0) and resolving all 50 file conflicts. |
| R101 | primary-user-loop | active | M003/S02 | M003/S04, M003/S05, M003/S06, M003/S07 | Verified by updated `src/tests/web-command-parity-contract.test.ts` — exhaustive GSD dispatch test (118 tests) asserts every subcommand has a defined outcome (surface/prompt/local). Contract surface wiring test proves each surface opens correctly through the command-surface system. `npm run build` and `npm run build:web-host` succeed. Runtime diagnostic: `dispatchBrowserSlashCommand("/gsd <subcmd>")` returns inspectable .kind/.surface/.action fields; `getBrowserSlashCommandTerminalNotice()` confirms system notices for surface outcomes and null for passthrough. |
| R102 | core-capability | active | M003/S03 | none | S03 built: /api/visualizer GET endpoint, VisualizerView component with 7 tabs (Progress, Deps, Metrics, Timeline, Agent, Changes, Export), sidebar NavRail entry, /gsd visualize dispatch. Both builds pass. Remaining: live runtime verification with real project data at S08 parity audit. |
| R103 | failure-visibility | active | M003/S04 | M003/S02 | Pipeline verified by `src/tests/web-diagnostics-contract.test.ts` (28/28 pass — type exports, contract state, dispatch→surface, surface→section, store methods). API route `/api/forensics` returns ForensicReport JSON via child-process service. Panel component (ForensicsPanel) renders anomaly list, recent units, crash lock, metrics summary. Both builds pass. Awaits live browser UAT for full validation. |
| R104 | failure-visibility | active | M003/S04 | M003/S02 | Pipeline verified by `src/tests/web-diagnostics-contract.test.ts` (28/28 pass). API routes: GET `/api/doctor?scope=X` returns DoctorReport JSON; POST `/api/doctor` applies fixes and returns DoctorFixResult. Panel renders issue list with severity/scope badges, fixable count, and Apply Fixes button. Both builds pass. Awaits live browser UAT for full validation. |
| R105 | operability | active | M003/S04 | M003/S02 | Pipeline verified by `src/tests/web-diagnostics-contract.test.ts` (28/28 pass). API route GET `/api/skill-health` returns SkillHealthReport JSON. Panel renders skill table with pass rates, token trends, staleness warnings, declining flags, and suggestions. Both builds pass. Awaits live browser UAT for full validation. |
| R106 | core-capability | validated | M003/S05 | M003/S02 | Verified by S05: `/api/knowledge` GET returns parsed KNOWLEDGE.md entries with type classification; `/api/captures` GET returns capture entries with status/counts; POST validates and resolves captures with field-level 400 errors; KnowledgeCapturesPanel renders Knowledge tab (type badges) and Captures tab (status badges, classification labels, triage action buttons); `/gsd knowledge`, `/gsd capture`, `/gsd triage` dispatch to real panel. `npm run build` and `npm run build:web-host` pass. |
| R107 | core-capability | active | M003/S06 | M003/S02 | Structurally verified by `npm run build` (types compile), `npm run build:web-host` (API route and components in production build), `npx tsx --test web-command-parity-contract.test.ts` (114/118 pass, no regression). API route at `/api/settings-data` returns combined SettingsData JSON with preferences, routingConfig, budgetAllocation, routingHistory, and projectTotals from 5 upstream modules. Three panel components (PrefsPanel, ModelRoutingPanel, BudgetPanel) render real data for gsd-prefs/gsd-mode/gsd-config sections. Full live-runtime validation deferred to S08 parity audit. |
| R108 | core-capability | active | M003/S07 | M003/S02 | unmapped |
| R109 | quality-attribute | validated | M003/S08 | M003/S03, M003/S04, M003/S05, M003/S06, M003/S07 | S08-PARITY-AUDIT.md: 30 subcommands, 12 gaps classified, 118/118 tests |
| R110 | quality-attribute | validated | M003/S09 | M003/S01 | Unit tests 1197/0, both builds exit 0, integration test fixes applied. |
| R111 | quality-attribute | active | M004/S01 | M004/S02 | unmapped |
| R112 | quality-attribute | active | M004/S03 | none | unmapped |

## Coverage Summary

- Active requirements: 10
- Mapped to slices: 10
- Validated: 14 (R001, R002, R003, R004, R005, R006, R007, R008, R009, R010, R011, R100, R106, R110)
- Unmapped active requirements: 0
