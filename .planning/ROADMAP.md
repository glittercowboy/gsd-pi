# Roadmap: GSD Mission Control

## Milestones

- ✅ **v1.0 MVP** — Phases 1–11 (shipped 2026-03-12)
- 🚧 **v2.0 Native Desktop** — Phases 12–20 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1–11) — SHIPPED 2026-03-12</summary>

- [x] **Phase 1: Monorepo + Bun Server Bootstrap** — Bun workspace, React 19, Tailwind v4, shadcn/ui on :4000 (2/2 plans)
- [x] **Phase 2: File-to-State Pipeline** — File watcher, state deriver, WebSocket diff pipeline, sub-100ms updates (3/3 plans)
- [x] **Phase 3: Panel Shell + Design System** — Design tokens, fonts, panel state components; 5-panel layout superseded by Phase 3.1 (3/3 plans, completed 2026-03-10)
- [x] **Phase 3.1: Layout Rewrite (INSERTED)** — Sidebar + tabbed single-column layout replacing failed 5-panel resizable layout (2/2 plans, completed 2026-03-10)
- [x] **Phase 4: Sidebar + Milestone View** — GSD logo, project nav, milestone/phase progress from live state (2/2 plans, completed 2026-03-10)
- [x] **Phase 5: Slice Detail + Active Task** — Context budget chart, boundary maps, UAT status, task execution display (2/2 plans, completed 2026-03-10)
- [x] **Phase 6: Chat Panel + Claude Code Integration** — Child process streaming, slash command autocomplete, GSD command registry (3/3 plans, completed 2026-03-10)
- [x] **Phase 6.1: Native File System Integration (INSERTED)** — FS REST API, pipeline hot-switch, project browser UI, recent projects (2/2 plans, completed 2026-03-10)
- [x] **Phase 6.2: Live Streaming + Native OS Integration (INSERTED)** — Full event streaming, native OS file picker, VS Code-style sidebar, Activity/History/Verify views (4/4 plans, completed 2026-03-11)
- [x] **Phase 6.3: New Capabilities (INSERTED)** — Multi-session (4 parallel), git worktrees, settings panel, project assets gallery (8/8 plans, completed 2026-03-11)
- [x] **Phase 7: Session Flow + Animation** — CSS logo animation, onboarding/resume flow, project selector, micro-interactions (4/4 plans)
- [x] **Phase 8: Discuss + Review Modes** — XML stream interceptor, question cards, decision log, 6-pillar review scoring (4/4 plans, completed 2026-03-11)
- [x] **Phase 9: Live Preview** — Bun proxy iframe, 4 viewports with device frames, session persistence (4/4 plans)
- [x] **Phase 10: Keyboard Shortcuts + Accessibility** — Command palette, panel focus shortcuts, heading hierarchy, touch targets (3/3 plans, completed 2026-03-12)
- [x] **Phase 11: Documentation Integrity (GAP)** — Phase 03 VERIFICATION.md, stale frontmatter fixes, traceability cleanup (2/2 plans, completed 2026-03-12)

</details>

### 🚧 v2.0 Native Desktop (In Progress)

**Milestone Goal:** Wrap Mission Control in a Tauri 2 native app, migrate all GSD v1 conventions to GSD 2 (`.gsd/`, `gsd` CLI, Pi SDK streaming), add OAuth + keychain, a Builder mode for non-technical users, and ship signed installers for macOS and Windows.

