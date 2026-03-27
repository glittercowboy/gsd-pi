# Roadmap — GSD Watch

**Milestone:** v1.1 — GSD Watch
**Goal:** Add a live tmux sidebar that displays real-time project status as developers work.
**Phase numbering:** Continues from v1.0 (Phase 1 complete). Starts at Phase 2.

## Phases

- [x] **Phase 2: Foundation** — Process lifecycle, tmux pane management, file watching infrastructure (completed 2026-03-27)
- [ ] **Phase 3: Core Renderer** — Tree model, lifecycle badges, status icons, ANSI-safe layout
- [ ] **Phase 4: Renderer Entry + Command Integration** — Subprocess wiring, viewport scrolling, `/gsd watch` registration
- [ ] **Phase 5: Navigation** — Vim keybindings, expand/collapse, help overlay, collapse state persistence

## Phase Details

### Phase 2: Foundation
**Goal**: The tmux environment is validated, a sidebar pane opens at 35% width, file changes trigger debounced events, and all process lifecycle edge cases are handled safely.
**Depends on**: Phase 1 (v1.0 complete)
**Requirements**: TMUX-01, TMUX-02, TMUX-03, DISP-03
**Success Criteria** (what must be TRUE):
  1. Running `/gsd watch` outside tmux prints a clear, actionable error message and exits without spawning any process.
  2. Running `/gsd watch` inside tmux opens a right-side split pane at 35% of terminal width and the sidebar process is running in it.
  3. The sidebar process exits cleanly (no zombie, no orphan) when the user presses qq, Esc Esc, or Ctrl+C, and also when tmux kills the pane directly.
  4. Editing any file under `.planning/` triggers a sidebar refresh within 400ms; rapid sequential writes coalesce into a single refresh (no event flood).
**Plans:** 3/3 plans complete

Plans:
- [x] 02-01-PLAN.md — Shared types and chokidar file watcher with coalescing debounce (DISP-03)
- [x] 02-02-PLAN.md — Tmux orchestrator, singleton guard, pane creation, and command registration (TMUX-01, TMUX-02)
- [x] 02-03-PLAN.md — Renderer entry subprocess with signal handling and quit key detection (TMUX-03)

### Phase 3: Core Renderer
**Goal**: The sidebar displays a correct, readable hierarchical tree of milestones, phases, and plans with status icons and 7 lifecycle badges derived from file presence — no crashes on narrow panes.
**Depends on**: Phase 2
**Requirements**: DISP-01, DISP-02
**Success Criteria** (what must be TRUE):
  1. The sidebar tree shows all milestones, their phases, and plans in hierarchical indentation matching the `.planning/phases/` directory structure.
  2. Each phase row displays exactly 7 lifecycle badge slots (CONTEXT, RESEARCH, UI-SPEC, PLAN, SUMMARY, VERIFICATION, HUMAN-UAT) as flat icons with no color — filled when the corresponding file is present, empty otherwise.
  3. Status icons (done/active/pending/blocked) appear next to each node, matching the current state derived from plan files.
  4. No ANSI rendering artifacts or line overflow occur in a pane as narrow as 30 columns.
**Plans:** 1/2 plans executed

Plans:
- [x] 03-01-PLAN.md — Tree data types, filesystem scanner, badge detection, and status derivation (DISP-01, DISP-02)
- [ ] 03-02-PLAN.md — Tree renderer layout engine, badge formatting, and renderer-entry integration (DISP-01, DISP-02)

### Phase 4: Renderer Entry + Command Integration
**Goal**: The renderer subprocess runs as a standalone process wired to stdin/stdout, supports viewport scrolling for tall trees, and the `/gsd watch` command is registered end-to-end in the GSD dispatcher.
**Depends on**: Phase 3
**Requirements**: DISP-04
**Success Criteria** (what must be TRUE):
  1. A project with more than 15 visible tree nodes causes the sidebar to show a scrollable viewport — nodes above and below the visible area are accessible without truncation.
  2. Running `/gsd watch` through the full GSD command chain (dispatcher -> handler -> orchestrator -> renderer subprocess) produces a working sidebar pane.
  3. The renderer subprocess can be invoked directly from the command line (bypassing the GSD dispatcher) for isolated testing.
**Plans**: TBD

### Phase 5: Navigation
**Goal**: The user can move through the tree with vim keys, collapse and expand nodes, view a help overlay of all keybindings, and expand/collapse state survives automatic file-change refreshes.
**Depends on**: Phase 4
**Requirements**: NAV-01, NAV-02, NAV-03
**Success Criteria** (what must be TRUE):
  1. Pressing j/k moves the cursor down/up through visible tree nodes; pressing h/l on a parent node collapses/expands it.
  2. Pressing ? displays a help overlay listing all keybindings; pressing ? again or Esc dismisses it.
  3. Collapsing a parent node, then triggering a file-change refresh, leaves that node in its collapsed state — the user's expand/collapse choices are not reset by automatic refreshes.
  4. Deleting a phase directory that was previously collapsed causes no crash or visual corruption on the next refresh.
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 2. Foundation | 3/3 | Complete   | 2026-03-27 |
| 3. Core Renderer | 1/2 | In Progress|  |
| 4. Renderer Entry + Command Integration | 0/? | Not started | — |
| 5. Navigation | 0/? | Not started | — |

---
*Roadmap created: 2026-03-26 for milestone v1.1 GSD Watch*
*Requirements coverage: 10/10 v1.1 requirements mapped*
