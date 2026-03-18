# M001-1ya5a3: GSD Studio MVP

**Vision:** A premium local desktop coding agent GUI for gsd-2 — dark monochrome + warm amber, Linear/Vercel design quality, continuous document-flow messages, bespoke tool cards that are art, wizard-style interactive prompts, Monaco editor, file tree, and localhost preview pane.

## Success Criteria

- User can launch the app, point it at a project, and converse with gsd-2 through a premium GUI
- Agent text streams in real-time with beautiful typography, syntax-highlighted code blocks, and proper markdown tables
- Tool calls render as bespoke collapsed/expandable cards with diffs, code previews, and terminal output
- Interactive prompts (ask_user_questions) render as inline wizard components with option cards, notes, and recommended highlighting
- File tree sidebar shows the project structure and opens files in the Monaco editor
- Localhost preview pane displays the running app the agent builds
- The entire experience feels like Linear or Vercel — not a hackathon prototype

## Key Risks / Unknowns

- **Streaming + highlighting performance** — High-frequency deltas + Shiki syntax highlighting in the render loop could cause jank
- **Tool card design surface** — Many tool types, each needs bespoke treatment. Large design effort.
- **Extension UI recreation** — The ask_user_questions interaction model is rich and needs faithful, beautiful recreation in React
- **Electron IPC bridge** — Clean separation between main process (gsd-2 management) and renderer (React app)

## Proof Strategy

- Streaming performance → retire in S03 by proving smooth delta rendering with Shiki highlighting on real agent output
- Tool card diversity → retire in S04 by proving bespoke cards for all major tool types on real agent sessions
- Extension UI complexity → retire in S05 by proving the full ask_user_questions interaction works through the GUI
- Electron IPC → retire in S02 by proving end-to-end event streaming from gsd-2 subprocess to React renderer

## Verification Classes

- Contract verification: Component renders match expected designs, RPC protocol handles all event types correctly
- Integration verification: Full round-trip — prompt → gsd-2 → events → UI rendering → file tree update → editor open
- Operational verification: gsd-2 process crash recovery, reconnection, conversation state preservation
- UAT / human verification: Visual design quality assessment — does it feel premium? Tool card review. Typography review.

## Milestone Definition of Done

This milestone is complete only when all are true:

- All seven slice deliverables are complete and styled
- The design system is cohesive across all components — no visual inconsistencies
- Tool cards are beautiful in both collapsed and expanded states for all major tool types
- Interactive prompts work as premium wizard-style components with full interaction model
- File tree, editor, and preview pane are wired to real gsd-2 output
- A real end-to-end session works: prompt → agent executes → tool cards stream → files appear → editor shows them → preview loads the app
- Visual quality passes human UAT — it genuinely feels like Linear/Vercel, not a prototype

## Requirement Coverage

- Covers: R001, R002, R003, R004, R005, R006, R007, R008, R009, R010, R011, R012
- Partially covers: none
- Leaves for later: R013, R014, R015, R016
- Orphan risks: none

## Slices

- [x] **S01: Electron Shell + Design System Foundation** `risk:high` `depends:[]`
  > After this: App launches as a native desktop window with the three-column resizable layout, dark theme, amber accent, Inter + JetBrains Mono loaded, Phosphor icons rendering. Panels show placeholder content.

- [x] **S02: gsd-2 RPC Connection + Event Stream** `risk:high` `depends:[S01]`
  > After this: App spawns gsd-2, connects via JSON-RPC. Raw events stream into the center panel as formatted output — proof the pipe works end-to-end.

- [x] **S03: Message Stream + Markdown Rendering** `risk:high` `depends:[S02]`
  > After this: Agent text streams in real-time with beautiful typography — headings, code blocks with Shiki syntax highlighting, tables, inline code, lists. Continuous document flow.

- [ ] **S04: Tool Cards — The Art** `risk:high` `depends:[S03]`
  > After this: Tool calls render as bespoke collapsed/expandable cards. Edit cards show syntax-highlighted diffs. Read cards show formatted code previews. Bash cards show styled terminal output. Write cards show the created file. Each card is a design piece.

- [ ] **S05: Interactive Prompt UI — Wizards** `risk:high` `depends:[S03]`
  > After this: Extension UI requests (select, confirm, input, editor) render as premium inline wizard components. Full ask_user_questions interaction with option cards, tab-to-add-notes, recommended highlighting.

- [ ] **S06: File Tree + Monaco Editor** `risk:medium` `depends:[S01,S02]`
  > After this: Left sidebar shows the project file tree. Clicking a file opens it in a custom-themed Monaco editor. JetBrains Mono, dark theme matching the app.