- [x] **Phase 11.1: Pre-v2.0 Stabilization (INSERTED)** — Address CONCERNS.md: config bridge, security hardening, fragile areas, tech debt, and missing critical features before v2.0 begins (completed 2026-03-12)
- [x] **Phase 12: GSD 2 Compatibility Pass** — Migrate file watcher, state schema, child process, and command syntax to GSD 2 conventions (completed 2026-03-12)
- [x] **Phase 13: Session Streaming Hardening** — Pi SDK event parser, resilient stream, process lifecycle, reconnect, cost/token display, auto mode indicators (gap closure in progress) (completed 2026-03-13)
- [x] **Phase 14: Slice Integration** — Milestones view renders slices with four states (Planned/In Progress/Needs Review/Complete) and state-appropriate actions (completed 2026-03-13)
- [x] **Phase 15: Tauri Shell** — Tauri 2 native shell, Bun process management, dependency check, window state, IPC commands, build pipeline (completed 2026-03-13)
- [x] **Phase 16: OAuth + Keychain** — First-launch provider picker, OAuth for Claude Max + GitHub Copilot, API key flow, keychain storage, token refresh (completed 2026-03-13)
- [ ] **Phase 17: Permission Model** — Trust dialog replaces skip-permissions toggle, hard boundary enforcement, advanced permission toggles
- [ ] **Phase 18: Builder Mode** — Interface mode toggle, vocabulary layer, Builder intent classifier, adapted discuss/slice cards, phase gate intercept
- [ ] **Phase 19: Project Workspace** — Managed workspace path, project home screen, project cards, multi-session tabs, archiving
- [ ] **Phase 20: Installer + Distribution** — GitHub Actions CI pipeline, code signing, auto-update, landing page

## Phase Details

### Phase 11.1: Pre-v2.0 Stabilization (INSERTED)
**Goal**: All concerns in `.planning/codebase/CONCERNS.md` are resolved — config bridge wired, security hardened, fragile areas guarded, tech debt cleared, and missing critical features added — so v2.0 development starts from a stable, correct foundation
**Depends on**: Phase 11 (v1.0 complete)
**Success Criteria** (what must be TRUE):
  1. `worktree_enabled` and `skip_permissions` from `config.json` are read and applied by the server at session-creation time
  2. `--dangerously-skip-permissions` is not passed unless the config explicitly enables it; the Settings UI toggle has observable effect
  3. WebSocket server (port 4001) binds to `127.0.0.1`; CORS is restricted to `http://localhost:4000`
  4. `wireSessionEvents` is guarded against double-call; `switchProject` pauses the reconcile interval during the switch
  5. `MAX_SESSIONS` is defined in one place and imported everywhere; `readFileJson` validates against a schema
  6. A React `ErrorBoundary` wraps the component tree; the `nul/` directory is removed
  7. All artificial branding from v1.0 (placeholder logos, icons, wordmarks) is replaced with the official GSD assets from `packages/mission-control/assets/`
**Plans**: 4 plans

Plans:
- [ ] 11.1-00-PLAN.md — Wave 0: Create 5 failing test stubs for SC-1, SC-3, SC-4, SC-6
- [ ] 11.1-01-PLAN.md — Server security + config bridge (SC-1, SC-2, SC-3)
- [ ] 11.1-02-PLAN.md — Pipeline guards + constants consolidation (SC-4, SC-5)
- [ ] 11.1-03-PLAN.md — ErrorBoundary + branding swap + nul/ removal (SC-6, SC-7)

### Phase 12: GSD 2 Compatibility Pass
**Goal**: The dashboard reads, derives, and operates entirely from GSD 2 conventions — `.gsd/` directory, new file schema, `gsd` binary, and updated command syntax — with zero references to v1 `.planning/` paths or `claude-code` process names
**Depends on**: Phase 11 (v1.0 complete)
**Requirements**: COMPAT-01, COMPAT-02, COMPAT-03, COMPAT-04, COMPAT-05, COMPAT-06, COMPAT-07
**Success Criteria** (what must be TRUE):
  1. Opening a GSD 2 project populates the milestone, slices, and task views from `.gsd/` with no manual path configuration
  2. All command autocomplete entries show GSD 2 syntax (`/gsd`, `/gsd auto`, `/gsd stop`, etc.) — no v1 `/gsd:` entries appear anywhere in the UI
  3. Opening a project that has `.planning/` but no `.gsd/` shows a migration banner; clicking "Run migration" sends `/gsd migrate` to the active session
  4. Settings shows per-phase model selection, budget ceiling, and skill_discovery toggle — v1 fields are absent
  5. The spawned child process is `gsd`, verifiable in Activity Monitor or Task Manager
