# M009: Editor & File Viewer Upgrade

**Gathered:** 2026-03-18
**Status:** Ready for planning

## Project Description

Transform the read-only file content viewer into a full code editor with a view/edit tab split. Shiki stays for the View tab (zero style changes to current rendering). CodeMirror 6 powers the Edit tab with a custom theme derived from the existing oklch CSS design tokens. Markdown files get react-markdown rendering in the View tab and raw editing in the Edit tab. File saves go through a new POST /api/files endpoint with path validation. Editor font size is configurable from settings.

## Why This Milestone

The web workspace is feature-complete for GSD workflow operations, but the file viewer is strictly read-only. Users who spot a typo, want to tweak a config, or need to edit a markdown artifact must leave the browser and open a separate editor. Adding editing capabilities makes the web workspace self-sufficient for code changes without requiring external tools.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Open any file in the file viewer and switch between a View tab (current shiki/markdown rendering, unchanged) and an Edit tab (CodeMirror with syntax highlighting)
- Edit code in the CodeMirror editor with full editing features: multi-cursor, copy/paste, undo/redo, syntax highlighting
- Save changes via an explicit Save button that writes to disk through the POST /api/files endpoint
- Open a markdown file and see it rendered with react-markdown in the View tab, or switch to Edit to modify the raw markdown
- Adjust the editor/viewer font size from settings, with the preference persisting across sessions
- See the Edit tab styling match the existing dark/light theme — no foreign or jarring color scheme

### Entry point / environment

- Entry point: `gsd --web` → Files view → click any file
- Environment: local dev / browser
- Live dependencies involved: none

## Completion Class

- Contract complete means: `npm run build:web-host` exits 0, POST /api/files returns 200 on valid write
- Integration complete means: Edit tab → Save → View tab reflects the saved changes for the same file
- Operational complete means: none

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- Open a .ts file → View tab shows shiki-highlighted code (unchanged from current) → switch to Edit → modify code → Save → switch to View → see the updated content
- Open a .md file → View tab shows react-markdown rendered output → switch to Edit → modify raw markdown → Save → switch to View → see the rendered update
- Font size preference applies to both View and Edit tabs
- `npm run build:web-host` exits 0

## Risks and Unknowns

- CodeMirror bundle size — @uiw/react-codemirror + language extensions could add significant weight to the client bundle. May need dynamic imports.
- Custom theme mapping from oklch design tokens to CodeMirror's `createTheme` API — need to extract CSS custom property values at runtime or compile a static mapping.
- POST /api/files security — path traversal prevention must be rigorous since this writes to the filesystem.

## Existing Codebase / Prior Art

- `web/components/gsd/file-content-viewer.tsx` — 364-line read-only viewer with shiki syntax highlighting and react-markdown for .md files. Uses lazy-loaded shiki (`getHighlighter()`) and dynamic `import("react-markdown")`.
- `web/app/api/files/route.ts` — GET-only route with `resolveSecurePath()` for path validation, `buildTree()` for directory listing, max 256KB file size.
- `web/components/gsd/files-view.tsx` — File tree browser that opens files in FileContentViewer.
- `web/lib/use-terminal-font-size.ts` — Existing pattern for localStorage-persisted font size with cross-component sync (M008). Editor font size should follow the same pattern.
- `web/app/globals.css` — oklch design tokens in `:root` and `.dark` blocks.
- `web/components/gsd/settings-panels.tsx` — TerminalSizePanel exists; EditorSizePanel should follow the same pattern.

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- R121 — File viewer/editor font size configurable from settings
- R122 — Full code editing via CodeMirror 6 with custom theme from design tokens
- R123 — Markdown files have View tab (react-markdown) and Edit tab (CodeMirror)
- R124 — POST /api/files writes file content with path validation

## Scope

### In Scope

- POST handler on /api/files for writing file content with same path security as GET
- View/Edit tab UI in file-content-viewer.tsx for all file types
- CodeMirror 6 integration via @uiw/react-codemirror with custom dark/light theme from existing design tokens
- Markdown View tab using react-markdown (current rendering), Edit tab using CodeMirror
- Code file View tab using shiki (current rendering), Edit tab using CodeMirror
- Editor font size settings panel with localStorage persistence
- Font size applying to both shiki viewer and CodeMirror editor
- Dirty state indicator and explicit Save button

### Out of Scope / Non-Goals

- Auto-save or debounced save
- File creation or deletion from the UI
- Git integration (staging, diffing edited files)
- IntelliSense, autocomplete, or LSP integration in the editor
- Changing the shiki View tab appearance in any way

## Technical Constraints

- Must use existing oklch CSS custom property system for CodeMirror theme
- Must use @uiw/react-codemirror (React wrapper for CodeMirror 6)
- CodeMirror and language extensions should be dynamically imported to avoid bloating the initial bundle
- POST /api/files must use the same `resolveSecurePath()` validation as GET
- Font size hook should follow `useTerminalFontSize` pattern (localStorage + custom event)

## Integration Points

- `web/app/api/files/route.ts` — extended with POST handler
- `web/components/gsd/file-content-viewer.tsx` — major refactor for tab split and editor
- `web/components/gsd/settings-panels.tsx` — new EditorSizePanel
- `web/lib/use-editor-font-size.ts` — new hook following useTerminalFontSize pattern
- `web/app/globals.css` — existing design tokens read for CodeMirror theme

## Open Questions

- Whether CodeMirror language detection should mirror the existing `EXT_TO_LANG` map in file-content-viewer or use CodeMirror's own language detection — agent's discretion, but consistency with existing map is preferred.
