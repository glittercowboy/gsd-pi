---
id: S01
parent: M009
milestone: M009
provides:
  - POST /api/files endpoint with path validation, traversal rejection, and write security
  - useEditorFontSize() hook with localStorage persistence (key gsd-editor-font-size, default 14, range 8–24)
  - EditorSizePanel settings component with preset buttons and live preview
  - EditorSizePanel wired into command-surface gsd-prefs section
requires: []
affects:
  - S02
  - S04
key_files:
  - web/app/api/files/route.ts
  - web/lib/use-editor-font-size.ts
  - web/components/gsd/settings-panels.tsx
  - web/components/gsd/command-surface.tsx
key_decisions:
  - POST handler reuses resolveSecurePath/getRootForMode/resolveProjectCwd — single security surface shared with GET
  - Default editor font size is 14px (vs terminal's 13px) — editors conventionally use slightly larger text
  - EditorSizePanel mirrors TerminalSizePanel pattern exactly — same structure, different storage key and event
patterns_established:
  - POST handler follows same validation chain as GET (resolveSecurePath → parent check → write) — no new security primitives
  - useEditorFontSize clones useTerminalFontSize pattern — localStorage + CustomEvent + storage event for cross-tab sync
  - Settings panels follow SettingsHeader + preset buttons + live preview pattern
observability_surfaces:
  - POST /api/files returns structured { error } JSON with 400/404/413 status codes
  - localStorage key gsd-editor-font-size inspectable via devtools
  - CustomEvent editor-font-size-changed on window for same-tab sync
  - data-testid="settings-editor-size" for UI testing
drill_down_paths:
  - .gsd/milestones/M009/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M009/slices/S01/tasks/T02-SUMMARY.md
duration: 23m
verification_result: passed
completed_at: 2026-03-18
---

# S01: File Write API & Editor Font Size

**POST /api/files writes files to disk with full path validation; editor font size is configurable in settings with localStorage persistence.**

## What Happened

T01 added a POST handler to the existing `/api/files` route. It parses JSON body, validates `root` is "gsd" or "project", validates `content` is a string (including empty string), checks content size against `MAX_FILE_SIZE` (413), resolves the path with `resolveSecurePath()` (400 for traversal/absolute paths), checks parent directory exists (404), then writes with `writeFileSync`. All error responses use structured `{ error: "..." }` JSON matching the GET handler's convention. Security uses the exact same `resolveSecurePath()` the GET handler uses — no new validation code.

T02 created `useEditorFontSize()` hook cloning the proven `useTerminalFontSize` pattern: `gsd-editor-font-size` localStorage key, default 14, range 8–24, cross-tab sync via `storage` event, same-tab sync via `editor-font-size-changed` CustomEvent. Added `EditorSizePanel` to `settings-panels.tsx` with preset buttons [11–16], 14 marked as default, and a live `font-mono` preview div. Wired into `command-surface.tsx` in the `gsd-prefs` case after `TerminalSizePanel`.

## Verification

- `npm run build:web-host` exits 0
- POST valid file write → 200 `{ success: true }`, content confirmed on disk
- POST path traversal (`../../etc/passwd`) → 400 with descriptive error
- POST absolute path (`/etc/passwd`) → 400
- POST missing parent dir → 404 "Parent directory does not exist"
- POST missing path field → 400 "Missing or invalid path"
- POST empty content → 200, file cleared on disk
- POST invalid root → 400
- POST oversized content → 413
- useEditorFontSize localStorage read/write verified
- CustomEvent sync verified
- Clamping logic verified (below 8 → 8, above 24 → 24)
- EditorSizePanel component render path confirmed in command-surface at line 2037

## Requirements Advanced

- R124 — POST handler fully implemented with all path validation, traversal rejection, and structured error responses. Ready for S02 Save button consumption.
- R121 — Editor font size hook and settings panel complete. Persistence and sync working. Ready for S02 to apply font size to CodeMirror editor.

## Requirements Validated

- None — R124 and R121 need S02 integration (actual editor consuming the font size and save endpoint) before full validation.

## New Requirements Surfaced

- None

## Requirements Invalidated or Re-scoped

- None

## Deviations

None.

## Known Limitations

- EditorSizePanel requires the GSD CLI backend to render (settings panel is inside the command surface which only appears when the full app is running with `gsd --web`). `next dev` alone won't show it.
- Font size preference exists but nothing consumes it yet — S02 will wire it to CodeMirror and the file viewer.

## Follow-ups

- None — all planned work delivered. S02 consumes both POST endpoint and font size hook.

## Files Created/Modified

- `web/app/api/files/route.ts` — added `writeFileSync`/`dirname` imports and POST handler with full path validation
- `web/lib/use-editor-font-size.ts` — new file: useEditorFontSize() hook with localStorage persistence
- `web/components/gsd/settings-panels.tsx` — added EDITOR_SIZE_PRESETS constant and EditorSizePanel component
- `web/components/gsd/command-surface.tsx` — added EditorSizePanel import and render in gsd-prefs section

## Forward Intelligence

### What the next slice should know
- POST `/api/files` accepts `{ path, content, root }` where root is "gsd" or "project". The `?project=` query param identifies which project (same as GET). Call pattern: `fetch('/api/files?project=...', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content, root: 'project' }) })`.
- `useEditorFontSize()` returns `[fontSize, setFontSize]` — pass `fontSize` as the CodeMirror `fontSize` prop or use it in inline styles.
- The hook fires `editor-font-size-changed` CustomEvent on changes, so multiple components consuming it stay in sync without re-renders.

### What's fragile
- Nothing in S01 is fragile — both the POST handler and font size hook are straightforward patterns cloned from existing working code.

### Authoritative diagnostics
- `curl -v -X POST 'http://localhost:3000/api/files?project=...' -H 'Content-Type: application/json' -d '{"path":"test.txt","content":"hello","root":"project"}'` — verify POST handler status/response at any time
- `localStorage.getItem('gsd-editor-font-size')` in browser devtools — verify persistence

### What assumptions changed
- No assumptions changed — execution matched the plan exactly.
