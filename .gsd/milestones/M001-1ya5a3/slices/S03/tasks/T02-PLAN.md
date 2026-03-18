---
estimated_steps: 4
estimated_files: 4
---

# T02: Integrate Streamdown with Shiki highlighting and custom markdown components

**Slice:** S03 — Message Stream + Markdown Rendering
**Milestone:** M001-1ya5a3

## Description

Replace the plain `<pre>` text rendering from T01 with Streamdown-powered markdown rendering. Create custom component overrides for all markdown elements styled to the dark amber design system. Configure the Shiki code highlighting plugin with a dark theme. Build AssistantBlock as the wrapper that composes Streamdown with plugins, components, and streaming props. This is the visual core of S03 — after this task, code blocks highlight, tables render beautifully, and headings have proper hierarchy.

**Relevant skills:** `vercel-react-best-practices`, `make-interfaces-feel-better` (typography/spacing details)

## Steps

1. **Create `studio/src/renderer/src/components/markdown/shiki-theme.ts`.** Configure the Shiki code plugin:
   ```ts
   import { createCodePlugin } from '@streamdown/code'
   
   export const codePlugin = createCodePlugin({
     themes: ['vitesse-dark', 'vitesse-dark'],  // both light/dark slots use the same dark theme
   })
   ```
   `vitesse-dark` is the closest match to the app's dark amber palette. The theme colors will be supplemented by container styling in the component overrides. If `vitesse-dark` isn't available or looks wrong at runtime, fall back to `one-dark-pro`.

2. **Create `studio/src/renderer/src/components/markdown/components.tsx`.** Export a `Components` object for Streamdown's `components` prop. Every override uses Tailwind classes matching the dark amber design system. Key design decisions:
   - **Headings (h1-h6):** `text-text-primary`, decreasing font sizes using the theme scale. h1: `text-[1.75rem] font-semibold`, h2: `text-[1.375rem] font-semibold`, h3: `text-[1.125rem] font-medium`, h4-h6: `text-[1rem] font-medium`. Bottom margin for spacing. No top margin on first-child.
   - **Paragraphs (p):** `text-[15px] leading-7 text-text-primary mb-4`. The `text-body` scale (0.9375rem = 15px).
   - **Inline code:** `bg-bg-tertiary text-accent rounded px-1.5 py-0.5 text-[13px] font-mono`. Amber-tinted to make it pop against body text.
   - **Code blocks (pre):** `bg-[#0c0c0c] border border-border rounded-[10px] p-4 overflow-x-auto my-4`. The inner code block gets Shiki styling from the plugin. Add subtle inset shadow for depth.
   - **Tables (table/th/td):** Wrapped in `overflow-x-auto`. `table`: `w-full text-[14px]`. `th`: `text-left px-4 py-2.5 font-medium text-text-secondary border-b border-border bg-bg-secondary/50`. `td`: `px-4 py-2.5 border-b border-border/50`.
   - **Blockquotes:** `border-l-2 border-accent/40 pl-4 text-text-secondary italic my-4`.
   - **Lists (ul/ol/li):** `ul`: `list-disc pl-6 my-3 space-y-1`. `ol`: `list-decimal pl-6 my-3 space-y-1`. `li`: `text-[15px] leading-7 text-text-primary`.
   - **Links (a):** `text-accent hover:text-accent-hover underline-offset-2 hover:underline transition-colors`.
   - **Horizontal rule (hr):** `border-border my-8`.
   - **Strong/em:** `strong`: `font-semibold text-text-primary`. `em`: `italic`.
   - Import types from `streamdown` (`Components`, `ExtraProps`) for type safety.