**Plans**: 7 plans

Plans:
- [ ] 12-01-PLAN.md — Wave 0: Test stubs for COMPAT-04/05/06/07 + GSD 2 fixtures in state-deriver tests
- [ ] 12-02-PLAN.md — Wave 1: Rewrite types.ts (GSD2State) + state-deriver.ts (buildFullState for .gsd/) (COMPAT-02, COMPAT-03)
- [ ] 12-03-PLAN.md — Wave 2: Path migration .planning→.gsd in watcher/server/fs-api + spawn gsd binary (COMPAT-01, COMPAT-05)
- [ ] 12-04-PLAN.md — Wave 3a: Replace slash command registry + MigrationBanner component (COMPAT-04, COMPAT-06)
- [ ] 12-05-PLAN.md — Wave 3b: Settings panel GSD 2 fields + settings-api reads preferences.md (COMPAT-07)
- [ ] 12-07-PLAN.md — Wave 3c: Gap closure — fix test regressions + ChatView v1 state access (COMPAT-01, COMPAT-04)
- [ ] 12-06-PLAN.md — Wave 4: Full suite + human regression test (all COMPAT-*)

### Phase 13: Session Streaming Hardening
**Goal**: The Pi SDK stream is fully parsed, resilient to malformed input, and surfaces cost/token data and auto mode phase transitions to the user in real time — with WebSocket reconnect and process lifecycle handled cleanly
**Depends on**: Phase 12
**Requirements**: STREAM-01, STREAM-02, STREAM-03, STREAM-04, STREAM-05, STREAM-06, STREAM-07
**Success Criteria** (what must be TRUE):
  1. A running `gsd` session streams tool use, text, thinking, phase transitions, cost updates, and auto mode announcements as distinct event types in the chat panel
  2. Injecting a malformed NDJSON chunk does not crash the stream — the chunk is skipped and subsequent events continue rendering normally
  3. Closing and reopening the browser tab within 30 seconds reconnects via exponential backoff and shows state fully reconstructed from `.gsd/` files
  4. Chat header shows a running cost badge; budget warnings appear at 80% (amber) and 95% (red)
  5. While in auto mode an EXECUTING badge is pinned in the chat header; pressing Escape sends an interrupt signal to the `gsd` process
**Plans**: 7 plans

Plans:
- [ ] 13-01-PLAN.md — Wave 1 (TDD): GSD2StreamEvent discriminated union + classifyPiSdkEvent (STREAM-01, STREAM-02)
- [ ] 13-02-PLAN.md — Wave 1: Process lifecycle — interrupt(), crash events, killAll() (STREAM-03)
- [ ] 13-03-PLAN.md — Wave 2: Reconnect refresh + crash recovery banner (STREAM-04, STREAM-05)
- [ ] 13-04-PLAN.md — Wave 2: Cost badge + budget warnings in ChatView (STREAM-06)
- [ ] 13-05-PLAN.md — Wave 2: EXECUTING badge, phase transition cards, Escape interrupt, event wiring (STREAM-07)
- [ ] 13-06-PLAN.md — Wave 3: AppShell wiring + killAll shutdown + human verification (STREAM-03, STREAM-04, STREAM-05, STREAM-06, STREAM-07)
- [ ] 13-07-PLAN.md — Gap closure: Wire session_interrupt WebSocket routing in ws-server.ts + pipeline.ts (STREAM-03, STREAM-07)

