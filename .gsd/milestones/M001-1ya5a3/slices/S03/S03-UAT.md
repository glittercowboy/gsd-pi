# S03: Message Stream + Markdown Rendering — UAT

**Milestone:** M001-1ya5a3
**Written:** 2026-03-18

## UAT Type

- UAT mode: mixed (artifact-driven for unit tests and build verification, live-runtime for streaming and visual quality)
- Why this mode is sufficient: The message model is pure logic testable without runtime. Markdown rendering quality, streaming smoothness, and visual design require a running Electron app with a connected gsd-2 backend.

## Preconditions

- `npm install` completed in the worktree
- `npm run build -w studio` succeeds with zero errors
- `npm run test -w studio` passes 34/34
- A gsd-2 installation is available on the system PATH (the app auto-spawns it)
- A project directory with source code exists to point the app at

## Smoke Test

Run `npm run dev -w studio`. The Electron window opens with the three-column layout. The center panel shows the empty state (Sparkle icon + "Start a conversation" text). Type a prompt in the composer and press Enter. Assistant text should stream in with styled markdown — not raw JSON.

## Test Cases

### 1. Message model unit tests pass

1. Run `npm run test -w studio`
2. **Expected:** 34/34 tests pass, including 12 message-model tests covering text accumulation, tool status transitions, K005 event type inconsistency, error states, idempotency, and non-renderable event filtering.

### 2. Build bundles Shiki WASM and streamdown CSS

1. Run `npm run build -w studio`
2. Check output for Shiki WASM chunk: `ls studio/dist/renderer/assets/wasm-*.js`
3. Check streamdown CSS keyframes: `grep sd-fadeIn studio/dist/renderer/assets/index-*.css`
4. **Expected:** Build succeeds with zero errors. WASM chunk exists (~622 kB). CSS contains sd-fadeIn and sd-blurIn keyframes.

### 3. Heading hierarchy renders correctly

1. Launch dev app: `npm run dev -w studio`
2. Send a prompt that produces headings: "Write a document with h1, h2, h3, and h4 headings explaining a topic"
3. **Expected:** h1 is largest (~1.75rem, semibold), h2 smaller (~1.5rem), h3 smaller still (~1.25rem), h4 smallest (~1.1rem). Each has proper spacing above. The hierarchy is visually distinct.

### 4. Code blocks render with Shiki syntax highlighting

1. Send a prompt: "Write a TypeScript function that fetches data from an API, a Python function that sorts a list, and a Bash script that deploys to a server"
2. **Expected:** Each code block renders with a dark background (`bg-[#0c0c0c]`), inset shadow, rounded corners (10px radius). Syntax tokens are colored (keywords, strings, types in different colors from the vitesse-dark theme). Language is auto-detected. Block code is visually distinct from inline code.

### 5. Inline code styling

1. Send a prompt that produces inline code: "Explain the difference between `useState` and `useReducer` in React"
2. **Expected:** Inline code like `useState` renders with a subtle background (`bg-bg-tertiary`), amber/accent text color, monospace font, and rounded corners. Visually distinct from block code and from surrounding text.

### 6. Tables render as styled tables

1. Send: "Create a comparison table of React state management libraries with columns for name, bundle size, learning curve, and community support"
2. **Expected:** Table renders with visible borders, header row has a distinct background color, cells have proper padding, text is left-aligned. Table is responsive and doesn't overflow the container.

### 7. Blockquotes, lists, and links

1. Send: "Explain three design patterns using blockquotes for key definitions, a numbered list of steps, and links to relevant documentation"
2. **Expected:** Blockquotes have an amber left border accent. Ordered and unordered lists have proper indentation and spacing. Links render in accent color with hover underline.

### 8. Streaming cursor appears and disappears

1. Send any prompt and watch the streaming response
2. **Expected:** A block caret appears at the end of the streaming text while the agent is generating. When generation completes, the caret disappears. Only the last assistant-text block shows the caret (not earlier blocks if the conversation has multiple turns).

