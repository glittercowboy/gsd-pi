# Requirements: GSD-2

**Defined:** 2026-03-26
**Core Value:** Developers can see and track their project progress in real-time without leaving their terminal workflow

## v1.1 Requirements

Requirements for GSD Watch milestone. Each maps to roadmap phases.

### Tmux Pane Management

- [x] **TMUX-01**: `/gsd watch` detects non-tmux sessions and displays a clear error message
- [x] **TMUX-02**: `/gsd watch` opens a 35%-width right-side tmux split pane
- [x] **TMUX-03**: Watch pane exits cleanly on qq, Esc Esc, or Ctrl+C with proper SIGHUP/SIGINT/SIGTERM handling

### Display

- [x] **DISP-01**: Sidebar renders a hierarchical tree of milestones, phases, and plans with status icons
- [x] **DISP-02**: Each phase displays 7 lifecycle badges (flat icons, no color) derived from file presence (CONTEXT, RESEARCH, UI-SPEC, PLAN, SUMMARY, VERIFICATION, HUMAN-UAT)
- [x] **DISP-03**: Sidebar auto-refreshes on `.planning/` file changes via chokidar with 300ms debounce
- [x] **DISP-04**: Sidebar supports viewport scrolling when tree exceeds terminal height

### Navigation

- [x] **NAV-01**: User can navigate tree with vim keybindings (j/k up/down, h/l collapse/expand)
- [ ] **NAV-02**: User can press ? to show a help overlay with all keybindings
- [x] **NAV-03**: Expand/collapse state persists across file-change refreshes

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### Pane Management

- **TMUX-04**: Singleton guard prevents duplicate watch panes via PID lockfile
- **TMUX-05**: `/gsd watch` focuses existing pane if already running

### Advanced Display

- **DISP-05**: Filter/search within tree for large projects
- **DISP-06**: Phase focus mode (zoom into single milestone)
- **DISP-07**: Progress percentage per milestone from GSD database

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Write/mutation from sidebar | Violates single-responsibility; use existing `/gsd` commands |
| Non-tmux fallback TUI | Doubles rendering complexity; clear error message is sufficient |
| Polling-based updates | Burns CPU; chokidar event-driven is the only correct approach |
| Mouse click navigation | Conflicts with tmux mouse mode; vim keys cover all navigation |
| Web/remote dashboard | Out of scope; GSD is terminal-local |
| Colored badges | User preference: flat icons only, no color |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TMUX-01 | Phase 2 | Complete |
| TMUX-02 | Phase 2 | Complete |
| TMUX-03 | Phase 2 | Complete |
| DISP-03 | Phase 2 | Complete |
| DISP-01 | Phase 3 | Complete |
| DISP-02 | Phase 3 | Complete |
| DISP-04 | Phase 4 | Complete |
| NAV-01 | Phase 5 | Complete |
| NAV-02 | Phase 5 | Pending |
| NAV-03 | Phase 5 | Complete |

**Coverage:**
- v1.1 requirements: 10 total
- Mapped to phases: 10
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-26*
*Last updated: 2026-03-26 after roadmap creation — all requirements mapped*
