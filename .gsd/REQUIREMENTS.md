# Requirements

This file is the explicit capability and coverage contract for the project.

## Active

### R020 — Support multi-project workspace with dev root selection, smart project discovery, NavRail project browser, concurrent background agent sessions, and context-aware launch.
- Class: admin/support
- Status: active
- Description: Support multi-project workspace with dev root selection, smart project discovery, NavRail project browser, concurrent background agent sessions, and context-aware launch.
- Why it matters: Users working across multiple projects must juggle separate browser tabs and host processes. A unified multi-project workspace removes this friction.
- Source: user request
- Primary owning slice: M006
- Supporting slices: M006/S01, M006/S02, M006/S03
- Validation: Dev root persists, project list populates, switching projects swaps all surfaces to the new project context while keeping the previous session alive, context-aware launch works.
- Notes: Promoted from deferred to active. S01 delivers bridge registry and project-scoped APIs. S02 delivers project discovery, Projects view, and store switching. S03 delivers onboarding dev root step, context-aware launch, and final assembly.

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

### R112 — A separate web.yml CI workflow that builds the web host, runs web contract tests, and validates packaging on ubuntu and macos.
- Class: quality-attribute
- Status: active
- Description: A separate web.yml CI workflow that builds the web host, runs web contract tests, and validates packaging on ubuntu and macos.
- Why it matters: The current CI pipeline never builds or tests the web host — web regressions ship silently.
- Source: user
- Primary owning slice: M011/S01
- Supporting slices: none
- Validation: unmapped
- Notes: Supersedes original R112 scope (which specified adding to ci.yml). User wants a separate workflow file.

### R121 — File viewer/editor font size is configurable from settings and persists across sessions.
- Class: quality-attribute
- Status: active
- Description: A settings panel control for file viewer and code editor font size, persisted in localStorage, applying to both the shiki code viewer and the CodeMirror editor tab.
- Why it matters: Hardcoded font sizes in the file viewer are an accessibility and comfort gap, same as the terminal font size was before M008.
- Source: user
- Primary owning slice: M009/S01
- Supporting slices: none
- Validation: unmapped
- Notes: Follows the same localStorage + custom event pattern established by useTerminalFontSize in M008.

### R122 — Full code editing experience via CodeMirror 6 with custom theme derived from existing design tokens.
- Class: core-capability
- Status: active
- Description: The file content viewer gains an Edit tab powered by CodeMirror 6 (@uiw/react-codemirror) with a custom theme built from the project's existing oklch CSS design tokens. Supports multi-cursor, copy/paste, undo, syntax highlighting for all supported languages.
- Why it matters: The file viewer is currently read-only — users cannot edit code in the browser. A full editor makes the web workspace self-sufficient for code changes.
- Source: user
- Primary owning slice: M009/S02
- Supporting slices: M009/S01
- Validation: unmapped
- Notes: Shiki stays for the View tab (zero style changes). CodeMirror only used in the Edit tab. Theme must look native to the existing design system.

### R123 — Markdown files display a View tab (react-markdown rendered) and an Edit tab (CodeMirror raw).
- Class: core-capability
- Status: active
- Description: Markdown files in the file viewer show two tabs — View (rendered via react-markdown, matching current appearance) and Edit (raw markdown in CodeMirror). Non-markdown files also get View/Edit tabs, with View using shiki syntax highlighting.
- Why it matters: The current file viewer renders markdown as a single read-only page with no way to edit. A tab split gives both readable rendering and raw editing.
- Source: user
- Primary owning slice: M009/S03
- Supporting slices: M009/S02
- Validation: unmapped
- Notes: react-markdown is already a dependency used in file-content-viewer.tsx and chat-mode.tsx.

### R124 — POST /api/files writes file content with path validation and security constraints.
- Class: core-capability
- Status: active
- Description: A POST handler on the existing /api/files route that accepts file path and content, validates the path is within the allowed root (no traversal), and writes the file to disk. Returns success/error status.
- Why it matters: Without a write API, the code editor cannot save changes. The existing /api/files route is read-only (GET only).
- Source: user
- Primary owning slice: M009/S01
- Supporting slices: none
- Validation: unmapped
- Notes: Must use the same resolveSecurePath validation the GET handler uses. File size limit applies.