### 9. User prompts render as styled blocks

1. Send a prompt
2. **Expected:** Your prompt appears in the conversation flow with a subtle amber left border, a "You" label in uppercase muted text above the body, and body text styled at 15px with proper line-height.

### 10. Tool events render as collapsed stubs

1. Send a prompt that triggers tool use (e.g., "Read the package.json file in this project")
2. **Expected:** Tool events appear as minimal stubs with: tool name in monospace (formatted from snake_case to Title Case, e.g., "Read" not "read"), a status icon (spinning for running, green check for done, red X for error), and a right-pointing chevron suggesting future expandability.

### 11. Auto-scroll follows streaming content

1. Send a long prompt that produces substantial output
2. Let it stream without touching the scroll
3. **Expected:** The view auto-scrolls to keep new content visible as it streams in.

### 12. Manual scroll-up is preserved

1. While content is streaming, scroll up manually
2. **Expected:** The scroll position stays where you scrolled. New content does NOT yank you back to the bottom. You can read earlier content undisturbed.
3. Scroll back to the bottom (within ~80px of the end)
4. **Expected:** Auto-scroll resumes following new content.

### 13. Empty state before first message

1. Launch the app fresh (or after clearing conversation)
2. **Expected:** Center panel shows a Sparkle icon and "Start a conversation" text. No blank screen.

## Edge Cases

### Multiple assistant turns separated by tool calls

1. Send a prompt that causes the agent to write text, use a tool, then write more text
2. **Expected:** Each segment of assistant text renders as its own AssistantBlock with proper markdown. Tool events appear between them as ToolStubs. The streaming caret only appears on the last/newest assistant block.

### Rapid tool execution burst

1. Send a prompt that triggers many tools in rapid succession (e.g., "Read all .ts files in src/")
2. **Expected:** Multiple ToolStubs appear in sequence without jank. Status icons transition correctly (running → done for each). No duplicate or missing stubs.

### Empty or malformed events

1. (Verified via unit test) Events without text content, events with empty content arrays, and non-renderable events (stderr, state_update, agent_end) are silently skipped.
2. **Expected:** No blank blocks or rendering errors in the message stream.

## Failure Signals

- Raw JSON appears in the center panel instead of styled markdown → MessageStream not wired or buildMessageBlocks failing
- Code blocks have no syntax coloring → Shiki WASM failed to load, check Electron DevTools console
- No streaming cursor during generation → check `isStreaming` in session store and `isLastBlock` prop on AssistantBlock
- Scroll jumps during streaming → auto-scroll useEffect triggering incorrectly, check isNearBottom threshold
- Tool stubs show raw snake_case names → formatToolName not applied
- Caret doesn't animate (appears static) → streamdown/styles.css not imported, check for sd-fadeIn in built CSS

## Not Proven By This UAT

- **Bespoke tool card rendering** — ToolStub is a placeholder. S04 proves the full card experience.
- **Interactive prompt UI** — extension_ui_request events are auto-responded by S02's auto-responder. S05 proves the real wizard UI.
- **Performance under extreme load** — testing covers typical usage. Virtual scrolling for 1000+ block conversations is a future concern.
- **Cross-platform rendering** — testing on macOS only. Electron should ensure consistency but Linux/Windows font rendering may differ.

## Notes for Tester

- The vitesse-dark Shiki theme is close to the app's dark palette but not pixel-perfect — some token colors may feel slightly off. This is acceptable; the theme can be refined later.
- ToolStub is intentionally minimal — it's a placeholder that S04 replaces. Don't judge tool rendering quality here.
- If gsd-2 is not installed, the app will show a connection error. Install gsd-2 first or verify the Composer sends prompts that trigger the auto-spawn.
- The streamdown caret animation is subtle (fade-in block caret). It's visible but not flashy — look carefully during streaming.
