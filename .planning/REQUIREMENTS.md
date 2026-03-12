# Requirements: GSD Mission Control

**Defined:** 2026-03-12
**Core Value:** A developer types in Mission Control's chat, Claude Code executes, code lands, and dashboard panels update in real time — the full build loop in one window.

## v2.0 Requirements

Requirements for the Native Desktop milestone. Each maps to roadmap phases 12–20.

### GSD 2 Compatibility (COMPAT)

- [x] **COMPAT-01**: File watcher targets `.gsd/` directory, not `.planning/`
- [x] **COMPAT-02**: State deriver reads GSD 2 file schema — `STATE.md`, `M001-ROADMAP.md`, `S01-PLAN.md`, `T01-SUMMARY.md`, `DECISIONS.md`, `preferences.md`, `PROJECT.md`, `M001-CONTEXT.md`
- [x] **COMPAT-03**: Milestone/slice/task file indices derived dynamically from STATE.md (never hardcoded `M001`, `S01`, `T01`)
- [x] **COMPAT-04**: Command autocomplete shows GSD 2 syntax (`/gsd`, `/gsd auto`, `/gsd stop`, `/gsd discuss`, `/gsd status`, `/gsd queue`, `/gsd prefs`, `/gsd migrate`, `/gsd doctor`); all v1 `/gsd:` entries removed
- [x] **COMPAT-05**: Child process spawns `gsd` binary, not `claude` or `claude-code`
- [x] **COMPAT-06**: Migration banner shown when `.planning/` exists but no `.gsd/` — "Run migration" sends `/gsd migrate` to active session
- [x] **COMPAT-07**: Settings panel updated — per-phase model selection (research/planning/execution/completion), budget ceiling field, skill_discovery toggle; v1 settings removed

### Session Streaming (STREAM)

- [x] **STREAM-01**: Pi SDK event parser handles plain text, tool use blocks, tool result blocks, phase transitions (Research/Plan/Execute/Complete), cost/token updates, stuck detection, timeout messages, auto mode phase announcements
- [x] **STREAM-02**: Stream parser is resilient — malformed chunks logged and skipped, never crash the stream
- [x] **STREAM-03**: Process lifecycle — clean spawn with correct working directory, graceful shutdown (interrupt → wait → kill), crash recovery (reconnect option, preserve history, attempt restart), orphan prevention (registry kills all processes on app close)
- [x] **STREAM-04**: WebSocket reconnect uses exponential backoff (1s → 2s → 4s → 8s → 30s max)
- [x] **STREAM-05**: On reconnect, full state re-derived from `.gsd/` files — no reliance on in-memory state; stale state detected via `STATE.md` modified time
- [x] **STREAM-06**: Cost/token display — running cost badge in chat header, per-slice total on slice card, milestone total in milestone header; budget ceiling warning at 80% (amber) and 95% (red)
- [x] **STREAM-07**: Auto mode indicators — persistent EXECUTING badge in chat header; phase announcements update active slice card in real time; Escape key sends interrupt signal to `gsd` process

### Slice Integration (SLICE)

- [ ] **SLICE-01**: Milestones view renders slices as accordion inside milestone, not separate nav item; active executing slice auto-expands
- [ ] **SLICE-02**: Planned state — shows task count, cost estimate, branch, dependencies with completion status; "Review plan" opens S{N}-PLAN.md inline; "Start this slice" sends `/gsd auto` (disabled if dependencies incomplete)
- [ ] **SLICE-03**: In Progress state — shows task progress bar, branch, commit count, running cost; "Pause" sends escape signal; "View task" opens current T{N}-PLAN.md inline; "Steer" injects mid-slice direction without stopping auto mode; card pulses amber
- [ ] **SLICE-04**: Needs Review state — shows completed task count, total cost, UAT checklist progress; "Run UAT checklist" expands interactive checklist from S{N}-UAT.md; "Merge to main" gated until all UAT items checked; merge sends git squash merge
- [ ] **SLICE-05**: Complete state — shows merge commit info and total cost; "View diff" opens squash commit diff inline; "View UAT results" shows completed checklist
- [ ] **SLICE-06**: UAT checklist state persists — completed checklist written to `.gsd/S{N}-UAT-RESULTS.md`
- [ ] **SLICE-07**: Milestone header shows total cost across slices, budget ceiling indicator, "Start next slice" shortcut when no slice executing

### Tauri Shell (TAURI)