### R125 — Merge upstream v2.22→v2.28 (349+ commits), resolve all conflicts, both builds green.
- Class: core-capability
- Status: active
- Description: Merge all upstream commits from v2.22.0 to v2.28.0 into the fork, resolving all file conflicts. npm run build and npm run build:web-host both exit 0. No conflict markers remain.
- Why it matters: The fork must stay current with upstream to receive fixes, features, and refactoring. 349 commits include 58 structural refactoring commits that decomposed major files.
- Source: user
- Primary owning slice: M010/S01
- Supporting slices: none
- Validation: unmapped
- Notes: Last merge (M003, v2.12→v2.22, 415 commits) was 9 slices. This one has significant refactoring (auto.ts→6 modules, commands.ts→5 modules, preferences.ts decomposed, doctor.ts decomposed).

### R126 — Zero errors, warnings, or failing tests after merge.
- Class: quality-attribute
- Status: active
- Description: After the upstream merge, all unit tests, integration tests, and type checks pass clean. No new warnings introduced. Both builds exit 0.
- Why it matters: A merge that leaves broken tests or warnings creates compounding technical debt.
- Source: user
- Primary owning slice: M010/S02
- Supporting slices: M010/S01
- Validation: unmapped
- Notes: Test suite includes unit, integration, and web contract tests.

### R127 — Web UI for park/discard actions on in-progress milestones.
- Class: core-capability
- Status: active
- Description: The web dashboard or roadmap surface exposes park and discard actions for in-progress milestones, matching the upstream TUI capability added in the v2.22→v2.28 window.
- Why it matters: New upstream feature with no web surface — browser-only users cannot park or discard milestones.
- Source: user
- Primary owning slice: M010
- Supporting slices: none
- Validation: unmapped
- Notes: Upstream PR #1107 added park/discard actions.

### R128 — Web UI for session picker (browse, select, resume sessions).
- Class: core-capability
- Status: active
- Description: A web surface for the session picker that lets users browse available sessions, select one, and resume it — matching the upstream /gsd sessions TUI capability.
- Why it matters: New upstream feature with no web surface — browser-only users cannot browse or switch sessions.
- Source: user
- Primary owning slice: M010
- Supporting slices: none
- Validation: unmapped
- Notes: Upstream PR #721 added gsd sessions subcommand.

### R129 — Web UI for /gsd keys — only if current settings UI is insufficient.
- Class: core-capability
- Status: active
- Description: Evaluate whether the existing settings panels adequately cover the API key management capability added by upstream /gsd keys. Build a dedicated panel only if the current UI is insufficient.
- Why it matters: Upstream added comprehensive API key manager. May already be covered by existing settings/prefs panels.
- Source: user
- Primary owning slice: M010
- Supporting slices: none
- Validation: unmapped
- Notes: Conditional — may result in "no new UI needed" if existing panels suffice.

### R130 — Separate web.yml CI workflow builds web host, runs web contract tests, validates packaging on ubuntu and macos.
- Class: quality-attribute
- Status: active
- Description: A new .github/workflows/web.yml that runs npm run build:web-host, web contract tests, and npm run validate-pack independently from the existing ci.yml build job. Runs on both ubuntu-latest and macos-latest.
- Why it matters: Web regressions currently ship silently because CI never exercises the web host build or tests.
- Source: user
- Primary owning slice: M011/S01
- Supporting slices: none
- Validation: unmapped
- Notes: Supersedes R112 which specified adding to ci.yml. User wants a separate workflow.

### R131 — npm tarball includes dist/web/standalone so gsd --web works after npm install -g.
- Class: launchability
- Status: active
- Description: The published npm package includes the web standalone host in dist/web/standalone, so end users running npm install -g gsd-pi followed by gsd --web get a working browser workspace without any additional build steps.
- Why it matters: If the web host isn't packaged, gsd --web fails for every consumer install.
- Source: user
- Primary owning slice: M011/S02
- Supporting slices: M011/S01
- Validation: unmapped
- Notes: package.json files field already includes "dist/web" but packaging needs verification with validate-pack.