3. **Create `studio/src/renderer/src/components/message-stream/AssistantBlock.tsx`.** The component that wraps Streamdown:
   ```tsx
   import { Streamdown } from 'streamdown'
   import { codePlugin } from '../markdown/shiki-theme'
   import { components } from '../markdown/components'
   import { useSessionStore } from '@/stores/session-store'
   
   type Props = { content: string; isLastBlock: boolean }
   
   export function AssistantBlock({ content, isLastBlock }: Props) {
     const isStreaming = useSessionStore((s) => s.isStreaming)
     
     return (
       <div className="prose-container">
         <Streamdown
           plugins={{ code: codePlugin }}
           components={components}
           caret="block"
           isAnimating={isStreaming && isLastBlock}
         >
           {content}
         </Streamdown>
       </div>
     )
   }
   ```
   Key details:
   - `isAnimating` is only true for the last assistant block AND when streaming is active — prevents stale carets on older messages.
   - `isLastBlock` prop is passed from MessageStream based on the block's position in the sequence.
   - The `prose-container` wrapper div gets any needed spacing/max-width classes.

4. **Update `studio/src/renderer/src/components/message-stream/MessageStream.tsx`.** Replace the plain `<pre>` rendering for assistant-text blocks with `<AssistantBlock>`:
   - Import `AssistantBlock`.
   - In the block rendering switch, for `assistant-text` blocks: `<AssistantBlock key={block.id} content={block.content} isLastBlock={isLast} />`.
   - Determine `isLast` by checking if this is the final assistant-text block in the array.
   - Keep tool-use and user-prompt blocks as simple placeholders (T03 replaces them).

## Must-Haves

- [ ] All markdown elements have custom styled components matching the dark amber design system
- [ ] Code blocks render with Shiki syntax highlighting via @streamdown/code plugin
- [ ] Streaming cursor (block caret) appears on the last assistant block during streaming
- [ ] Inline code visually distinct from code blocks (bg-bg-tertiary + accent color vs full code block)
- [ ] Tables render as styled tables, not raw pipe characters
- [ ] Headings have proper size hierarchy (h1 > h2 > h3)
- [ ] `npm run build -w studio` passes — confirms Shiki WASM bundles correctly in Electron/Vite

## Verification

- `npm run build -w studio` — zero errors (critical: proves Shiki WASM bundles in Electron renderer)
- Dev app: send a prompt that produces a code block → Shiki highlights syntax with correct colors
- Dev app: send a prompt with a markdown table → renders as a styled HTML table with borders and padding
- Dev app: send a prompt with headings → h1 > h2 > h3 size hierarchy visible
- Dev app: inline `code` renders differently from fenced code blocks (different bg, smaller, inline)
- Dev app: block caret appears at the end of streaming text and disappears when streaming ends

## Inputs

- `studio/src/renderer/src/lib/message-model.ts` — MessageBlock types (from T01)
- `studio/src/renderer/src/components/message-stream/MessageStream.tsx` — container to update (from T01)
- `studio/src/renderer/src/styles/index.css` — design tokens (colors, fonts) for reference
- `studio/package.json` — streamdown + @streamdown/code already installed (by T01)
- Streamdown API: `<Streamdown plugins={{ code }} components={components} caret="block" isAnimating={bool}>{content}</Streamdown>`
- `createCodePlugin({ themes: ['theme1', 'theme2'] })` from `@streamdown/code` for custom theme selection

## Expected Output

- `studio/src/renderer/src/components/message-stream/AssistantBlock.tsx` — Streamdown wrapper with code plugin, custom components, streaming caret
- `studio/src/renderer/src/components/markdown/components.tsx` — full set of custom component overrides for all markdown elements
- `studio/src/renderer/src/components/markdown/shiki-theme.ts` — code plugin configured with vitesse-dark theme
- `studio/src/renderer/src/components/message-stream/MessageStream.tsx` — updated to render AssistantBlock

## Observability Impact

- **Shiki WASM load failure:** If Shiki fails to load (WASM bundle missing or corrupted), code blocks fall back to unstyled `<pre>` elements — immediately visible in the UI. Console errors from `@streamdown/code` surface in Electron DevTools.
- **Component override inspection:** All custom markdown components are plain React components with Tailwind classes — inspect via React DevTools component tree under `AssistantBlock > Streamdown`.
- **Streaming caret state:** `isAnimating` prop is derived from `useSessionStore.isStreaming && isLastBlock`. If the caret doesn't appear/disappear correctly, check these two signals in React DevTools props on the Streamdown component.
- **No new runtime signals added.** This task is pure rendering — no side effects, no new store state, no async operations beyond Shiki's lazy WASM loading.
