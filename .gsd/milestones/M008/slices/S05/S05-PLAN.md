# S05: Progress Bar Dynamics & Terminal Text Size

**Goal:** Dashboard progress bar transitions red→green by completion percentage; terminal text size is adjustable in settings and applies to chat + expert terminals, not the footer terminal.
**Demo:** Open dashboard — progress bar color reflects completion percentage (red at 0%, yellow at ~50%, green at 100%). Open settings — terminal text size slider/preset changes font size in power view DualTerminal and chat mode content. Footer terminal stays at default 13px. Setting persists across refresh.

## Must-Haves

- Progress bar uses oklch color interpolation: hue 25 (red) → 85 (yellow) → 145 (green) based on `progressPercent`
- `bg-foreground` class removed from progress bar div, replaced with inline `backgroundColor`
- Terminal text size preference persisted in localStorage (key: `gsd-terminal-font-size`, default: 13)
- `TerminalSizePanel` added to settings-panels.tsx with preset size options
- `ShellTerminal` accepts optional `fontSize` prop; `DualTerminal` threads the preference to both instances
- Footer terminal in `app-shell.tsx` does NOT receive the font size preference (D084)
- Chat mode content area respects the terminal font size setting
- `npm run build:web-host` exits 0

## Verification

- `npm run build:web-host` exits 0
- Visual: dashboard progress bar shows red at low %, yellow at ~50%, green at high %
- Visual: changing terminal size in settings updates DualTerminal font size
- Visual: footer terminal remains at 13px regardless of setting
- Visual: setting persists after page refresh
- `rg "bg-foreground" web/components/gsd/dashboard.tsx` returns no matches on the progress bar line

## Tasks

- [ ] **T01: Add progress bar color interpolation to dashboard** `est:20m`
  - Why: R116 — progress bar is monochrome (`bg-foreground`); needs dynamic red→yellow→green color based on completion percentage
  - Files: `web/components/gsd/dashboard.tsx`
  - Do: Write a `getProgressColor(percent: number): string` function that returns an oklch color string interpolating hue from 25 (red/destructive) through 85 (yellow/warning) to 145 (green/success). Apply it as inline `backgroundColor` on the progress bar div (around line 387), removing the `bg-foreground` class. Keep the existing `transition-all duration-500` for smooth color transitions. Use lightness/chroma values that work in both light and dark themes (reference existing oklch tokens in globals.css for appropriate values). Optionally color the percentage text to match.
  - Verify: `npm run build:web-host` exits 0. `rg "bg-foreground" web/components/gsd/dashboard.tsx` does not match the progress bar element. Visual check in browser confirms red→yellow→green gradient behavior.
  - Done when: progress bar color dynamically reflects completion percentage using oklch interpolation, build passes

- [ ] **T02: Add terminal text size preference with settings panel** `est:45m`
  - Why: R120 — terminal font size is hardcoded to 13px with no user control; needs a setting that applies to expert/chat terminals but not footer
  - Files: `web/components/gsd/shell-terminal.tsx`, `web/components/gsd/dual-terminal.tsx`, `web/components/gsd/app-shell.tsx`, `web/components/gsd/settings-panels.tsx`, `web/components/gsd/command-surface.tsx`, `web/components/gsd/chat-mode.tsx`
  - Do: (1) Create a `useTerminalFontSize()` hook that reads/writes `gsd-terminal-font-size` from localStorage with default 13, using the same pattern as sidebar collapsed state in app-shell.tsx (useState + useEffect + storage event sync). (2) Add `TerminalSizePanel` to settings-panels.tsx with preset size buttons (11, 12, 13, 14, 15, 16) following existing panel patterns (SettingsHeader, KvRow, Pill helpers). (3) Wire `TerminalSizePanel` into command-surface.tsx in the settings section. (4) Add optional `fontSize?: number` prop to `ShellTerminalProps` in shell-terminal.tsx; pass it to `getXtermOptions()` to override the default 13. (5) In dual-terminal.tsx, read the font size preference and pass it to both ShellTerminal instances. (6) In app-shell.tsx, do NOT pass fontSize to the footer terminal — it stays at default 13. (7) In chat-mode.tsx, apply the font size setting to the chat content area text sizing. Use a cross-component sync mechanism (custom event `terminal-font-size-changed` or storage event listener) so that changing the setting in the panel updates terminals without a page refresh.
  - Verify: `npm run build:web-host` exits 0. Visual: change size in settings → DualTerminal updates. Footer terminal stays 13px. Setting persists after refresh.
  - Done when: terminal text size is user-configurable, persists in localStorage, applies to expert/chat terminals, explicitly excluded from footer terminal, build passes

## Files Likely Touched

- `web/components/gsd/dashboard.tsx`
- `web/components/gsd/shell-terminal.tsx`
- `web/components/gsd/dual-terminal.tsx`
- `web/components/gsd/app-shell.tsx`
- `web/components/gsd/settings-panels.tsx`
- `web/components/gsd/command-surface.tsx`
- `web/components/gsd/chat-mode.tsx`