### R132 — All CI workflows pass green on push to main.
- Class: quality-attribute
- Status: active
- Description: The existing ci.yml, build-native.yml, and new web.yml all pass on push to the main branch. Any failures are resolved before the milestone is complete.
- Why it matters: A green main branch is the baseline for shipping.
- Source: user
- Primary owning slice: M011/S03
- Supporting slices: M011/S01, M011/S02
- Validation: unmapped
- Notes: May require fixing issues surfaced by the new web CI job.

### R133 — PWA install prompt with web manifest, service worker, and app shell caching on first --web launch.
- Class: differentiator
- Status: active
- Description: The GSD web workspace is a PWA with a web app manifest, Serwist-powered service worker for app shell caching, and browser install prompt. Users can install GSD as a desktop app from the browser. No offline functionality required.
- Why it matters: A PWA install gives users a native-app-like experience with a desktop icon, standalone window, and faster startup — without the overhead of Electron or Tauri.
- Source: user
- Primary owning slice: M011/S04
- Supporting slices: none
- Validation: unmapped
- Notes: Uses Serwist (@serwist/next) for Next.js integration. App shell caching only — no offline API or content caching.

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

### R101 — Every /gsd subcommand (help, next, auto, stop, pause, status, visualize, queue, quick, discuss, capture, triage, history, undo, skip, export, cleanup, mode, prefs, config, hooks, run-hook, skill-health, doctor, forensics, migrate, remote, steer, inspect, knowledge) dispatches correctly from the browser terminal — opening a surface, executing, or rejecting with clear guidance.
- Class: primary-user-loop
- Status: validated
- Description: Every /gsd subcommand (help, next, auto, stop, pause, status, visualize, queue, quick, discuss, capture, triage, history, undo, skip, export, cleanup, mode, prefs, config, hooks, run-hook, skill-health, doctor, forensics, migrate, remote, steer, inspect, knowledge) dispatches correctly from the browser terminal — opening a surface, executing, or rejecting with clear guidance.
- Why it matters: Silent command fallthrough was the highest-risk M002 gap; extending dispatch to new commands maintains that safety.
- Source: user
- Primary owning slice: M003/S02
- Supporting slices: M003/S04, M003/S05, M003/S06, M003/S07
- Validation: 118/118 parity contract tests pass, all 30 subcommands classified (20 surface with real content, 9 passthrough, 1 local help), zero placeholder surfaces remain, both builds exit 0. Verified 2026-03-17.
- Notes: M003 complete. Dispatch wired in S02, all 20 surface commands render real content (S04: forensics/doctor/skill-health, S05: knowledge/captures, S06: settings, S07: remaining 10).

### R102 — A dedicated browser page with tabbed sections for Progress, Deps, Metrics, Timeline, Agent activity, Changelog, and Export — backed by the upstream visualizer-data.ts aggregation.
- Class: core-capability
- Status: validated
- Description: A dedicated browser page with tabbed sections for Progress, Deps, Metrics, Timeline, Agent activity, Changelog, and Export — backed by the upstream visualizer-data.ts aggregation.
- Why it matters: The TUI visualizer is a primary workflow surface for understanding project state; web mode needs parity.
- Source: user
- Primary owning slice: M003/S03
- Supporting slices: none
- Validation: VisualizerView component with 7 TabsTrigger/TabsContent pairs (Progress, Deps, Metrics, Timeline, Agent, Changes, Export), /api/visualizer GET route compiled in production build, sidebar NavRail entry, /gsd visualize dispatch via view-navigate kind. Parity audit (S08) confirmed all 7 tabs match TUI visualizer. Both builds pass. Verified 2026-03-17.
- Notes: Child-process pattern required for Turbopack compatibility (D054). Map→Record serialization for criticalPath slack fields.

