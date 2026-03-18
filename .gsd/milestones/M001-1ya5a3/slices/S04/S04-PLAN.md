# S04: Tool Cards — The Art

**Goal:** Replace ToolStub placeholders with bespoke, collapsed/expandable tool cards that are the visual centerpiece of the app. Each card type renders tool-specific content with considered design.
**Demo:** Tool calls render as premium cards in the message stream. Edit cards show syntax-highlighted diffs with intra-line word-level highlighting. Bash cards show terminal-styled output with command header. Write cards show syntax-highlighted file content. Read cards show formatted code with line ranges. All cards collapse to a useful one-line summary and expand with smooth animation to full detail. Error states are visually distinct. The ToolStub is gone.

## Must-Haves

- Enhanced `ToolUseBlock` carrying structured `content` (text/image array), `details` (tool-specific metadata), `isError` boolean, and `partialResult` from `tool_execution_update` events
- `tool_execution_update` handled in `buildMessageBlocks()` for streaming partial results keyed by `toolCallId`
- Shared ToolCard shell with collapsed/expanded toggle, status indicator, and smooth `grid-template-rows: 0fr → 1fr` animation
- EditCard with custom diff parser (format: `+NNN content` / `-NNN content` / ` NNN content`), line coloring (red removed/green added), and intra-line word-level highlighting via `Diff.diffWords()`
- BashCard with terminal-styled monospace output, `$ command` header, truncated 5-line preview when collapsed
- WriteCard with syntax-highlighted file content via Shiki, path + line count header
- ReadCard with syntax-highlighted content, line range display, truncated preview
- SearchCard handling grep/find/ls with match highlighting and result counts
- GenericCard as defensive fallback for all unrecognized tool types (JSON-formatted args + text result)
- ToolCard dispatcher routing tool names to correct card components
- MessageStream rendering the dispatcher instead of ToolStub
- File extension → Shiki language ID utility map

## Proof Level

- This slice proves: contract (components type-check and build; visual quality deferred to UAT)
- Real runtime required: no (build + type-check verification; live rendering requires connected gsd-2)
- Human/UAT required: yes (visual quality is subjective — tool card design review deferred to UAT pass)

## Verification

- `npm run test -w studio` — all tests pass including 4+ new message-model tests for `tool_execution_update`, structured result extraction, `isError` flag, and backward-compat flat results
- `npx tsc --noEmit -p studio/tsconfig.web.json` — zero type errors across all new components
- `npm run build -w studio` — zero build errors, all card components bundled in output

## Observability / Diagnostics

- Runtime signals: `data-tool-name` and `data-tool-status` DOM attributes on each ToolCard for DevTools inspection
- Inspection surfaces: `buildMessageBlocks(useSessionStore.getState().events)` in DevTools console shows structured blocks with `content`, `details`, `isError`; React DevTools shows card component tree per tool type
- Failure visibility: ToolCard renders error status visually (red border, error text); GenericCard catches any unhandled tool type without crashing; EditCard falls back to args preview when `details.diff` is missing
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `session-store.ts` (events array, StoreEvent type), `message-model.ts` (ToolUseBlock type, buildMessageBlocks), `MessageStream.tsx` (BlockRenderer switch on block.type), `components.tsx` + `shiki-theme.ts` (Shiki/Streamdown reuse for code inside cards), `index.css` (theme tokens, new diff/terminal classes)
- New wiring introduced in this slice: ToolCard dispatcher replaces ToolStub in MessageStream's BlockRenderer; message-model enhanced to extract structured tool result data from `tool_execution_end` events
- What remains before the milestone is truly usable end-to-end: S05 (interactive prompt UI), S06 (file tree + Monaco editor), S07 (preview pane + final integration)

## Tasks

- [ ] **T01: Enhance message model, install diff, build ToolCard shell and language utility** `est:45m`
  - Why: Foundation — all card components depend on richer ToolUseBlock data, the shared ToolCard shell with expand/collapse, and the language detection utility. The `diff` library is needed for EditCard's intra-line highlighting.
  - Files: `studio/src/renderer/src/lib/message-model.ts`, `studio/test/message-model.test.mjs`, `studio/src/renderer/src/components/tool-cards/ToolCard.tsx`, `studio/src/renderer/src/lib/lang-map.ts`, `studio/src/renderer/src/styles/index.css`, `studio/package.json`
  - Do: Install `diff` + `@types/diff`. Enhance ToolUseBlock type with `content`, `details`, `isError`, `partialResult`. Add `tool_execution_update` case in buildMessageBlocks (accumulate partialResult keyed by toolCallId). Add `isError` extraction from tool_execution_end. Build ToolCard shell with `grid-template-rows: 0fr → 1fr` expand animation, status icon (reuse Phosphor pattern from ToolStub), `data-tool-name`/`data-tool-status` DOM attrs. Build getLanguageFromPath (20-line map: `.ts`→`typescript`, `.js`→`javascript`, `.py`→`python`, etc. using Shiki language IDs). Add CSS for diff lines (`.diff-added`/`.diff-removed`/`.diff-context` backgrounds). Update replicated test function (K001) and add 4+ new tests covering tool_execution_update, structured result, isError, backward compat.
  - Verify: `npm run test -w studio` passes, `npx tsc --noEmit -p studio/tsconfig.web.json` clean, `npm run build -w studio` clean
  - Done when: ToolUseBlock carries structured data, ToolCard shell renders with smooth expand/collapse, new tests pass, `diff` package installed

