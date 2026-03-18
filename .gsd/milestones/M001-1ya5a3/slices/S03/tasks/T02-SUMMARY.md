---
id: T02
parent: S03
milestone: M001-1ya5a3
provides:
  - AssistantBlock component wrapping Streamdown with Shiki code highlighting and block caret
  - Full set of custom markdown component overrides styled to the dark amber design system
  - Shiki code plugin configured with vitesse-dark theme for both light/dark slots
  - MessageStream updated to render AssistantBlock with isLastBlock-aware caret logic
key_files:
  - studio/src/renderer/src/components/message-stream/AssistantBlock.tsx
  - studio/src/renderer/src/components/markdown/components.tsx
  - studio/src/renderer/src/components/markdown/shiki-theme.ts
  - studio/src/renderer/src/components/message-stream/MessageStream.tsx
key_decisions:
  - Used ComponentPropsWithoutRef<T> & ExtraProps helper type instead of JSX.IntrinsicElements to avoid namespace issues with react-jsx tsconfig
  - Code plugin themes set to ['vitesse-dark', 'vitesse-dark'] — app is dark-only so both slots use same theme
  - isLastBlock computed via backward scan in useMemo — only the final assistant-text block shows the streaming caret
patterns_established:
  - Markdown component overrides use a P<T> helper type for consistent prop typing with ExtraProps destructuring
  - AssistantBlock is the single composition point for Streamdown + plugins + components — no Streamdown usage elsewhere
observability_surfaces:
  - Shiki WASM load failure falls back to unstyled <pre> — visible immediately in UI, console errors in Electron DevTools
  - Inspect AssistantBlock props (isAnimating, content) via React DevTools component tree
  - isAnimating = useSessionStore.isStreaming && isLastBlock — check both signals if caret misbehaves
duration: 10m
verification_result: passed
completed_at: 2026-03-18
blocker_discovered: false
---

# T02: Integrate Streamdown with Shiki highlighting and custom markdown components

**Replace plain <pre> assistant text with Streamdown markdown rendering, Shiki syntax highlighting, and 20+ custom component overrides styled to the dark amber design system**

## What Happened

Created three new files and updated MessageStream to compose them:

1. **shiki-theme.ts** — Configures `createCodePlugin` from `@streamdown/code` with `vitesse-dark` for both theme slots. The app is dark-only so both light/dark slots use the same theme.

2. **components.tsx** — Exports a `Components` object with overrides for all markdown elements: h1-h6 with proper size hierarchy (1.75rem → 1rem, semibold/medium weights), paragraphs at 15px/leading-7 with `text-wrap: pretty`, inline code with `bg-bg-tertiary` + amber `text-accent`, code blocks with `bg-[#0c0c0c]` + inset shadow + 10px border radius, tables with header bg and border styling, blockquotes with accent left border, lists with proper indent/spacing, links with accent color + hover underline, and hr/strong/em formatting. Used a `P<T>` helper type (`ComponentPropsWithoutRef<T> & ExtraProps`) to avoid the `JSX` namespace issue with `react-jsx` tsconfig.

3. **AssistantBlock.tsx** — Wraps `<Streamdown>` with the code plugin, component overrides, `caret="block"`, and `isAnimating` bound to `isStreaming && isLastBlock`. Only the final assistant-text block shows the streaming cursor.

4. **MessageStream.tsx** — Replaced the inline `AssistantTextBlock` component with imported `AssistantBlock`. Added `lastAssistantIdx` computation via backward scan in `useMemo` to determine which block gets `isLastBlock={true}`. BlockRenderer now passes `isLastAssistant` to each block.

## Verification

- `npm run test -w studio` — 34/34 pass (all existing tests, no regressions)
- `npm run build -w studio` — zero errors, 5264 modules transformed including Shiki WASM (622 kB), vitesse-dark theme (13.79 kB)
- `npx tsc --noEmit -p studio/tsconfig.web.json` — zero type errors
- Root-level `npm run test` fails on pre-existing unrelated issues (missing `packages/pi-ai/dist/index.js` in worktree) — not caused by this task

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npm run test -w studio` | 0 | ✅ pass | 169ms |
| 2 | `npm run build -w studio` | 0 | ✅ pass | 2.04s |
| 3 | `npx tsc --noEmit -p studio/tsconfig.web.json` | 0 | ✅ pass | ~2s |
| 4 | `npm run test` (root) | 1 | ⚠️ pre-existing failures | ~5s |

## Diagnostics

- Inspect AssistantBlock rendering: React DevTools → find `AssistantBlock` component → check `isAnimating`, `content` props
- Shiki WASM loading: if code blocks render without syntax colors, check Electron DevTools console for Shiki errors — the WASM is loaded lazily by `@streamdown/code`
- Component override inspection: all overrides are in `components.tsx` as a single flat object — inspect via React DevTools under the Streamdown internal tree
- If streaming caret doesn't appear: verify `useSessionStore.isStreaming` is true during active generation, and that the block is the last `assistant-text` block in the array

## Deviations

- Used `ComponentPropsWithoutRef<T> & ExtraProps` instead of `JSX.IntrinsicElements[T] & ExtraProps` — the `react-jsx` tsconfig doesn't expose the global `JSX` namespace, causing TS2503 errors. The helper type is functionally equivalent.
- Added Observability Impact section to T02-PLAN.md as flagged by pre-flight check.

## Known Issues

- Root-level `npm run test` fails due to missing `packages/pi-ai/dist/index.js` in the worktree — pre-existing issue unrelated to studio workspace changes. The verification gate command `npm run test` (without `-w studio`) will fail for this reason.

## Files Created/Modified

- `studio/src/renderer/src/components/markdown/shiki-theme.ts` — Shiki code plugin configured with vitesse-dark theme
- `studio/src/renderer/src/components/markdown/components.tsx` — 20+ custom Streamdown component overrides for all markdown elements
- `studio/src/renderer/src/components/message-stream/AssistantBlock.tsx` — Streamdown wrapper with code plugin, components, and streaming caret
- `studio/src/renderer/src/components/message-stream/MessageStream.tsx` — updated to use AssistantBlock with isLastBlock tracking
- `.gsd/milestones/M001-1ya5a3/slices/S03/tasks/T02-PLAN.md` — added Observability Impact section