### R103 — A browser panel showing forensic anomaly scanning results — stuck loops, cost spikes, timeouts, missing artifacts, crashes, doctor issues, and error traces from auto-mode runs.
- Class: failure-visibility
- Status: validated
- Description: A browser panel showing forensic anomaly scanning results — stuck loops, cost spikes, timeouts, missing artifacts, crashes, doctor issues, and error traces from auto-mode runs.
- Why it matters: Auto-mode failures need browser-visible investigation, not just TUI-only forensics.
- Source: user
- Primary owning slice: M003/S04
- Supporting slices: M003/S02
- Validation: 28/28 diagnostics contract tests pass, /api/forensics GET returns ForensicReport JSON, ForensicsPanel renders anomaly list/recent units/crash lock/metrics. Parity audit (S08) confirmed against TUI. Both builds pass. Verified 2026-03-17.
- Notes: ForensicReport simplified for browser — flattened metrics, counted traces. Full drill-down available via bridge passthrough.

### R104 — A browser panel showing doctor health check results (7 runtime checks), auto-fix actions, severity filtering, and scope selection.
- Class: failure-visibility
- Status: validated
- Description: A browser panel showing doctor health check results (7 runtime checks), auto-fix actions, severity filtering, and scope selection.
- Why it matters: Doctor is the primary health diagnostic tool; existing web recovery surface covers only basic recovery, not the full doctor report.
- Source: user
- Primary owning slice: M003/S04
- Supporting slices: M003/S02
- Validation: 28/28 diagnostics contract tests pass, /api/doctor GET+POST routes return structured JSON, DoctorPanel renders issue list with severity/scope badges and Apply Fixes button. Parity audit (S08) confirmed against TUI. Both builds pass. Verified 2026-03-17.
- Notes: Doctor GET+POST pattern enables read + fix-action lifecycle. Scope via query param. Audit/heal modes available via bridge passthrough.

### R105 — A browser panel showing per-skill pass/fail rates, token usage, staleness warnings, declining performance flags, and heal-skill suggestions.
- Class: operability
- Status: validated
- Description: A browser panel showing per-skill pass/fail rates, token usage, staleness warnings, declining performance flags, and heal-skill suggestions.
- Why it matters: Skill lifecycle management is a new upstream capability that needs browser visibility.
- Source: user
- Primary owning slice: M003/S04
- Supporting slices: M003/S02
- Validation: 28/28 diagnostics contract tests pass, /api/skill-health GET returns SkillHealthReport JSON, SkillHealthPanel renders skill table with pass rates/trends/staleness/suggestions. Parity audit (S08) confirmed against TUI. Both builds pass. Verified 2026-03-17.
- Notes: Detailed drill-down and filters available via bridge passthrough. Browser panel shows summary view with actionable suggestions.

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

### R107 — The browser settings command surface shows dynamic model routing configuration, provider fallback chain management, budget allocation visibility, and all preference fields from the upstream preferences wizard.
- Class: core-capability
- Status: validated
- Description: The browser settings command surface shows dynamic model routing configuration, provider fallback chain management, budget allocation visibility, and all preference fields from the upstream preferences wizard.
- Why it matters: Model/provider/budget management is a substantial new upstream capability with TUI-only surfaces.
- Source: user
- Primary owning slice: M003/S06
- Supporting slices: M003/S02
- Validation: /api/settings-data GET aggregates 5 upstream modules (preferences, model-router, context-budget, routing-history, metrics). PrefsPanel, ModelRoutingPanel, BudgetPanel render real data for gsd-prefs/gsd-mode/gsd-config. Parity audit (S08) confirmed against TUI. Both builds pass. Verified 2026-03-17.
- Notes: Read-only panels — preferences editing wizard accessible via bridge passthrough. Budget uses hardcoded 200K context window default.

