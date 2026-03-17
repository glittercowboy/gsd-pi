# M007: Chat Mode — Consumer-Grade GSD Interface

**Vision:** A consumer-grade chat interface over the existing GSD PTY sessions — styled chat bubbles with markdown rendering, native UI for TUI prompts, one-click action buttons that spawn auto-closing side panels. Non-technical users get full GSD capability without ever seeing a raw terminal.

## Success Criteria

- New "Chat" nav entry appears below Power Mode in the sidebar and is reachable by click
- Main GSD session renders as a live chat conversation with user messages and AI responses as styled bubbles
- AI response markdown (headers, bold, lists, code blocks, tables) renders correctly in assistant bubbles
- TUI select prompts render as clickable native option lists; selecting sends correct arrow + Enter keystrokes to PTY and GSD advances
- TUI text and password inputs render as native input fields; submitting sends text + Enter to PTY and GSD advances
- Action toolbar buttons reflect live workspace state (disabled when appropriate)
- Clicking an action button opens a right-panel chat with distinct visual treatment
- Right panel auto-closes approximately 1.5s after GSD action completes
- No orphaned PTY sessions after panel close/navigation away

## Key Risks / Unknowns

- PTY output parsing — GSD output arrives as raw ANSI bytes with cursor moves, overwrites, and ink rendering; segmenting into coherent chat messages requires heuristics that must be validated against real GSD output
- TUI prompt detection — ink select/text/password prompt patterns must be reliably identified from stripped output; misdetection corrupts the session

## Proof Strategy

- PTY parsing risk → retire in S01 by shipping a real parser that feeds from the live SSE stream and produces clean ChatMessage[] visible in the running chat view
- TUI prompt risk → retire in S03 by verifying that select and password prompts send correct keystrokes and GSD visibly advances in its session

## Verification Classes

- Contract verification: TypeScript compiles clean (`npm run build:web-host`), parser exports all required types
- Integration verification: Live PTY session renders as chat in browser, TUI prompts intercepted and forwarded correctly, panel lifecycle clean across open/close cycles
- Operational verification: No session leaks; panel auto-close triggers after real GSD action completion
- UAT / human verification: Visual inspection — chat bubbles readable, markdown rendered, panel animations smooth

## Milestone Definition of Done

This milestone is complete only when all are true:

- Chat Mode view is reachable from the sidebar nav (below Power Mode)
- Main pane renders live GSD output as chat bubbles with styled markdown
- TUI select and text/password prompts render as native UI and correctly forward input to PTY
- Action buttons reflect live workspace state (disabled when appropriate)
- Right panel opens on action button click and auto-closes on GSD action completion
- `npm run build:web-host` exits 0 with no new TypeScript errors
- No regressions in Power Mode, Dashboard, or other existing views
- No orphaned PTY sessions after panel lifecycle

## Requirement Coverage

- Covers: R113 (consumer-grade chat interface over PTY sessions)
- Partially covers: R001–R004 (additive UX layer over existing bridge infrastructure)
- Leaves for later: none — self-contained new view
- Orphan risks: none

## Slices

- [x] **S01: PTY output parser and chat message model** `risk:high` `depends:[]`
  > After this: `web/lib/pty-chat-parser.ts` ships with `PtyChatParser`, `ChatMessage`, `TuiPrompt`, and `CompletionSignal` — the parser connects to a live GSD SSE stream, ANSI-strips output, segments it into role-classified messages, detects ink TUI prompts, and emits completion signals. Verified by feeding live SSE output and inspecting the resulting message array.

- [ ] **S02: Chat Mode view — main pane** `risk:medium` `depends:[S01]`
  > After this: "Chat" appears in the sidebar nav below Power Mode. Clicking it shows the live main GSD session rendered as a chat conversation — scrolling bubbles, assistant responses with styled markdown, user inputs as outgoing bubbles, text input bar at the bottom.

