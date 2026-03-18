---
estimated_steps: 4
estimated_files: 7
---

# T03: Build remaining cards, wire dispatcher into MessageStream, remove ToolStub

**Slice:** S04 — Tool Cards — The Art
**Milestone:** M001-1ya5a3

## Description

Completes tool type coverage with ReadCard, SearchCard, LspCard, and GenericCard. Builds the ToolCardDispatcher barrel that routes tool names to card components. Wires the dispatcher into MessageStream replacing ToolStub — closing the integration loop for the entire slice.

**Relevant skills:** `frontend-design` (consistent card styling across types)

## Steps

1. **Build ReadCard component.** Create `studio/src/renderer/src/components/tool-cards/ReadCard.tsx`:
   - Props: receives full `ToolUseBlock`.
   - Extract: `args.path`, `args.offset`, `args.limit`, text content from `content` array or `result`. Extract `details?.truncation`.
   - Collapsed header: file path + line range if offset/limit present (e.g., `src/app.ts [10:50]`), or just path. Below: first ~10 lines of content syntax-highlighted via Streamdown (same approach as WriteCard — wrap in markdown fence with language from `getLanguageFromPath`).
   - Expanded content: full file content syntax-highlighted. Show truncation warning if `details.truncation?.truncated`.
   - Running state: show "Reading..." with path.
   - Error state: show error text in red.

2. **Build SearchCard, LspCard, and GenericCard.**

   **SearchCard** (`studio/src/renderer/src/components/tool-cards/SearchCard.tsx`):
   - Handles tools: `grep`, `find`, `ls`, `glob`.
   - Extract from args: `pattern` (grep/find), `path`, `glob`, `limit`. Text output from content/result.
   - Collapsed header varies: grep shows `/{pattern}/` in accent + ` in path`; find shows `pattern in path`; ls shows `ls path`. Count output lines for "N results/matches/entries".
   - Expanded: full output in monospace. Max ~20 lines when collapsed (if content available). Show truncation/limit warnings from `details`.
   - Error state: red text.

   **LspCard** (`studio/src/renderer/src/components/tool-cards/LspCard.tsx`):
   - Extract: `args.action`, `args.file`, other args vary by LSP action.
   - Collapsed header: action name (e.g., "definition", "references") + file path.
   - Expanded: full text result in monospace.
   - Minimal design — LSP results are usually short.

   **GenericCard** (`studio/src/renderer/src/components/tool-cards/GenericCard.tsx`):
   - Defensive fallback for any tool type not covered by specific cards (browser_*, subagent, mcp_call, secure_env_collect, etc.).
   - Collapsed header: formatted tool name only.
   - Expanded: `JSON.stringify(args, null, 2)` in a `<pre>` block with `text-[12px] text-text-secondary`, then text result below if present.
   - Must never crash — wrap content extraction in try/catch. If args is not serializable, show "(complex args)".

3. **Build ToolCardDispatcher barrel.** Create `studio/src/renderer/src/components/tool-cards/index.tsx`:
   - Export `ToolCardDispatcher` component. Props: `block: ToolUseBlock` (import type from message-model).
   - Map `block.toolName` to the correct card component:
     - `'edit'` → EditCard
     - `'bash'` → BashCard
     - `'write'` → WriteCard
     - `'read'` or `'Read'` → ReadCard
     - `'grep'`, `'find'`, `'ls'`, `'glob'` → SearchCard
     - `'lsp'` → LspCard
     - anything else → GenericCard
   - Pass the full `block` to the card component.
   - Re-export the `ToolUseBlock` type for convenience.

4. **Wire into MessageStream and remove ToolStub import.** In `studio/src/renderer/src/components/message-stream/MessageStream.tsx`:
   - Replace `import { ToolStub } from './ToolStub'` with `import { ToolCardDispatcher } from '../tool-cards'`.
   - In `BlockRenderer`, change the `'tool-use'` case from `<ToolStub toolName={block.toolName} status={block.status} />` to `<ToolCardDispatcher block={block} />`.
   - That's it — the dispatcher handles all routing internally.
   - ToolStub.tsx file can remain on disk (not imported) — no need to delete it; future cleanup can remove it.

## Must-Haves

- [ ] ReadCard renders file content with syntax highlighting and line range
- [ ] SearchCard handles grep/find/ls/glob with appropriate headers
- [ ] LspCard shows LSP action + file + results
- [ ] GenericCard renders any unknown tool type without crashing
- [ ] ToolCardDispatcher correctly routes all tool names to their card components
- [ ] MessageStream renders ToolCardDispatcher instead of ToolStub
- [ ] ToolStub is no longer imported by any active component

## Verification

- `npm run test -w studio` — all tests pass (existing + T01's new tests)
- `npx tsc --noEmit -p studio/tsconfig.web.json` — zero type errors
- `npm run build -w studio` — zero build errors
- `grep -r 'ToolStub' studio/src/renderer/src/components/message-stream/` returns no imports (only the ToolStub.tsx file itself if still on disk)

## Inputs

- `studio/src/renderer/src/components/tool-cards/ToolCard.tsx` — shared shell from T01
- `studio/src/renderer/src/components/tool-cards/EditCard.tsx` — from T02
- `studio/src/renderer/src/components/tool-cards/BashCard.tsx` — from T02
- `studio/src/renderer/src/components/tool-cards/WriteCard.tsx` — from T02
- `studio/src/renderer/src/lib/lang-map.ts` — getLanguageFromPath from T01
- `studio/src/renderer/src/lib/message-model.ts` — enhanced ToolUseBlock type from T01
- `studio/src/renderer/src/components/message-stream/MessageStream.tsx` — current BlockRenderer switch (replaces ToolStub with dispatcher)
- `studio/src/renderer/src/components/markdown/shiki-theme.ts` — codePlugin for ReadCard highlighting
- `studio/src/renderer/src/components/markdown/components.tsx` — component overrides for ReadCard Streamdown

## Expected Output

- `studio/src/renderer/src/components/tool-cards/ReadCard.tsx` — read tool card with syntax highlighting
- `studio/src/renderer/src/components/tool-cards/SearchCard.tsx` — search tool card for grep/find/ls
- `studio/src/renderer/src/components/tool-cards/LspCard.tsx` — LSP tool card
- `studio/src/renderer/src/components/tool-cards/GenericCard.tsx` — defensive fallback card
- `studio/src/renderer/src/components/tool-cards/index.tsx` — dispatcher barrel + exports
- `studio/src/renderer/src/components/message-stream/MessageStream.tsx` — updated to use ToolCardDispatcher
