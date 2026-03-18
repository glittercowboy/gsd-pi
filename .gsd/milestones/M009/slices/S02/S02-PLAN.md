# S02: CodeMirror Integration & Code Editing

**Goal:** File content viewer has View/Edit tabs; Edit tab uses CodeMirror 6 with custom theme from design tokens; Save button writes via POST /api/files.
**Demo:** Open any `.ts` file in the file viewer → see View and Edit tabs → click Edit → CodeMirror editor appears with syntax highlighting → modify code → Save button activates → click Save → switch to View → see updated content. Works in both dark and light modes.

## Must-Haves

- CodeMirror 6 editor loads via dynamic import (no initial bundle bloat)
- Custom dark/light CodeMirror themes built from oklch design tokens in globals.css
- View tab renders identically to current file viewer (shiki for code — zero changes to CodeViewer/MarkdownViewer/PlainViewer)
- Edit tab shows CodeMirror with syntax highlighting for all supported languages
- Dirty state indicator when content is modified, cleared after save
- Save button POSTs to `/api/files` endpoint (from S01) and refreshes View tab content
- `useEditorFontSize()` font size applied to CodeMirror editor
- Backward compatible — FileContentViewer renders read-only (no tabs) when new props are absent
- `npm run build:web-host` exits 0

## Proof Level

- This slice proves: integration
- Real runtime required: yes (browser verification of CodeMirror rendering, save round-trip)
- Human/UAT required: yes (visual theme comparison deferred to S04, but basic rendering verified here)

## Verification

- `npm run build:web-host` exits 0
- Browser: open a `.ts`/`.tsx` file → View tab shows shiki-highlighted code (unchanged) → click Edit → CodeMirror editor appears with syntax highlighting → modify content → Save button becomes active → Save → switch to View → updated content visible
- Browser: verify CodeMirror renders in both dark and light modes with matching theme
- Browser: verify editor font size from `useEditorFontSize()` applies to CodeMirror

## Observability / Diagnostics

- **CodeMirror load failures:** If the dynamic import of CodeMirror fails (network error, bundling issue), the `next/dynamic` loading fallback stays visible (Loader2 spinner). Browser console will show the import error. No silent failure — the editor area either renders CodeMirror or shows the spinner indefinitely, making the failure visible.
- **Language extension failures:** If `loadLanguage()` returns null for a supported language, the editor falls back to plain-text mode silently. The `CM_LANG_MAP` mapping is inspectable in `code-editor.tsx`. Future agents can verify language support by checking which extensions map to null.
- **Save failures:** POST `/api/files` returns structured JSON `{ error: string }` on failure. The UI should surface save errors visibly (not silently swallow them). Network tab shows the POST status code.
- **Theme mismatch:** If `useTheme()` returns an unexpected value, the editor defaults to dark theme. Visual inspection in browser confirms theme alignment.
- **Diagnostic commands:** `npm run build:web-host` catches bundling/SSR issues. `npx tsc --noEmit` catches type errors. Browser DevTools console shows runtime import or extension errors.

## Verification (extended)

In addition to the verification items above:
- Browser console: no errors during CodeMirror load or language switching
- Browser: if CodeMirror dynamic import fails, a loading spinner remains visible (no blank/broken state)
- Browser: POST `/api/files` with invalid path returns structured `{ error }` JSON — save error is surfaced inline near the Save button, not silently swallowed
- Browser network tab: failed saves show 4xx status codes with readable error messages in response body

## Integration Closure

- Upstream surfaces consumed: POST `/api/files` (S01), `useEditorFontSize()` (S01), Radix Tabs (`web/components/ui/tabs.tsx`), `useTheme` from `next-themes`
- New wiring introduced in this slice: `code-editor.tsx` component, View/Edit tab UI in `file-content-viewer.tsx`, new props (`root`, `path`, `onSave`) passed from `files-view.tsx`
- What remains before the milestone is truly usable end-to-end: S03 (markdown-specific View/Edit), S04 (final polish and visual verification)

## Tasks

- [x] **T01: Install CodeMirror packages and build CodeEditor component** `est:1h`
  - Why: CodeMirror packages are not yet in the project — must be installed and build-verified before any component code. Then the standalone CodeEditor wrapper encapsulates all CodeMirror concerns (theme, language, font size, dynamic import) so T02 can integrate it cleanly.
  - Files: `web/package.json`, `web/components/gsd/code-editor.tsx`
  - Do: Install `@uiw/react-codemirror`, `@uiw/codemirror-themes`, `@lezer/highlight`, `@uiw/codemirror-extensions-langs`. Verify `npm run build:web-host` passes. Then build `code-editor.tsx` with: dynamic import of CodeMirror (ssr: false), two static theme objects (dark/light) via `createTheme` using oklch values from globals.css, `loadLanguage()` for syntax highlighting with shiki-to-CM name mapping, fontSize prop consumed from `useEditorFontSize`, onChange callback. Verify build passes again.
  - Verify: `npm run build:web-host` exits 0 after package install and after component creation
  - Done when: `code-editor.tsx` exports a working `CodeEditor` component and production build passes

- [x] **T02: Add View/Edit tabs to FileContentViewer and wire save from FilesView** `est:1h`
  - Why: This is the user-facing integration — adding the tab UI, dirty state tracking, Save button, and wiring the parent component to provide the new props.
  - Files: `web/components/gsd/file-content-viewer.tsx`, `web/components/gsd/files-view.tsx`
  - Do: Refactor `FileContentViewer` to accept optional `root`, `path`, `onSave` props. When present, render Radix Tabs (View/Edit). View tab = existing CodeViewer/MarkdownViewer/PlainViewer (unchanged). Edit tab = CodeEditor component. Track dirty state (content !== original). Show Save button when dirty. Save calls `onSave(newContent)`. When props absent, render current read-only view (backward compatible). Update `files-view.tsx` to pass `root={activeRoot}`, `path={selectedPath}`, and an `onSave` callback that POSTs to `/api/files` and re-fetches content on success.
  - Verify: `npm run build:web-host` exits 0. Browser: View/Edit tabs appear, edit → save → view round-trip works.
  - Done when: File viewer shows View/Edit tabs, CodeMirror editor works in Edit tab, Save writes to disk and View tab reflects changes

## Files Likely Touched

- `web/package.json` (new dependencies)
- `web/components/gsd/code-editor.tsx` (new file)
- `web/components/gsd/file-content-viewer.tsx` (View/Edit tab refactor)
- `web/components/gsd/files-view.tsx` (pass new props, add onSave callback)