### R108 — Each of the remaining /gsd subcommands opens a browser-native surface with appropriate controls, feedback, and state visibility.
- Class: core-capability
- Status: validated
- Description: Each of the remaining /gsd subcommands opens a browser-native surface with appropriate controls, feedback, and state visibility.
- Why it matters: Absolute parity means no command is TUI-only.
- Source: user
- Primary owning slice: M003/S07
- Supporting slices: M003/S02
- Validation: 10 panel components (QuickPanel, HistoryPanel, UndoPanel, SteerPanel, HooksPanel, InspectPanel, ExportPanel, CleanupPanel, QueuePanel, StatusPanel), 7 API routes compiled in production build, zero placeholder surfaces remain. Parity audit (S08) confirmed all surfaces against TUI. Both builds pass. Verified 2026-03-17.
- Notes: All 10 panels built with three-tier data access (no-API, read-only API, mutation API). 7 new API routes.

### R109 — A systematic comparison of every TUI feature against the web UI, with any gaps found being closed in this slice.
- Class: quality-attribute
- Status: validated
- Description: A systematic comparison of every TUI feature against the web UI, with any gaps found being closed in this slice.
- Why it matters: Individual feature slices may miss edge cases or subtle TUI behaviors; a dedicated audit pass catches them.
- Source: user
- Primary owning slice: M003/S08
- Supporting slices: M003/S03, M003/S04, M003/S05, M003/S06, M003/S07
- Validation: S08-PARITY-AUDIT.md covers all 30 /gsd subcommands, dashboard overlay, 7 visualizer tabs, and interactive flows. 12 gaps identified — 9 intentional scope boundaries, 3 deferred. 118/118 parity contract tests pass. Zero stub surfaces remain.
- Notes: Audit covers commands, surfaces, data visibility, interaction patterns, and error states as required. Parity is strong — no core TUI functionality missing from web.

### R110 — npm run test:unit, npm run test:integration, npm run test:browser-tools, npm run build, and npm run build:web-host all pass clean after all M003 work.
- Class: quality-attribute
- Status: validated
- Description: npm run test:unit, npm run test:integration, npm run test:browser-tools, npm run build, and npm run build:web-host all pass clean after all M003 work.
- Why it matters: The merge and new code must not break existing functionality.
- Source: user
- Primary owning slice: M003/S09
- Supporting slices: M003/S01
- Validation: Unit tests 1197/0 pass/fail. Both builds exit 0. Integration tests 27/0/1-skipped. All test fixes verified 2026-03-17.
- Notes: Test breakage came from three sources: (1) resolver not guarding /dist/ imports or handling .tsx, (2) tests with stale assertions after M003 changes, (3) integration tests not adapted to S02 dispatch changes and UI layout changes.

### R113 — A Chat Mode view accessible from the sidebar (below Power Mode) that renders GSD sessions as chat bubbles with markdown, intercepts TUI prompts as native UI, provides workflow action buttons, and spawns/auto-closes action side panels.
- Class: primary-user-loop
- Status: validated
- Description: A Chat Mode view accessible from the sidebar (below Power Mode) that renders GSD sessions as chat bubbles with markdown, intercepts TUI prompts as native UI, provides workflow action buttons, and spawns/auto-closes action side panels.
- Why it matters: Non-technical users cannot operate GSD through a raw terminal. A chat interface makes GSD accessible to a much broader audience without removing any functionality.
- Source: user
- Primary owning slice: M007/S02
- Supporting slices: M007/S01, M007/S03, M007/S04
- Validation: All four M007 slices delivered their components: S01 (PtyChatParser + CompletionSignal), S02 (Chat Mode view, ChatPane, ChatBubble, sidebar nav), S03 (TUI prompt intercept UI — select/text/password), S04 (ChatModeHeader toolbar, ActionPanel with animated lifecycle, session DELETE cleanup). npm run build:web-host exits 0. Browser end-to-end verified: panel slides in with accent color, secondary PTY session established, X close fires DELETE, main session unaffected. Completion auto-close (1500ms after CompletionSignal) wired; live runtime UAT required to fully exercise.
- Notes: Additive — does not modify Power Mode or existing views. All four slices complete as of 2026-03-17.