- [ ] **S07: Preview Pane + Final Integration** `risk:medium` `depends:[S06,S04,S05]`
  > After this: Right panel has editor/preview tab toggle. Full end-to-end: send prompt, watch tool cards, see files in tree, open in editor, preview running app in iframe. Final polish pass.

## Boundary Map

### S01 → S02
Produces:
- `electron/main.ts` — Electron main process with window creation and preload config
- `electron/preload.ts` — contextBridge API exposing IPC channels to renderer
- `src/App.tsx` — Root React component with three-column layout
- `src/components/layout/` — ResizablePanel, Sidebar, CenterPanel, RightPanel components
- `src/lib/theme/` — Tailwind config, CSS variables, design tokens (colors, typography scale, spacing)
- `src/components/ui/` — Core primitives: Button, Text, Icon wrapper for Phosphor

Consumes: nothing (first slice)

### S02 → S03
Produces:
- `electron/gsd-service.ts` — gsd-2 subprocess manager in main process (spawn, restart, event forwarding)
- `src/lib/rpc/` — Renderer-side RPC bridge: event listener hooks, command sender, connection state
- `src/stores/session-store.ts` — Zustand store: connection status, raw events, message accumulator
- IPC channels: `gsd:event`, `gsd:send-command`, `gsd:spawn`, `gsd:status`

Consumes from S01:
- Electron main/preload/contextBridge architecture
- Layout panels (center panel receives event stream)

### S03 → S04
Produces:
- `src/components/message-stream/` — MessageStream container, MessageBlock component
- `src/components/markdown/` — MarkdownRenderer with Shiki code blocks, tables, inline code
- `src/lib/streaming/` — Delta accumulator, RAF-batched render updates, markdown parse pipeline
- Shiki highlighter instance (shared, pre-loaded themes + languages)

Consumes from S02:
- `session-store.ts` — message_update events, accumulated text
- RPC event stream

### S04 → S05
Produces:
- `src/components/tool-cards/` — ToolCard shell, collapsed/expanded states, expand animation
- `src/components/tool-cards/EditCard.tsx` — Diff viewer with syntax highlighting
- `src/components/tool-cards/ReadCard.tsx` — Code preview with line numbers
- `src/components/tool-cards/BashCard.tsx` — Terminal-styled output
- `src/components/tool-cards/WriteCard.tsx` — Created file preview
- `src/components/tool-cards/SearchCard.tsx` — Search results with match highlighting
- `src/components/tool-cards/GenericCard.tsx` — Fallback for uncovered tool types
- `src/lib/tool-parser.ts` — Tool event → card data transformer

Consumes from S03:
- MessageStream (tool cards are rendered inline in the message flow)
- MarkdownRenderer (reused inside card content)
- Shiki highlighter instance

### S05 → S07
Produces:
- `src/components/prompts/` — SelectPrompt, ConfirmPrompt, InputPrompt, EditorPrompt
- `src/components/prompts/OptionCard.tsx` — Individual option with radio/checkbox, description, recommended badge
- `src/components/prompts/NotesField.tsx` — Tab-to-expand notes textarea
- `src/components/prompts/PromptWizard.tsx` — Multi-question wrapper with tab navigation
- `src/lib/extension-ui-handler.ts` — Routes extension_ui_request events to prompt components, sends responses back

Consumes from S03:
- MessageStream (prompts are rendered inline in the conversation flow)
- Design system components

Consumes from S02:
- RPC bridge (sends extension_ui_response back to gsd-2)

### S06 → S07
Produces:
- `src/components/file-tree/` — FileTree, FileTreeNode, directory expand/collapse
- `src/components/editor/` — MonacoEditor wrapper with custom theme, language detection
- `src/stores/file-store.ts` — Zustand store: file tree state, open files, active file
- `src/lib/file-watcher.ts` — Electron-side file watching, IPC to renderer for tree refresh

Consumes from S01:
- Layout panels (left sidebar for tree, right panel for editor)

Consumes from S02:
- IPC channels (file watching runs in main process)

### S07 (final integration)
Produces:
- `src/components/preview/` — PreviewPane with iframe, URL bar, reload button
- `src/components/layout/RightPanel.tsx` — Updated with editor/preview tab toggle
- Final integration wiring: tool card file links → editor open, bash server detection → preview URL
- Polish pass: transitions, loading states, empty states, error states

Consumes from S04:
- Tool cards (file links in cards trigger editor open)

Consumes from S05:
- Interactive prompts (full wizard flow works end-to-end)

Consumes from S06:
- File tree + Monaco editor (clicking files, opening modified files)