### Phase 14: Slice Integration
**Goal**: The Milestones view renders slices as first-class citizens with four distinct states — Planned, In Progress, Needs Review, Complete — each with context-appropriate actions that drive the GSD 2 workflow
**Depends on**: Phase 12
**Requirements**: SLICE-01, SLICE-02, SLICE-03, SLICE-04, SLICE-05, SLICE-06, SLICE-07
**Success Criteria** (what must be TRUE):
  1. Slices appear as an accordion inside their milestone card with no separate nav item; the actively executing slice auto-expands when streaming starts
  2. A Planned slice shows task count, cost estimate, branch, and dependency status; "Start this slice" is disabled while dependencies are incomplete
  3. An In Progress slice shows a task progress bar, running cost, and a "Steer" action that injects direction without stopping auto mode; the card pulses amber
  4. A Needs Review slice presents an interactive UAT checklist; "Merge to main" is locked until all items are checked; the completed checklist is written to `.gsd/S{N}-UAT-RESULTS.md`
  5. A Complete slice shows merge commit info, total cost, and links to view the squash diff and UAT results
**Plans**: 6 plans

Plans:
- [ ] 14-01-PLAN.md — Wave 1 (TDD): GSD2 data layer parsers — parseRoadmap, parsePlan, parseUat, extend buildFullState (SLICE-01 through SLICE-07)
- [ ] 14-02-PLAN.md — Wave 2: SliceAccordion + MilestoneHeader + remove Slice tab (SLICE-01, SLICE-07)
- [ ] 14-03-PLAN.md — Wave 2: Planned + InProgress slice cards + SliceRow dispatcher (SLICE-02, SLICE-03)
- [ ] 14-04-PLAN.md — Wave 3: NeedsReview + Complete cards + UAT write + SliceAction wiring (SLICE-04, SLICE-05, SLICE-06)
- [ ] 14-05-PLAN.md — Wave 4: Integration test + human verification (all SLICE-*)
- [ ] 14-06-PLAN.md — Wave 5 (gap closure): InlineReadPanel + /api/gsd-file — view_plan/view_task/view_diff/view_uat_results wired (SLICE-02, SLICE-03, SLICE-05)

### Phase 15: Tauri Shell
**Goal**: Mission Control runs as a native desktop app — Bun server managed by Tauri, window state persisted, IPC commands wired, and a dependency screen shown on first launch if `bun` or `gsd` is missing
**Depends on**: Phase 12
**Requirements**: TAURI-01, TAURI-02, TAURI-03, TAURI-04, TAURI-05, TAURI-06
**Success Criteria** (what must be TRUE):
  1. `tauri:dev` opens a native window serving the Mission Control UI — no separate terminal step required from the user
  2. Closing the native window kills the Bun server cleanly — no orphaned processes remain in Activity Monitor or Task Manager
  3. Launching the app without `bun` or `gsd` installed shows a pre-dashboard screen with plain-language install instructions before the main UI loads
  4. Reopening the app after moving and resizing the window restores the previous size and position
  5. `tauri:build` produces a `.dmg` on macOS and `.msi`/`.exe` on Windows that install and launch without errors
**Plans**: 5 plans

Plans:
- [ ] 15-01-PLAN.md — Wave 1: Tauri scaffold — Cargo.toml, tauri.conf.json, main.rs/lib.rs skeleton, window-state plugin (TAURI-01, TAURI-04)
- [ ] 15-02-PLAN.md — Wave 2: Bun process manager — spawn, kill on close, crash events (TAURI-02)
- [ ] 15-03-PLAN.md — Wave 2: Dependency check + dep_screen.html — which/where bun+gsd, pre-dashboard screen (TAURI-03)
- [ ] 15-04-PLAN.md — Wave 2: IPC commands — open_folder_dialog, keychain CRUD, open_external, get_platform, restart_bun (TAURI-04, TAURI-05)
- [ ] 15-05-PLAN.md — Wave 3: Build pipeline + human verification — tauri:dev/tauri:build scripts, SC-1 through SC-5 (TAURI-06)