- [ ] **TAURI-01**: `src-tauri/` added alongside `packages/`; `tauri.conf.json` configured (productName, identifier, window dimensions, `gsd://` custom protocol, devUrl, CSP for localhost WebSocket)
- [ ] **TAURI-02**: Rust backend spawns Bun server on app start, stores handle, kills cleanly on window close, emits event to frontend on Bun crash
- [ ] **TAURI-03**: Dependency check on startup — `bun` and `gsd` presence verified; if missing, pre-dashboard dependency screen shown with plain-language install instructions
- [ ] **TAURI-04**: Window state restored (size/position) via `window-state` plugin; OS native title bar (frameless: false)
- [ ] **TAURI-05**: Tauri IPC commands implemented — `open_folder_dialog`, `get_credential`, `set_credential`, `delete_credential`, `open_external`, `get_platform`, `restart_bun`
- [ ] **TAURI-06**: Build pipeline — `tauri:dev` and `tauri:build` scripts; dev starts Bun then opens native window

### OAuth + Keychain (AUTH)

- [ ] **AUTH-01**: First-launch provider picker screen — four options (Claude Max/Anthropic, GitHub Copilot, OpenRouter, API Key); shown only if `gsd-mission-control/active_provider` absent from keychain
- [ ] **AUTH-02**: OAuth flow for Claude Max + GitHub Copilot — `open_external(authUrl)`, intercept `gsd://oauth/callback`, PKCE exchange in Rust
- [ ] **AUTH-03**: Tokens stored in OS keychain (`anthropic_access_token`, `anthropic_refresh_token`, `active_provider`); `~/.gsd/auth.json` written in GSD 2 format
- [ ] **AUTH-04**: API key flow for OpenRouter + direct keys — masked input with provider dropdown, stored in keychain as `{provider}_api_key`, writes `~/.gsd/auth.json`
- [ ] **AUTH-05**: Token refresh on app start — check expiry, refresh silently if within 5 min; re-auth prompt on refresh failure
- [ ] **AUTH-06**: Settings "Provider" section — active provider display, connection status, last-refreshed timestamp, "Change provider" clears keychain and re-shows picker

### Permission Model (PERM)

- [ ] **PERM-01**: Raw "Skip permissions" toggle removed from Settings; replaced with "Manage build permissions →" link opening trust dialog
- [ ] **PERM-02**: Trust dialog shown once per new project — plain-language explanation of what AI will/won't do; "trust granted" flag stored in `.gsd/.mission-control-trust`
- [ ] **PERM-03**: Hard boundary enforcement in Bun process layer — stdout intercepted for out-of-project file ops; violations blocked and surfaced as `BOUNDARY_VIOLATION` event in UI
- [ ] **PERM-04**: Advanced permission settings — plain-language toggles for package install, shell/build commands, git commits, git push (off by default), ask-before-each-operation (debug mode with warning)

### Builder Mode (BUILDER)

- [ ] **BUILDER-01**: "Interface mode" toggle in Settings — Developer / Builder; default Developer; switching does not restart session
- [ ] **BUILDER-02**: Builder vocabulary applied throughout — milestone→version, slice→feature, task→step, must-haves→goals, UAT→testing; context budget, token count, model name hidden
- [ ] **BUILDER-03**: Builder chat input — placeholder "What do you want to build or change?"; slash autocomplete hidden; command palette shortcut hidden
- [ ] **BUILDER-04**: Intent classifier for Builder mode — lightweight Claude API call with STATE.md context; routes to GSD_COMMAND / PHASE_QUESTION / GENERAL_CODING / UI_PHASE_GATE; routing badge shown with override option
- [ ] **BUILDER-05**: Discuss cards in Builder mode — plain-language labels, "Question N of N" progress, no GSD terminology; decision log visible as "Your decisions so far"
- [ ] **BUILDER-06**: Slice cards in Builder mode — state labels (Ready to build / Building now / Ready for your review / Done) and action labels (See what will be built / Build this feature / Give direction / Ship it) updated
- [ ] **BUILDER-07**: Phase gate in Builder mode — intercepts frontend build without design contract; shows plain-language prompt to set up design or skip

### Project Workspace (WORKSPACE)