### R116 — The current slice progress bar on the main dashboard transitions from red (0%) through yellow (50%) to green (100%) based on task completion percentage, instead of using a static monochrome color.
- Class: quality-attribute
- Status: validated
- Description: The current slice progress bar on the main dashboard transitions from red (0%) through yellow (50%) to green (100%) based on task completion percentage, instead of using a static monochrome color.
- Why it matters: Visual progress feedback through color is more intuitive than percentage text alone.
- Source: user
- Primary owning slice: M008/S05
- Supporting slices: none
- Validation: getProgressColor() implements oklch hue interpolation (25→85→145) applied as inline backgroundColor on progress bar div, replacing bg-foreground. npm run build:web-host passes. Visual test confirms red→yellow→green gradient across 0–100% range.
- Notes: Currently uses `bg-foreground` (monochrome). Needs oklch color interpolation.

### R119 — The projects page is redesigned from a grid layout to a styled list. Clicking/selecting a project expands it to show progress details including current milestone, active slice, task progress, and cost.
- Class: quality-attribute
- Status: validated
- Description: The projects page is redesigned from a grid layout to a styled list. Clicking/selecting a project expands it to show progress details including current milestone, active slice, task progress, and cost.
- Why it matters: The current grid layout shows minimal information per project; an expandable list provides richer context without requiring a full project switch.
- Source: user
- Primary owning slice: M008/S01
- Supporting slices: none
- Validation: unmapped
- Notes: Progress detail for non-active projects may use lightweight filesystem reads (STATE.md) rather than requiring a running bridge.

### R120 — A new setting in the web settings panel allows users to adjust terminal text size. The setting applies to chat mode terminals and the expert mode split terminal page, but not the persistent footer terminal at the bottom of most pages.
- Class: quality-attribute
- Status: validated
- Description: A new setting in the web settings panel allows users to adjust terminal text size. The setting applies to chat mode terminals and the expert mode split terminal page, but not the persistent footer terminal at the bottom of most pages.
- Why it matters: Terminal text size is currently hardcoded to 13px with no user control — an accessibility and comfort gap.
- Source: user
- Primary owning slice: M008/S05
- Supporting slices: none
- Validation: useTerminalFontSize() hook persists in localStorage, TerminalSizePanel in settings provides preset controls (11–16), ShellTerminal accepts fontSize prop threaded through DualTerminal, footer terminal excluded by omission (no fontSize prop), chat mode respects setting. npm run build:web-host passes.
- Notes: Currently hardcoded `fontSize: 13` in shell-terminal.tsx and `text-sm` in terminal.tsx.

## Deferred

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

### R034 — PWA offline functionality (full offline caching of routes and API responses).
- Class: anti-feature
- Status: out-of-scope
- Description: Service worker caches API responses and routes for offline use.
- Why it matters: GSD is a local CLI tool — offline caching doesn't make sense when the backend is localhost.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: PWA scope is limited to install prompt and app shell caching.