- [ ] **T02: Build Edit, Bash, and Write card components** `est:1h`
  - Why: These three tool types are ~80% of what users see. Edit is the highest-effort card (diff parsing + intra-line highlighting). Bash and Write are high-frequency. Building them together ensures consistent visual language.
  - Files: `studio/src/renderer/src/components/tool-cards/DiffView.tsx`, `studio/src/renderer/src/components/tool-cards/EditCard.tsx`, `studio/src/renderer/src/components/tool-cards/BashCard.tsx`, `studio/src/renderer/src/components/tool-cards/WriteCard.tsx`
  - Do: Build DiffView — parse the custom diff format (`+NNN content` / `-NNN content` / ` NNN content` with `---` hunk separators; first char determines line type). For 1:1 removed→added pairs, apply `Diff.diffWords()` for intra-line highlighting (highlight changed tokens with stronger bg). Red bg for removed lines, green bg for added lines, neutral for context. Build EditCard — collapsed shows path + `:firstChangedLine` + diff summary ("+N -M lines"); expanded shows DiffView. Args: `path`, `oldText`, `newText`. Result details: `diff` string, `firstChangedLine`. Build BashCard — collapsed shows `$ command` in monospace + first 5 lines of output; expanded shows all output. Terminal styling (bg-[#0c0c0c], monospace). Args: `command`, `timeout?`. Result content is text array. Build WriteCard — collapsed shows path + line count; expanded shows syntax-highlighted content via Streamdown (wrap in markdown fence using getLanguageFromPath, render through Streamdown with existing codePlugin). Args: `path`, `content`. All cards use ToolCard shell from T01. Handle running state (show args only, spinner), done state (full content), error state (red text).
  - Verify: `npx tsc --noEmit -p studio/tsconfig.web.json` clean, `npm run build -w studio` clean
  - Done when: EditCard renders diffs with line coloring and word-level intra-line highlights, BashCard shows terminal-styled output, WriteCard shows syntax-highlighted code, all type-check and build

- [ ] **T03: Build remaining cards, wire dispatcher into MessageStream, remove ToolStub** `est:45m`
  - Why: Completes type coverage and wires everything into the message stream — closing the integration loop.
  - Files: `studio/src/renderer/src/components/tool-cards/ReadCard.tsx`, `studio/src/renderer/src/components/tool-cards/SearchCard.tsx`, `studio/src/renderer/src/components/tool-cards/LspCard.tsx`, `studio/src/renderer/src/components/tool-cards/GenericCard.tsx`, `studio/src/renderer/src/components/tool-cards/index.tsx`, `studio/src/renderer/src/components/message-stream/MessageStream.tsx`
  - Do: Build ReadCard — collapsed shows path with `[offset:limit]` range + first ~10 highlighted lines; expanded shows full content via Streamdown. Args: `path`, `offset?`, `limit?`. Build SearchCard — handles grep (shows `/{pattern}/` + match count), find (shows pattern + result count), ls (shows path + entry count). Collapsed shows summary; expanded shows full output. Build LspCard — collapsed shows action name + file; expanded shows results text. Build GenericCard — defensive fallback for browser_*, subagent, mcp_call, etc. Collapsed shows tool name; expanded shows `JSON.stringify(args, null, 2)` + text result. Build `index.tsx` barrel with `ToolCardDispatcher` — maps toolName to component (edit→EditCard, bash→BashCard, write→WriteCard, read/Read→ReadCard, grep/find/ls→SearchCard, lsp→LspCard, default→GenericCard). Pass full ToolUseBlock. Update MessageStream BlockRenderer: replace `<ToolStub toolName={block.toolName} status={block.status} />` with `<ToolCardDispatcher block={block} />`. Remove ToolStub import. ToolStub file can remain (not imported) or be deleted.
  - Verify: `npm run test -w studio` all pass, `npx tsc --noEmit -p studio/tsconfig.web.json` clean, `npm run build -w studio` clean
  - Done when: All tool types have a card component, MessageStream renders ToolCardDispatcher instead of ToolStub, the ToolStub import is gone from MessageStream, all tests/types/build pass

## Files Likely Touched

- `studio/src/renderer/src/lib/message-model.ts`
- `studio/test/message-model.test.mjs`
- `studio/src/renderer/src/components/tool-cards/ToolCard.tsx`
- `studio/src/renderer/src/components/tool-cards/DiffView.tsx`
- `studio/src/renderer/src/components/tool-cards/EditCard.tsx`
- `studio/src/renderer/src/components/tool-cards/BashCard.tsx`
- `studio/src/renderer/src/components/tool-cards/WriteCard.tsx`
- `studio/src/renderer/src/components/tool-cards/ReadCard.tsx`
- `studio/src/renderer/src/components/tool-cards/SearchCard.tsx`
- `studio/src/renderer/src/components/tool-cards/LspCard.tsx`
- `studio/src/renderer/src/components/tool-cards/GenericCard.tsx`
- `studio/src/renderer/src/components/tool-cards/index.tsx`
- `studio/src/renderer/src/lib/lang-map.ts`
- `studio/src/renderer/src/styles/index.css`
- `studio/src/renderer/src/components/message-stream/MessageStream.tsx`
- `studio/package.json`