- [ ] **S03: TUI prompt intercept UI** `risk:medium` `depends:[S02]`
  > After this: When GSD presents an arrow-key select list or a text/password input prompt, the chat view renders native UI components instead of raw escape sequences. Submitting via the native UI sends correct keystrokes to the PTY and GSD visibly advances.

- [ ] **S04: Action toolbar and right panel lifecycle** `risk:low` `depends:[S02,S03]`
  > After this: Chat Mode header has state-aware workflow buttons. Clicking an action button spawns a right-panel chat with distinct styling. The panel auto-closes ~1.5s after GSD signals completion. Panel open/close animates with the motion library. No session leaks.

## Boundary Map

### S01 → S02, S03, S04

Produces:
- `web/lib/pty-chat-parser.ts` — stateful `PtyChatParser` class
  - `feed(chunk: string): void` — accepts raw PTY bytes (ANSI included)
  - `getMessages(): ChatMessage[]` — returns current message array (ANSI stripped)
  - `onMessage(cb: (msg: ChatMessage) => void): () => void` — subscribe; returns unsubscribe
  - `onCompletionSignal(cb: (sig: CompletionSignal) => void): () => void` — subscribe to action-complete events
  - `ChatMessage`: `{ id: string; role: 'user' | 'assistant' | 'system'; content: string; prompt?: TuiPrompt; timestamp: number; complete: boolean }`
  - `TuiPrompt`: `{ kind: 'select' | 'text' | 'password'; label: string; options?: string[]; selectedIndex?: number }`
  - `CompletionSignal`: `{ source: string; timestamp: number }`

Consumes:
- nothing (leaf node — reads raw PTY SSE output as string input)

### S02 → S03, S04

Produces:
- `web/components/gsd/chat-mode.tsx` — `ChatMode`, `ChatPane`, `ChatBubble`, `ChatMessageList`, `ChatInputBar` components
  - `ChatPane` props: `{ sessionId: string; command?: string; initialCommand?: string; onCompletionSignal?: () => void; className?: string }`
  - `ChatPane` exposes `sendInput(data: string)` which POSTs to `/api/terminal/input`
  - `ChatBubble` renders `ChatMessage` — assistant with react-markdown, user as plain outgoing, system as muted inline
- Sidebar nav entry: `{ id: "chat", label: "Chat", icon: MessagesSquare }` after `power`
- app-shell: `"chat"` in KNOWN_VIEWS, ChatMode mounted when `activeView === "chat"`

Consumes from S01:
- `PtyChatParser`, `ChatMessage`, `TuiPrompt`

### S03 → S04

Produces:
- `TuiSelectPrompt`: renders options as clickable list; sends `\x1b[A`/`\x1b[B` delta + `\r` to PTY on selection
- `TuiTextPrompt`: labeled text input; sends text + `\r` to PTY on submit
- `TuiPasswordPrompt`: masked input; sends text + `\r` to PTY on submit; value never displayed
- All wired into `ChatBubble` dispatch on `message.prompt?.kind`

Consumes from S02:
- `ChatPane` prompt rendering slot, `onSubmit` callback chain

### S04 → (milestone complete)

Produces:
- `ChatModeHeader` with workflow action toolbar (mirrors Power Mode action bar via `deriveWorkflowAction`)
- `ActionPanelConfig`: `{ label: string; command: string; sessionId: string; accentColor: string }`
- `ActionPanel`: wraps `ChatPane` for a secondary PTY session; distinct header with accentColor; X close button; auto-close on `CompletionSignal` + 1500ms delay
- Panel lifecycle in `ChatMode`: `actionPanelState: ActionPanelConfig | null`; `openPanel()` generates fresh sessionId; `closePanel()` DELETEs session

Consumes from S02:
- `ChatPane` (used for both main pane and action panel)

Consumes from S03:
- TUI prompt components (active inside action panel's `ChatPane`)

Consumes from S01:
- `CompletionSignal` (triggers panel auto-close)
