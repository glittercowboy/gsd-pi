---
estimated_steps: 5
estimated_files: 6
---

# T01: Enhance message model, install diff, build ToolCard shell and language utility

**Slice:** S04 — Tool Cards — The Art
**Milestone:** M001-1ya5a3

## Description

Foundation task for all tool card rendering. Enhances the `ToolUseBlock` type in the message model to carry structured tool result data (`content`, `details`, `isError`, `partialResult`), adds handling for `tool_execution_update` events, builds the shared ToolCard shell component with smooth expand/collapse animation, creates a file-extension-to-Shiki-language-ID utility, and installs the `diff` library needed for EditCard's intra-line highlighting in T02.

**Relevant skills:** `frontend-design` (Tailwind component styling), `make-interfaces-feel-better` (expand animation, border radius, spacing)

## Steps

1. **Install diff package.** Run `npm install diff @types/diff -w studio`. This is used by T02's DiffView for `Diff.diffWords()` intra-line highlighting.

2. **Enhance ToolUseBlock type and buildMessageBlocks.** In `studio/src/renderer/src/lib/message-model.ts`:
   - Add fields to `ToolUseBlock`: `content?: Array<{type: string; text?: string; data?: string; mimeType?: string}>`, `details?: Record<string, unknown>`, `isError: boolean` (default `false`), `partialResult?: unknown`.
   - Add `tool_execution_update` case: look up the existing ToolUseBlock by `toolCallId`, set `partialResult = data.result ?? data.partial`.
   - In `tool_execution_end` handler: extract structured result — if `data.result` is an object with `content` array, set `block.content = result.content` and `block.details = result.details`. Otherwise keep `block.result = data.result ?? data.output` for backward compat. Set `block.isError` from `data.error === true || data.status === 'error' || result.isError === true`.
   - The `result` field (the raw blob) stays for backward compat — card components should prefer `content`/`details` when available.

3. **Update replicated test function and add new tests.** In `studio/test/message-model.test.mjs`:
   - Update the replicated `buildMessageBlocks` function (K001 pattern) to match the enhanced source — add `isError`, `content`, `details`, `partialResult` fields, `tool_execution_update` handler, structured result extraction.
   - Add test: `tool_execution_update accumulates partialResult on existing block` — tool_execution_start then tool_execution_update → block has `partialResult` set.
   - Add test: `tool_execution_end with structured result extracts content and details` — result is `{ content: [{type:'text',text:'hello'}], details: { diff: '...' }, isError: false }` → block has `.content`, `.details`, `.isError === false`.
   - Add test: `tool_execution_end with isError true → block.isError true` — error in result.
   - Add test: `tool_execution_end with plain result (backward compat) → block.result set` — result is a plain string → block has `.result` set, `.content` is undefined.

4. **Build getLanguageFromPath utility.** Create `studio/src/renderer/src/lib/lang-map.ts`:
   - Export `getLanguageFromPath(path: string): string` — extract file extension, map to Shiki language ID.
   - Map: `.ts`/`.tsx`→`typescript`, `.js`/`.jsx`→`javascript`, `.py`→`python`, `.rs`→`rust`, `.go`→`go`, `.rb`→`ruby`, `.java`→`java`, `.c`/`.h`→`c`, `.cpp`/`.hpp`→`cpp`, `.cs`→`csharp`, `.swift`→`swift`, `.kt`→`kotlin`, `.md`→`markdown`, `.json`→`json`, `.yaml`/`.yml`→`yaml`, `.toml`→`toml`, `.html`→`html`, `.css`→`css`, `.scss`→`scss`, `.sh`/`.bash`/`.zsh`→`bash`, `.sql`→`sql`, `.xml`→`xml`, `.graphql`→`graphql`, `.vue`→`vue`, `.svelte`→`svelte`, `.zig`→`zig`, `.lua`→`lua`, `.php`→`php`, `.dart`→`dart`.
   - Default: `'text'` (no highlighting).

5. **Build ToolCard shell component.** Create `studio/src/renderer/src/components/tool-cards/ToolCard.tsx`:
   - Props: `toolName: string`, `status: 'running' | 'done' | 'error'`, `headerContent: ReactNode` (the collapsed view), `children: ReactNode` (the expanded view), `defaultExpanded?: boolean`.
   - State: `isExpanded` (boolean, default `false` or `defaultExpanded`).
   - Layout: outer div with `data-tool-name={toolName}` and `data-tool-status={status}`. Border styling varies by status: `border-border/60` default, `border-red-500/30` for error. Background: `bg-bg-secondary/30`. Rounded: `rounded-[10px]`. Subtle transition on border color.
   - Header row: clickable, `cursor-pointer`. Contains StatusIcon (reuse the same pattern from ToolStub: `CircleNotch animate-spin` for running, `Check text-emerald-500/70` for done, `XCircle text-red-500/70` for error), `headerContent` slot, and `CaretRight` chevron that rotates 90° when expanded (`transition-transform duration-200`).
   - Expanded content: wrapped in a `div` with `grid` display, `grid-template-rows` transitioning between `0fr` and `1fr` over `300ms ease-out`. Inner div has `overflow: hidden`. The `children` slot renders inside.
   - Export the `formatToolName` function from ToolStub (or rewrite — it's 3 lines: replace `_` with space, capitalize words).
   - Add CSS to `studio/src/renderer/src/styles/index.css`: diff line backgrounds (`.diff-removed { background: rgba(239, 68, 68, 0.08); }`, `.diff-added { background: rgba(34, 197, 94, 0.08); }`, `.diff-context { background: transparent; }`), and the grid-rows expand transition utility if Tailwind v4 doesn't have it natively.

## Must-Haves

- [ ] `ToolUseBlock` has `content`, `details`, `isError`, `partialResult` fields
- [ ] `buildMessageBlocks` handles `tool_execution_update` events
- [ ] `buildMessageBlocks` extracts structured result (content/details/isError) from `tool_execution_end`
- [ ] 4+ new unit tests pass covering the above
- [ ] ToolCard shell renders with smooth expand/collapse animation
- [ ] `getLanguageFromPath` maps file extensions to Shiki language IDs
- [ ] `diff` and `@types/diff` installed in studio workspace

## Verification

- `npm run test -w studio` — all existing + 4 new tests pass
- `npx tsc --noEmit -p studio/tsconfig.web.json` — zero type errors
- `npm run build -w studio` — zero build errors

## Inputs

- `studio/src/renderer/src/lib/message-model.ts` — current ToolUseBlock type and buildMessageBlocks function
- `studio/test/message-model.test.mjs` — existing 12 tests with replicated logic (K001 pattern)
- `studio/src/renderer/src/components/message-stream/ToolStub.tsx` — StatusIcon pattern and formatToolName to reuse
- `studio/src/renderer/src/styles/index.css` — existing theme tokens and CSS vars
- S03 Summary: components.tsx has P<T> helper type pattern; Phosphor icons use named exports (CaretRight, Check, XCircle, CircleNotch)

## Expected Output

- `studio/package.json` — `diff` + `@types/diff` added to dependencies/devDependencies
- `studio/src/renderer/src/lib/message-model.ts` — enhanced ToolUseBlock type and buildMessageBlocks with tool_execution_update + structured result
- `studio/test/message-model.test.mjs` — updated replicated logic + 4 new tests
- `studio/src/renderer/src/components/tool-cards/ToolCard.tsx` — shared card shell with expand/collapse animation and status indicators
- `studio/src/renderer/src/lib/lang-map.ts` — file extension → Shiki language ID map
- `studio/src/renderer/src/styles/index.css` — diff line background classes added