### R035 — Web UI for headless query, onboarding wizard, and export --html.
- Class: core-capability
- Status: out-of-scope
- Description: Browser surfaces for gsd headless query, project onboarding detection wizard, and /gsd export --html --all.
- Why it matters: User explicitly excluded these from the merge scope — they are not daily-use features.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: These upstream features remain TUI-only. May be revisited in a future milestone.

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | launchability | validated | M001/S01 | M001/S07 | verified |
| R002 | launchability | validated | M001/S02 | M001/S01, M001/S07 | verified |
| R003 | primary-user-loop | validated | M001/S01 | M001/S04 | verified |
| R004 | primary-user-loop | validated | M001/S07 | M001/S01-S06 | verified |
| R005 | core-capability | validated | M001/S04 | M001/S03, M001/S05, M001/S06 | verified |
| R006 | continuity | validated | M001/S03 | M001/S07 | verified |
| R007 | continuity | validated | M001/S06 | M001/S05, M001/S07 | verified |
| R008 | constraint | validated | M001/S04 | M001/S07 | verified |
| R009 | quality-attribute | validated | M001/S06 | M001/S01, M001/S03-S05, M001/S07 | verified |
| R010 | failure-visibility | validated | M001/S06 | M001/S03, M001/S04, M001/S07 | verified |
| R011 | core-capability | validated | M002/S01 | M002/S02-S04 | verified |
| R020 | admin/support | active | M006 | M006/S01-S03 | mapped |
| R021 | operability | deferred | none | none | unmapped |
| R022 | operability | deferred | none | none | unmapped |
| R030 | anti-feature | out-of-scope | none | none | n/a |
| R031 | anti-feature | out-of-scope | none | none | n/a |
| R032 | constraint | out-of-scope | none | none | n/a |
| R034 | anti-feature | out-of-scope | none | none | n/a |
| R035 | core-capability | out-of-scope | none | none | n/a |
| R100 | core-capability | validated | M003/S01 | none | verified 2026-03-16 |
| R101 | primary-user-loop | validated | M003/S02 | M003/S04-S07 | verified 2026-03-17 |
| R102 | core-capability | validated | M003/S03 | none | verified 2026-03-17 |
| R103 | failure-visibility | validated | M003/S04 | M003/S02 | verified 2026-03-17 |
| R104 | failure-visibility | validated | M003/S04 | M003/S02 | verified 2026-03-17 |
| R105 | operability | validated | M003/S04 | M003/S02 | verified 2026-03-17 |
| R106 | core-capability | validated | M003/S05 | M003/S02 | verified |
| R107 | core-capability | validated | M003/S06 | M003/S02 | verified 2026-03-17 |
| R108 | core-capability | validated | M003/S07 | M003/S02 | verified 2026-03-17 |
| R109 | quality-attribute | validated | M003/S08 | M003/S03-S07 | verified |
| R110 | quality-attribute | validated | M003/S09 | M003/S01 | verified 2026-03-17 |
| R111 | quality-attribute | active | M004/S01 | M004/S02 | unmapped |
| R112 | quality-attribute | active | M011/S01 | none | unmapped |
| R113 | primary-user-loop | validated | M007/S02 | M007/S01, M007/S03, M007/S04 | verified |
| R114 | quality-attribute | validated | M008/S03 | none | verified 2026-03-18 |
| R115 | quality-attribute | validated | M008/S03 | none | verified 2026-03-18 |
| R116 | quality-attribute | validated | M008/S05 | none | verified 2026-03-18 |
| R117 | core-capability | validated | M008/S02 | none | verified 2026-03-18 |
| R118 | core-capability | validated | M008/S04 | none | verified 2026-03-18 |
| R119 | quality-attribute | validated | M008/S01 | none | verified 2026-03-18 |
| R120 | quality-attribute | validated | M008/S05 | none | verified 2026-03-18 |
| R121 | quality-attribute | active | M009/S01 | none | unmapped |
| R122 | core-capability | active | M009/S02 | M009/S01 | unmapped |
| R123 | core-capability | active | M009/S03 | M009/S02 | unmapped |
| R124 | core-capability | active | M009/S01 | none | unmapped |
| R125 | core-capability | active | M010/S01 | none | unmapped |
| R126 | quality-attribute | active | M010/S02 | M010/S01 | unmapped |
| R127 | core-capability | active | M010 | none | unmapped |
| R128 | core-capability | active | M010 | none | unmapped |
| R129 | core-capability | active | M010 | none | unmapped |
| R130 | quality-attribute | active | M011/S01 | none | unmapped |
| R131 | launchability | active | M011/S02 | M011/S01 | unmapped |
| R132 | quality-attribute | active | M011/S03 | M011/S01, M011/S02 | unmapped |
| R133 | differentiator | active | M011/S04 | none | unmapped |

## Coverage Summary

- Active requirements: 16 (R020, R111, R112, R121-R133)
- Mapped to slices: 16
- Validated: 30 (R001-R011, R100-R110, R113-R120)
- Deferred: 2 (R021, R022)
- Out of scope: 5 (R030-R032, R034-R035)
- Unmapped active requirements: 0
