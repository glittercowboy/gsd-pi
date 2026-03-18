---
estimated_steps: 5
estimated_files: 3
---

# T02: Add View/Edit tabs to FileContentViewer and wire save from FilesView

**Slice:** S02 — CodeMirror Integration & Code Editing
**Milestone:** M009

## Description

Refactor `FileContentViewer` to show View/Edit tabs when editing props are provided. View tab preserves the existing shiki/markdown/plain renderers exactly as-is. Edit tab renders the `CodeEditor` component from T01. Add dirty state tracking and a Save button. Then update `files-view.tsx` to pass the new props and handle the save-then-refresh flow.

**Relevant skills:** `frontend-design` (for tab UI styling if needed).

## Steps

1. **Refactor `FileContentViewer` signature and tab UI:**
   - Add optional props: `root?: "gsd" | "project"`, `path?: string`, `onSave?: (newContent: string) => Promise<void>`
   - When all three optional props are provided, render using Radix `Tabs` / `TabsList` / `TabsTrigger` / `TabsContent` from `@/components/ui/tabs`
   - When any of the three is absent, render the current read-only view with no tabs (backward compatible for any other consumers)
   - Import `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` from `@/components/ui/tabs`
   - Default tab value: `"view"`
   - Tab triggers: "View" and "Edit"
   - View tab content: the existing rendering logic — `isMarkdown(filepath) ? <MarkdownViewer> : <CodeViewer>` with `<PlainViewer>` fallback. No changes whatsoever to these sub-components.
   - Edit tab content: `<CodeEditor>` from `@/components/gsd/code-editor` with `value`, `onChange`, `language` (from `detectLanguage(filepath)`), `fontSize` (from `useEditorFontSize()`)

2. **Add dirty state tracking:**
   - Track `editContent` state (initialized from `content` prop)
   - Track `isDirty` derived state: `editContent !== content`
   - When the `content` prop changes (file re-fetched), reset `editContent` to the new content
   - When user types in CodeMirror, update `editContent` via `onChange`

3. **Add Save button:**
   - Place in the tab bar area or adjacent header — a small "Save" button that appears/activates when `isDirty` is true
   - Disable when `!isDirty` or while saving
   - Track `isSaving` state for loading indicator
   - On click: call `onSave(editContent)`, then set `isSaving = false`
   - After successful save, `content` prop will update from parent (which re-fetches), resetting dirty state automatically
   - Use `Save` icon from lucide-react alongside text

4. **Update `files-view.tsx` to pass new props:**
   - Import `useEditorFontSize` is NOT needed here — it's consumed inside `FileContentViewer`
   - Add `onSave` callback that:
     1. POSTs to `/api/files` with `{ path: selectedPath, content: newContent, root: activeRoot }` — the fetch URL needs the project query param if the workspace state provides one (check how the existing GET fetch constructs its URL)
     2. On success (response.ok): re-fetch the file content by calling the existing `handleSelectFile(selectedPath)` or directly setting `fileContent` to the new content
     3. On failure: throw or surface the error (the FileContentViewer catch will handle it)
   - Pass to `<FileContentViewer>`: `root={activeRoot}`, `path={selectedPath}`, `onSave={handleSave}`
   - The existing `content={fileContent}` and `filepath={displayPath}` props stay

5. **Build verification:**
   - Run `npm run build:web-host` — must exit 0
   - Run `cd web && npx tsc --noEmit` — no new type errors

## Must-Haves

- [ ] FileContentViewer shows View/Edit tabs when `root`, `path`, and `onSave` are provided
- [ ] FileContentViewer renders read-only (no tabs) when those props are absent
- [ ] View tab renders identically to current output (zero changes to CodeViewer, MarkdownViewer, PlainViewer)
- [ ] Edit tab renders CodeEditor with syntax highlighting and correct font size
- [ ] Dirty state tracked — Save button activates only when content is modified
- [ ] Save button POSTs via `onSave` callback, View tab shows updated content after save
- [ ] `files-view.tsx` passes `root`, `path`, `onSave` to FileContentViewer
- [ ] `npm run build:web-host` exits 0

## Verification

- `npm run build:web-host` exits 0
- `cd web && npx tsc --noEmit` passes
- Open `files-view.tsx` and confirm `<FileContentViewer>` receives `root`, `path`, `onSave` props
- Confirm `FileContentViewer` conditional: tabs render when editing props present, read-only when absent

## Inputs

- `web/components/gsd/code-editor.tsx` — T01's `CodeEditor` component (props: `value`, `onChange`, `language`, `fontSize`, `className?`)
- `web/components/gsd/file-content-viewer.tsx` — current 365-line component with `CodeViewer`, `MarkdownViewer`, `PlainViewer` sub-components and `detectLanguage()` function
- `web/components/gsd/files-view.tsx` — parent component, currently passes `content` and `filepath` to `FileContentViewer`. Has `activeRoot` (RootMode), `selectedPath` (string | null), `fileContent` (string | null), `handleSelectFile` (async function)
- `web/components/ui/tabs.tsx` — Radix Tabs primitives (Tabs, TabsList, TabsTrigger, TabsContent)
- `web/lib/use-editor-font-size.ts` — S01's hook, returns `[fontSize, setFontSize]`
- S01 Forward Intelligence: POST `/api/files` call pattern: `fetch('/api/files?project=...', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content, root }) })`
- Note: the GET fetch in `files-view.tsx` does NOT currently use a `?project=` param — check if `resolveProjectCwd` in the API route gets project context from headers or cookies instead. If so, POST doesn't need it either. Verify by reading the existing GET fetch call pattern in `files-view.tsx`.

## Expected Output

- `web/components/gsd/file-content-viewer.tsx` — refactored with View/Edit tabs, dirty state, Save button
- `web/components/gsd/files-view.tsx` — passes `root`, `path`, `onSave` props to FileContentViewer
- Production build passes

## Observability Impact

- **New tab UI state:** Active tab ("view" | "edit") is visible via Radix `data-state="active"` attribute on `TabsTrigger` elements. Agents can verify which tab is active via `browser_find` with `[data-state=active]`.
- **Dirty state indicator:** Save button renders with `disabled` attribute when content is unmodified or during save. Agents can check `button:has-text("Save"):not([disabled])` to confirm dirty detection works.
- **Save error surfacing:** Save failures display an inline error message near the Save button with the error text from the API response. Visible in DOM as a `text-destructive` element. Network tab shows the POST request with 4xx/5xx status and `{ error }` JSON body.
- **Save loading state:** During save, the Save button shows a `Loader2` spinner icon and is disabled. The `isSaving` state prevents double-submission.
- **Content sync:** After successful save, the parent re-fetches via GET → `content` prop updates → `editContent` resets → `isDirty` becomes false → Save button disables. If this cycle breaks, the Save button stays enabled after save (visible diagnostic).
