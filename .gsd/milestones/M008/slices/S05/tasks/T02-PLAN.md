---
estimated_steps: 7
estimated_files: 7
---

# T02: Add terminal text size preference with settings panel

**Slice:** S05 — Progress Bar Dynamics & Terminal Text Size
**Milestone:** M008

## Description

Terminal font size is hardcoded to 13px in `shell-terminal.tsx` with no user control. This task adds a `useTerminalFontSize()` hook for localStorage persistence, a `TerminalSizePanel` in settings, and threads the font size through `ShellTerminal` props so it applies to DualTerminal (expert/power view) and chat-mode content — but explicitly NOT the footer terminal (D084). Satisfies R120.

## Steps

1. **Create `useTerminalFontSize` hook** — Add to a new file `web/lib/use-terminal-font-size.ts` (or inline in app-shell.tsx, but a dedicated hook is cleaner for cross-component use). Pattern: mirror sidebar collapsed state in `app-shell.tsx` (lines 129–145).
   - Default value: `13`
   - localStorage key: `gsd-terminal-font-size`
   - Returns `[fontSize: number, setFontSize: (size: number) => void]`
   - On mount, read from localStorage; if missing or invalid, use default 13
   - On change, write to localStorage AND dispatch a `storage` event (or a custom event `terminal-font-size-changed`) so other components using the hook re-sync without page refresh
   - Listen for `storage` events to sync across tabs / components

2. **Add `TerminalSizePanel` to settings-panels.tsx** — Follow existing panel patterns (e.g., `RemoteQuestionsPanel` or `BudgetPanel`).
   - Use `SettingsHeader` with title "Terminal Text Size" and appropriate description
   - Display preset size buttons: 11, 12, 13 (default), 14, 15, 16
   - Highlight the currently active size
   - Use the `useTerminalFontSize` hook to read/write the preference
   - Use existing helper components (`Pill`, `KvRow`, etc.) as appropriate

3. **Wire `TerminalSizePanel` into command-surface.tsx** — Find where other settings panels are rendered (look for `PrefsPanel`, `ModelRoutingPanel`, `BudgetPanel`, `RemoteQuestionsPanel` in the settings section). Import and render `TerminalSizePanel` alongside them.

4. **Add optional `fontSize` prop to `ShellTerminal`** — In `web/components/gsd/shell-terminal.tsx`:
   - Add `fontSize?: number` to `ShellTerminalProps` (line ~20)
   - Update `getXtermOptions(isDark: boolean)` signature to accept fontSize: `getXtermOptions(isDark: boolean, fontSize?: number)`
   - Use `fontSize ?? 13` as the value in the returned options object
   - Pass the prop through `TerminalInstance` internal component as needed

5. **Thread font size to DualTerminal** — In `web/components/gsd/dual-terminal.tsx`:
   - Import and use `useTerminalFontSize` hook
   - Pass `fontSize` to both `<ShellTerminal>` instances (lines ~140 and ~153)

6. **Exclude footer terminal** — In `web/components/gsd/app-shell.tsx`:
   - The footer terminal at line ~390 (`<ShellTerminal className="h-full" />`) must NOT receive a fontSize prop
   - Do NOT import `useTerminalFontSize` in app-shell for the footer — leave it as-is

7. **Apply to chat mode content** — In `web/components/gsd/chat-mode.tsx`:
   - The `StructuredTerminalActionPane` (line ~1720) uses a headless xterm Terminal whose output is parsed into React chat bubbles. The headless terminal is never displayed directly.
   - The useful application of the font size setting in chat mode is to the rendered chat content text. Look for the text size classes used for chat bubble content (likely `text-sm` or `text-[11px]`).
   - Import `useTerminalFontSize` and apply the font size to chat content rendering using inline `style={{ fontSize: '${size}px' }}` or equivalent.
   - If the chat mode content structure makes this impractical (e.g., heavily nested markdown rendering), applying the setting to a wrapper div's font-size CSS is acceptable.

## Must-Haves

- [ ] `useTerminalFontSize` hook reads/writes localStorage with key `gsd-terminal-font-size`, default 13
- [ ] `TerminalSizePanel` renders in settings with preset size options
- [ ] `ShellTerminal` accepts optional `fontSize` prop and passes it to xterm options
- [ ] `DualTerminal` reads font size preference and passes to both `ShellTerminal` instances
- [ ] Footer terminal in `app-shell.tsx` does NOT receive font size prop (stays at default 13)
- [ ] Chat mode content respects the font size setting
- [ ] Setting persists across page refresh via localStorage

## Verification

- `npm run build:web-host` exits 0
- Visual: open power view → both terminals in DualTerminal use the configured font size
- Visual: open settings → TerminalSizePanel shows with preset options, changing selection updates terminals
- Visual: footer terminal remains at default 13px regardless of setting
- Visual: refresh page → setting is preserved
- `rg "TerminalSizePanel" web/components/gsd/settings-panels.tsx` confirms panel exists
- `rg "useTerminalFontSize" web/` confirms hook is imported in dual-terminal, settings-panels, and chat-mode

## Inputs

- `web/components/gsd/shell-terminal.tsx` — `getXtermOptions(isDark)` at line ~85 with `fontSize: 13`; `ShellTerminalProps` at line ~20
- `web/components/gsd/dual-terminal.tsx` — two `<ShellTerminal>` instances at lines ~140 and ~153
- `web/components/gsd/app-shell.tsx` — footer terminal at line ~390; localStorage pattern for sidebar state at lines ~129–145
- `web/components/gsd/settings-panels.tsx` — four existing exported panels as templates
- `web/components/gsd/command-surface.tsx` — settings panel wiring
- `web/components/gsd/chat-mode.tsx` — `StructuredTerminalActionPane` at line ~1720, chat bubble rendering

## Expected Output

- `web/lib/use-terminal-font-size.ts` — new hook for terminal font size persistence
- `web/components/gsd/shell-terminal.tsx` — `fontSize` prop added, threaded to xterm options
- `web/components/gsd/dual-terminal.tsx` — reads preference, passes to ShellTerminal instances
- `web/components/gsd/settings-panels.tsx` — `TerminalSizePanel` exported
- `web/components/gsd/command-surface.tsx` — TerminalSizePanel wired into settings section
- `web/components/gsd/chat-mode.tsx` — font size setting applied to chat content area
- `web/components/gsd/app-shell.tsx` — footer terminal unchanged (no fontSize prop)