### Phase 16: OAuth + Keychain
**Goal**: Users authenticate with their preferred AI provider through a guided first-launch picker; tokens are stored in the OS keychain and silently refreshed on subsequent launches
**Depends on**: Phase 15
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06
**Success Criteria** (what must be TRUE):
  1. First launch with no stored provider shows the four-option picker; completing the flow dismisses the picker and loads the main UI
  2. Selecting Claude Max or GitHub Copilot opens the OS browser for OAuth; after authorizing, the app intercepts the `gsd://oauth/callback` redirect and stores tokens in the OS keychain
  3. Selecting OpenRouter or API Key shows a masked input; after saving, the token is in the OS keychain and `~/.gsd/auth.json` is written in GSD 2 format
  4. Relaunching the app skips the picker entirely; a token within 5 minutes of expiry is refreshed silently without user interaction
  5. Settings "Provider" section shows active provider, connection status, last-refreshed timestamp, and a "Change provider" action that clears keychain and re-shows the picker
**Plans**: TBD

### Phase 17: Permission Model
**Goal**: Build permissions are expressed as plain-language toggles in a trust dialog rather than a raw skip-permissions toggle; the Bun process layer enforces hard project boundaries and surfaces violations to the user
**Depends on**: Phase 15
**Requirements**: PERM-01, PERM-02, PERM-03, PERM-04
**Success Criteria** (what must be TRUE):
  1. The Settings panel has no "Skip permissions" toggle — its former location shows "Manage build permissions →" which opens a trust dialog
  2. Opening a new project triggers the trust dialog once; after user confirmation a `.gsd/.mission-control-trust` flag is written and the dialog never re-appears for that project
  3. A file operation outside the project directory is blocked by the Bun process layer and surfaces as a `BOUNDARY_VIOLATION` event visible in the UI
  4. Advanced permission settings show plain-language toggles for package install, shell/build commands, git commits, and git push (all off by default) plus an "ask before each operation" debug mode with a visible warning
**Plans**: TBD

### Phase 18: Builder Mode
**Goal**: Non-technical users can operate Mission Control through a vocabulary and routing layer that hides GSD terminology, slash commands, and technical metrics — while the underlying GSD 2 engine runs unchanged
**Depends on**: Phase 13, Phase 14, Phase 16, Phase 17
**Requirements**: BUILDER-01, BUILDER-02, BUILDER-03, BUILDER-04, BUILDER-05, BUILDER-06, BUILDER-07
**Success Criteria** (what must be TRUE):
  1. Switching to Builder mode in Settings immediately relabels the UI (milestone → version, slice → feature, task → step) without restarting the session
  2. In Builder mode the chat input shows "What do you want to build or change?", slash command autocomplete is hidden, and the command palette shortcut is not shown
  3. Sending a natural language message in Builder mode shows a routing badge; the user can override the routing decision before it executes
  4. Discuss cards in Builder mode use plain-language labels and "Question N of N" progress with no GSD terminology; the decision log appears as "Your decisions so far"
  5. Slice cards in Builder mode show state labels (Ready to build / Building now / Ready for your review / Done) and action labels (See what will be built / Build this feature / Give direction / Ship it)
**Plans**: TBD

### Phase 19: Project Workspace
**Goal**: Users have a managed project home screen — a grid of project cards, multi-session tabs, and an auto-created workspace path for Builder users — so Mission Control feels like an app that owns its projects rather than a file-picker tool
**Depends on**: Phase 18
**Requirements**: WORKSPACE-01, WORKSPACE-02, WORKSPACE-03, WORKSPACE-04, WORKSPACE-05
**Success Criteria** (what must be TRUE):
  1. With no project open the app shows a project home screen grid; in Builder mode the empty state shows a brief-taking input; in Developer mode it shows an "Open Folder" button
  2. Each project card shows name, last active timestamp, active milestone, progress bar, and a Resume button; the `···` menu offers Archive, Open in Finder/Explorer, and Remove from list
  3. Archiving a project removes it from the main grid; restoring it returns it; no files are deleted at any point
  4. With two or more projects open a tab bar appears — each tab shows project name and an amber dot when executing; switching tabs swaps the active `gsd` process and WebSocket
  5. In Builder mode, creating a new project auto-creates a directory under `~/GSD Projects/`, runs `git init`, and runs `gsd` setup — no file picker is shown
