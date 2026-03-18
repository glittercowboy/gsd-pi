# M009: Editor & File Viewer Upgrade

**Vision:** Transform the read-only file viewer into a full code editor with view/edit tab split, CodeMirror 6 editing, explicit save, and configurable font size — while preserving the existing shiki/markdown rendering exactly as-is.

## Success Criteria

- Any file opened in the file viewer shows View and Edit tabs
- View tab renders identically to the current file viewer (shiki for code, react-markdown for .md)
- Edit tab uses CodeMirror 6 with syntax highlighting matching the existing theme
- Save button writes file content to disk via POST /api/files
- After saving, switching to View tab reflects the updated content
- Editor font size is configurable from settings and persists across sessions
- `npm run build:web-host` exits 0

## Key Risks / Unknowns

- CodeMirror bundle size could bloat the client — mitigate with dynamic imports
- Mapping oklch design tokens to CodeMirror's `createTheme` settings/styles API
- POST /api/files path traversal security — must be airtight since it writes to disk

## Proof Strategy

- Bundle size risk → retire in S02 by implementing dynamic imports and verifying production build size
- Theme mapping risk → retire in S02 by building the custom theme and visually comparing against existing shiki output
- Write security risk → retire in S01 by implementing `resolveSecurePath()` validation on POST (same as existing GET)

## Verification Classes

- Contract verification: `npm run build:web-host` exits 0, POST /api/files returns 200 for valid paths, 400 for traversal attempts
- Integration verification: Edit → Save → View round-trip shows updated content in browser
- Operational verification: none
- UAT / human verification: visual comparison of CodeMirror theme against shiki theme in both light/dark modes

## Milestone Definition of Done

This milestone is complete only when all are true:

- All 4 slice deliverables are complete
- POST /api/files writes files with path validation, rejects traversal
- View tab renders identically to current file viewer (shiki for code, react-markdown for markdown)
- Edit tab uses CodeMirror with theme derived from existing design tokens
- Edit → Save → View round-trip works end-to-end in browser
- Editor font size preference persists and applies to both tabs
- `npm run build:web-host` exits 0

## Requirement Coverage

- Covers: R121, R122, R123, R124
- Partially covers: none
- Leaves for later: R111, R112, R020, R125-R133
- Orphan risks: none

## Slices

- [ ] **S01: File Write API & Editor Font Size** `risk:low` `depends:[]`
  > After this: POST /api/files saves file content to disk with path validation; editor font size is configurable in settings and persists in localStorage.

- [ ] **S02: CodeMirror Integration & Code Editing** `risk:medium` `depends:[S01]`
  > After this: File content viewer has View/Edit tabs; Edit tab uses CodeMirror 6 with custom theme from design tokens; Save button writes via POST /api/files.

- [ ] **S03: Markdown View/Edit Split** `risk:low` `depends:[S02]`
  > After this: Markdown files show rendered react-markdown in View tab and raw CodeMirror editing in Edit tab; Save updates the rendered view.

- [ ] **S04: Final Polish & Verification** `risk:low` `depends:[S01,S02,S03]`
  > After this: All editor features verified end-to-end in browser; font size applies to all tabs; both dark and light themes look correct; build passes.

## Boundary Map

### S01 (File Write API & Editor Font Size)

Produces:
- POST handler on `/api/files` route — accepts `{ path, content, root }`, validates with `resolveSecurePath()`, writes with `writeFileSync`, returns `{ success: true }` or `{ error }` with 400/404/413 status
- `web/lib/use-editor-font-size.ts` — hook following `useTerminalFontSize` pattern (localStorage `gsd-editor-font-size`, custom event `editor-font-size-changed`, default 14, range 8-24)
- `EditorSizePanel` component in `settings-panels.tsx` with preset buttons (11-16) and live preview
- EditorSizePanel wired into `command-surface.tsx` settings section

Consumes:
- `resolveSecurePath()` from existing `/api/files/route.ts` GET handler
- `useTerminalFontSize` pattern from `web/lib/use-terminal-font-size.ts`
- Settings panel patterns from `settings-panels.tsx`

### S02 (CodeMirror Integration & Code Editing)

Produces:
- `web/components/gsd/code-editor.tsx` — CodeMirror 6 wrapper with `@uiw/react-codemirror`, custom dark/light themes via `createTheme`, dynamic language extension loading, fontSize prop, onChange callback
- View/Edit tab UI in `file-content-viewer.tsx` — Tabs component with View (existing shiki render) and Edit (CodeEditor), dirty state tracking, Save button
- Custom CodeMirror theme derived from globals.css oklch tokens — matching background, foreground, selection, gutter colors

Consumes from S01:
- POST `/api/files` for Save action
- `useEditorFontSize()` hook for font size

### S03 (Markdown View/Edit Split)

Produces:
- Markdown-specific View tab using react-markdown (existing rendering, unchanged)
- Markdown Edit tab using CodeMirror with `@codemirror/lang-markdown` extension
- Content refresh on save — after POST succeeds, View tab re-fetches and re-renders the markdown

Consumes from S02:
- CodeEditor component with language and theme support
- Tab UI and save infrastructure from file-content-viewer.tsx

### S04 (Final Polish & Verification)

Produces:
- End-to-end browser verification of all editor features
- Any fixes for visual issues found during theme comparison
- Build verification

Consumes from S01, S02, S03:
- All editor components and API endpoints
