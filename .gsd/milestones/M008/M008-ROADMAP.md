# M008: Web Polish

**Vision:** Seven UI/UX improvements to the GSD web mode — projects page redesign, browser update UI, theme defaults & color audit, remote questions settings, dynamic progress bar, and terminal text size preference. All independent, all targeting daily-use polish and feature parity.

## Success Criteria

- Projects view renders as a styled list; clicking a project expands it to show progress details
- A browser banner appears when a new GSD version is available; the user can trigger an update from the browser
- Dark mode is the default when no user preference is stored
- Every non-monochrome color in light mode uses semantic CSS custom property tokens — zero raw Tailwind accent classes for success/warning/error/info states
- The dashboard progress bar transitions from red to green based on slice completion percentage
- Slack/Discord/Telegram remote question configuration is accessible in the web settings panel
- Terminal text size is adjustable in settings and applies to chat mode and expert split terminals, not the footer terminal
- `npm run build:web-host` exits 0

## Key Risks / Unknowns

- Light mode color audit has wide surface area (~15+ components with raw Tailwind colors) — risk of missing instances or introducing visual regressions
- Browser update trigger needs async npm install with progress — TUI uses synchronous execSync
- Projects page expandable detail for non-active projects may need lightweight filesystem reads

## Proof Strategy

- Color audit surface area → retire in S03 by scanning all components for raw Tailwind accent colors and migrating to tokens, then verifying with `rg` that none remain
- Async update mechanism → retire in S02 by implementing an async API route that spawns npm install and streams progress
- Non-active project detail → retire in S01 by reading .gsd/STATE.md from the project's filesystem (no bridge needed)

## Verification Classes

- Contract verification: `npm run build:web-host` exits 0, `rg` scans for raw Tailwind accent colors return empty
- Integration verification: update check against npm registry, remote questions config read/write against real preferences.md
- Operational verification: none
- UAT / human verification: visual check of progress bar color gradient, projects list layout, light mode consistency

## Milestone Definition of Done

This milestone is complete only when all are true:

- All 5 slice deliverables are complete
- `npm run build:web-host` exits 0
- Light mode has zero raw Tailwind color classes for semantic states — verified by grep
- Dark mode is the default when no user preference is stored
- Projects page renders as a list with expandable detail
- Update banner appears when a newer version exists on npm
- Remote questions config reads/writes preferences correctly
- Progress bar color interpolates based on percentage
- Terminal font size setting persists and applies to the right terminals

## Requirement Coverage

- Covers: R114, R115, R116, R117, R118, R119, R120
- Partially covers: none
- Leaves for later: R111, R112, R020, R021, R022
- Orphan risks: none

## Slices

- [x] **S01: Projects Page Redesign** `risk:medium` `depends:[]`
  > After this: Projects view shows a styled list; clicking a project expands it to reveal progress details (milestone, slice, tasks, cost).

- [x] **S02: Browser Update UI** `risk:medium` `depends:[]`
  > After this: When a new GSD version is available, a banner appears in the browser; clicking "Update" triggers async npm install and shows progress.

- [x] **S03: Theme Defaults & Light Mode Color Audit** `risk:medium` `depends:[]`
  > After this: Dark mode is the default; every non-monochrome color in light mode uses semantic design tokens consistently — verified by grep scan.

- [x] **S04: Remote Questions Settings** `risk:low` `depends:[]`
  > After this: Slack/Discord/Telegram channel type, channel ID, timeout, and poll interval are configurable from the web settings panel.

- [ ] **S05: Progress Bar Dynamics & Terminal Text Size** `risk:low` `depends:[]`
  > After this: Dashboard progress bar transitions red→green by completion percentage; terminal text size is adjustable in settings and applies to chat + expert terminals.

## Boundary Map

### S01 (Projects Page Redesign)

Produces:
- Redesigned `projects-view.tsx` — list layout with expandable selected-project detail panel
- Lightweight project progress reading (filesystem-based, no bridge dependency for non-active projects)

Consumes:
- Existing `/api/projects` route for project discovery
- Existing `/api/preferences` route for dev root
- Existing `ProjectStoreManager` for active project state

### S02 (Browser Update UI)

Produces:
- `/api/update` route — GET for version check, POST for async update trigger
- `UpdateBanner` component in app-shell showing available version with update button
- Async update progress state (pending/running/success/error)

Consumes:
- `src/update-check.ts` — `checkForUpdates()`, `compareSemver()`, `readUpdateCache()`
- `src/update-cmd.ts` — update logic (adapted for async)

### S03 (Theme Defaults & Color Audit)

Produces:
- `defaultTheme="dark"` in ThemeProvider
- All components migrated from raw Tailwind accent classes to semantic CSS tokens
- Light mode `:root` CSS tokens verified for visual consistency

Consumes:
- `web/app/globals.css` — existing `:root` and `.dark` token blocks
- `web/components/theme-provider.tsx` and `web/app/layout.tsx`

### S04 (Remote Questions Settings)

Produces:
- `RemoteQuestionsPanel` component in settings-panels.tsx
- Read/write support for `remote_questions` config via preferences API

Consumes:
- `src/resources/extensions/gsd/preferences.ts` — `RemoteQuestionsConfig` type
- Existing `/api/preferences` or `/api/settings-data` route

### S05 (Progress Bar Dynamics & Terminal Text Size)

Produces:
- Dynamic color interpolation function for progress bar (red→yellow→green)
- Terminal text size preference in settings panel
- Terminal text size application to chat mode and expert split terminal (not footer)

Consumes:
- `web/components/gsd/dashboard.tsx` — existing progress bar
- `web/components/gsd/shell-terminal.tsx` — existing `fontSize: 13`
- `web/lib/settings-types.ts` — for new terminal size preference type