**Plans**: TBD

### Phase 20: Installer + Distribution
**Goal**: Mission Control ships as a signed, auto-updating native installer for macOS and Windows with a public landing page — reproducible via GitHub Actions CI from a single `release/*` push
**Depends on**: Phase 15, Phase 19
**Requirements**: DIST-01, DIST-02, DIST-03, DIST-04
**Success Criteria** (what must be TRUE):
  1. Pushing to a `release/*` branch produces signed `.dmg`, `.msi`/`.exe`, and `.AppImage`/`.deb` artifacts attached to a draft GitHub Release
  2. Installing the `.dmg` on macOS and the `.msi` on Windows completes without security warnings; the installed app launches and reaches the project home screen
  3. With a newer version available the app checks on launch, downloads in the background, and shows an "Update ready" notification in the sidebar footer — no re-download required to apply
  4. The landing page loads, shows download buttons linking to the latest GitHub Release artifacts, and is readable on a mobile browser
**Plans**: TBD

---

## Progress

**Execution Order:**
12 → 13 / 14 / 15 (parallel after 12) → 16 / 17 (after 15) → 18 (after 13, 14, 16, 17) → 19 (after 18) → 20 (after 15, 19)

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Monorepo + Bun Server Bootstrap | v1.0 | 2/2 | Complete | — |
| 2. File-to-State Pipeline | v1.0 | 3/3 | Complete | — |
| 3. Panel Shell + Design System | v1.0 | 3/3 | Complete | 2026-03-10 |
| 3.1 Layout Rewrite (INSERTED) | v1.0 | 2/2 | Complete | 2026-03-10 |
| 4. Sidebar + Milestone View | v1.0 | 2/2 | Complete | 2026-03-10 |
| 5. Slice Detail + Active Task | v1.0 | 2/2 | Complete | 2026-03-10 |
| 6. Chat Panel + Claude Code Integration | v1.0 | 3/3 | Complete | 2026-03-10 |
| 6.1 Native File System (INSERTED) | v1.0 | 2/2 | Complete | 2026-03-10 |
| 6.2 Live Streaming + Native OS (INSERTED) | v1.0 | 4/4 | Complete | 2026-03-11 |
| 6.3 New Capabilities (INSERTED) | v1.0 | 8/8 | Complete | 2026-03-11 |
| 7. Session Flow + Animation | v1.0 | 4/4 | Complete | — |
| 8. Discuss + Review Modes | v1.0 | 4/4 | Complete | 2026-03-11 |
| 9. Live Preview | v1.0 | 4/4 | Complete | — |
| 10. Keyboard Shortcuts + Accessibility | v1.0 | 3/3 | Complete | 2026-03-12 |
| 11. Documentation Integrity (GAP) | 4/4 | Complete   | 2026-03-12 | 2026-03-12 |
| 11.1 Pre-v2.0 Stabilization (INSERTED) | 3/4 | Complete    | 2026-03-12 | — |
| 12. GSD 2 Compatibility Pass | 6/7 | Complete    | 2026-03-12 | — |
| 13. Session Streaming Hardening | 7/7 | Complete    | 2026-03-13 | — |
| 14. Slice Integration | 6/6 | Complete    | 2026-03-13 | — |
| 15. Tauri Shell | 5/5 | Complete   | 2026-03-13 | — |
| 16. OAuth + Keychain | 4/4 | Complete   | 2026-03-13 | — |
| 17. Permission Model | v2.0 | 0/TBD | Not started | — |
| 18. Builder Mode | v2.0 | 0/TBD | Not started | — |
| 19. Project Workspace | v2.0 | 0/TBD | Not started | — |
| 20. Installer + Distribution | v2.0 | 0/TBD | Not started | — |