- [ ] **WORKSPACE-01**: Managed workspace path for Builder users (`~/GSD Projects/` or `%USERPROFILE%\GSD Projects\`, configurable in Settings); new project auto-creates dir, runs `git init`, runs `gsd` setup, no file picker shown
- [ ] **WORKSPACE-02**: Project home screen shown when no project open — grid of project cards; empty state differs by mode (Builder: brief-taking input; Developer: Open Folder)
- [ ] **WORKSPACE-03**: Project card shows name, last active timestamp, active milestone, progress bar, Resume button; `···` menu offers Archive, Open in Finder/Explorer, Remove from list
- [ ] **WORKSPACE-04**: Multi-session tabs surface from home screen — tab bar appears with 2+ open projects; each tab has own `gsd` process and WebSocket; tab shows project name + amber dot if executing
- [ ] **WORKSPACE-05**: Project archiving — archive removes from main grid, restore returns it; no files deleted

### Distribution (DIST)

- [ ] **DIST-01**: GitHub Actions release pipeline — triggers on `release/*` push or manual dispatch; matrix macOS/Windows/Linux; produces `.dmg`, `.msi`+`.exe`, `.AppImage`+`.deb`; draft GitHub Release created with artifacts
- [ ] **DIST-02**: Code signing — macOS: Apple Developer ID via GitHub secret; Windows: self-signed for v2.0; Linux: GPG signed AppImage
- [ ] **DIST-03**: Auto-update — Tauri updater plugin, check on launch, background download, "Update ready" notification in sidebar footer, update server is GitHub Releases JSON endpoint
- [ ] **DIST-04**: Landing page (single HTML, GitHub Pages or Vercel) — GSD branding, headline, download buttons linking to latest GitHub Release, "Powered by GSD 2", responsive

## v3 Requirements

Deferred to future release.

### Visual & Analytics

- **VIS-01**: D3 force graph for boundary maps
- **VIS-02**: Real-time diff viewer
- **VIS-03**: Snapshot/replay timeline
- **VIS-04**: Visual project analytics dashboard
- **VIS-05**: Remotion marketing export compositions

### Team Features

- **TEAM-01**: GSD Teams hosted sync server
- **TEAM-02**: Real-time presence layer

### Advanced Shell

- **SHELL-01**: Bundle Bun and gsd-pi inside installer (zero-dependency install)
- **SHELL-02**: Custom native title bar
- **SHELL-03**: Multi-window support
- **SHELL-04**: Semantic version control UI / boundary map graph

## Out of Scope

| Feature | Reason |
|---------|--------|
| Merge to get-shit-done v1 or PR to upstream | Separate product line — GSD 2 is the target platform |
| Mobile/responsive layout | Desktop-first; mobile deferred beyond v3 |
| GSD 2.0 deterministic tool visibility | Requires V2 API coordination with Lex |
| Cloud sync or telemetry | No data leaves local machine — architectural constraint |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| COMPAT-01 | Phase 12 | Complete |
| COMPAT-02 | Phase 12 | Complete |
| COMPAT-03 | Phase 12 | Complete |
| COMPAT-04 | Phase 12 | Complete |
| COMPAT-05 | Phase 12 | Complete |
| COMPAT-06 | Phase 12 | Complete |
| COMPAT-07 | Phase 12 | Complete |
| STREAM-01 | Phase 13 | Complete |
| STREAM-02 | Phase 13 | Complete |
| STREAM-03 | Phase 13 | Complete |
| STREAM-04 | Phase 13 | Complete |
| STREAM-05 | Phase 13 | Complete |
| STREAM-06 | Phase 13 | Complete |
| STREAM-07 | Phase 13 | Complete |
| SLICE-01 | Phase 14 | Pending |
| SLICE-02 | Phase 14 | Pending |
| SLICE-03 | Phase 14 | Pending |
| SLICE-04 | Phase 14 | Pending |
| SLICE-05 | Phase 14 | Pending |
| SLICE-06 | Phase 14 | Pending |
| SLICE-07 | Phase 14 | Pending |
| TAURI-01 | Phase 15 | Pending |
| TAURI-02 | Phase 15 | Pending |
| TAURI-03 | Phase 15 | Pending |
| TAURI-04 | Phase 15 | Pending |
| TAURI-05 | Phase 15 | Pending |
| TAURI-06 | Phase 15 | Pending |
| AUTH-01 | Phase 16 | Pending |
| AUTH-02 | Phase 16 | Pending |
| AUTH-03 | Phase 16 | Pending |
| AUTH-04 | Phase 16 | Pending |
| AUTH-05 | Phase 16 | Pending |
| AUTH-06 | Phase 16 | Pending |
| PERM-01 | Phase 17 | Pending |
| PERM-02 | Phase 17 | Pending |
| PERM-03 | Phase 17 | Pending |
| PERM-04 | Phase 17 | Pending |
| BUILDER-01 | Phase 18 | Pending |
| BUILDER-02 | Phase 18 | Pending |
| BUILDER-03 | Phase 18 | Pending |
| BUILDER-04 | Phase 18 | Pending |
| BUILDER-05 | Phase 18 | Pending |
| BUILDER-06 | Phase 18 | Pending |
| BUILDER-07 | Phase 18 | Pending |
| WORKSPACE-01 | Phase 19 | Pending |
| WORKSPACE-02 | Phase 19 | Pending |
| WORKSPACE-03 | Phase 19 | Pending |
| WORKSPACE-04 | Phase 19 | Pending |
| WORKSPACE-05 | Phase 19 | Pending |
| DIST-01 | Phase 20 | Pending |
| DIST-02 | Phase 20 | Pending |
| DIST-03 | Phase 20 | Pending |
| DIST-04 | Phase 20 | Pending |

**Coverage:**
- v2.0 requirements: 47 total
- Mapped to phases: 47
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-12*
*Last updated: 2026-03-12 — traceability expanded to individual requirement rows after roadmap creation*
