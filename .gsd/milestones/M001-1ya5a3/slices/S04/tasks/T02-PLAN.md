---
estimated_steps: 4
estimated_files: 4
---

# T02: Build Edit, Bash, and Write card components

**Slice:** S04 — Tool Cards — The Art
**Milestone:** M001-1ya5a3

## Description

Builds the three highest-frequency tool card components: EditCard (with full diff rendering and intra-line highlighting), BashCard (terminal-styled output), and WriteCard (syntax-highlighted file content). These cover ~80% of tool calls users see. Each card uses the ToolCard shell from T01 and handles running/done/error states.

**Relevant skills:** `frontend-design` (premium component styling), `make-interfaces-feel-better` (borders, spacing, typography details)

## Steps

1. **Build DiffView component.** Create `studio/src/renderer/src/components/tool-cards/DiffView.tsx`:
   - Props: `diff: string` (the custom diff format from edit-diff.ts).
   - Parse the diff string line-by-line. Format is: first character determines type (`+` = added, `-` = removed, ` ` = context). After the prefix, optional line number, then content. Pattern: `/^([+-\s])(\s*\d*)\s(.*)$/`.  Lines that don't match (like `---` hunk separators) render as separators.
   - For 1:1 removed→added line pairs (a single `-` line immediately followed by a single `+` line): apply `Diff.diffWords(removedContent, addedContent)` to get word-level diffs. Render changed tokens with stronger background (`bg-red-500/25` for removed tokens, `bg-emerald-500/25` for added tokens).
   - Line rendering: removed lines get `.diff-removed` class (from T01 CSS) + red text for line number + `-` prefix. Added lines get `.diff-added` class + green text. Context lines get `.diff-context` + muted text. All content in JetBrains Mono.
   - Line numbers displayed in a fixed-width gutter, right-aligned, `text-text-tertiary/50`.
   - Wrap in `overflow-x-auto` for long lines.

2. **Build EditCard component.** Create `studio/src/renderer/src/components/tool-cards/EditCard.tsx`:
   - Props: receives full `ToolUseBlock` from dispatcher.
   - Extract from block: `args.path` (file path), `args.oldText`, `args.newText`, `details?.diff` (diff string), `details?.firstChangedLine`.
   - Collapsed header: file path shortened (replace homedir with `~`) + `:firstChangedLine` if available + diff summary. Compute summary by counting `+`/`-` lines in the diff string: "+N -M lines". If no diff yet (running state), show "editing...".
   - Expanded content: render `<DiffView diff={details.diff} />` if diff is available. If diff is not available but `oldText`/`newText` are (running state or missing details), show the args as a preview: "Old text → New text" in monospace.
   - Error state: show error text from `content` (first text block) in red.
   - Use ToolCard shell with `toolName="edit"`.

3. **Build BashCard component.** Create `studio/src/renderer/src/components/tool-cards/BashCard.tsx`:
   - Props: receives full `ToolUseBlock`.
   - Extract: `args.command`, `args.timeout`, text output from `content` array (join all `type:'text'` entries) or fall back to `result` as string. Extract `details?.truncation`, `details?.fullOutputPath`.
   - Collapsed header: `$ command` in monospace, truncated to one line with `truncate` class. Below header (still in collapsed): first 5 lines of output in monospace `text-text-tertiary`, or "Running..." if no result yet.
   - Expanded content: full output in monospace. Use `bg-[#0c0c0c]` terminal background, `text-[13px]` monospace, `p-4 rounded-[8px]`. Show truncation warning if `details.truncation?.truncated`.
   - Error state: show error output in `text-red-400`.
   - Use ToolCard shell with `toolName="bash"`.

4. **Build WriteCard component.** Create `studio/src/renderer/src/components/tool-cards/WriteCard.tsx`:
   - Props: receives full `ToolUseBlock`.
   - Extract: `args.path`, `args.content` (the file content written).
   - Collapsed header: file path + line count (count `\n` in content).
   - Expanded content: syntax-highlighted code. Approach: wrap `args.content` in a markdown code fence (` ```{lang}\n{content}\n``` `) where lang comes from `getLanguageFromPath(args.path)`, then render through `<Streamdown>` with the existing `codePlugin` and `components`. This reuses all existing Shiki infrastructure without needing a separate `codeToHtml` call.
   - Running state: show "Writing..." with the path.
   - Error state: show error text in red.
   - Use ToolCard shell with `toolName="write"`.
   - Import `Streamdown` from `streamdown/react`, `codePlugin` from `../markdown/shiki-theme`, and `components` from `../markdown/components`.

## Must-Haves

- [ ] DiffView parses custom diff format and renders line-level coloring with red/green backgrounds
- [ ] DiffView applies `Diff.diffWords()` for intra-line highlighting on 1:1 removed/added pairs
- [ ] EditCard shows path + diff summary collapsed, full DiffView expanded
- [ ] BashCard shows `$ command` + 5-line preview collapsed, full terminal output expanded
- [ ] WriteCard shows path + line count collapsed, syntax-highlighted content expanded via Streamdown
- [ ] All three cards handle running/done/error states
- [ ] All components use ToolCard shell from T01

## Verification

- `npx tsc --noEmit -p studio/tsconfig.web.json` — zero type errors
- `npm run build -w studio` — zero build errors

## Inputs

- `studio/src/renderer/src/components/tool-cards/ToolCard.tsx` — shared shell from T01
- `studio/src/renderer/src/lib/lang-map.ts` — getLanguageFromPath from T01
- `studio/src/renderer/src/lib/message-model.ts` — enhanced ToolUseBlock type from T01
- `studio/src/renderer/src/components/markdown/shiki-theme.ts` — codePlugin for Shiki highlighting
- `studio/src/renderer/src/components/markdown/components.tsx` — component overrides for Streamdown
- `packages/pi-coding-agent/src/modes/interactive/components/diff.ts` — **REFERENCE ONLY** (do not import). Shows the diff format parsing pattern and intra-line diff approach using `Diff.diffWords()`. The custom diff format uses `+NNN content` / `-NNN content` / ` NNN content` lines with `---` separating hunks.
- `packages/pi-coding-agent/src/modes/interactive/components/tool-execution.ts` — **REFERENCE ONLY**. Shows the TUI's collapsed/expanded rendering decisions per tool type (line counts for preview, what metadata to display, truncation behavior).

## Expected Output

- `studio/src/renderer/src/components/tool-cards/DiffView.tsx` — diff parser + renderer with intra-line highlighting
- `studio/src/renderer/src/components/tool-cards/EditCard.tsx` — edit tool card with diff summary/preview
- `studio/src/renderer/src/components/tool-cards/BashCard.tsx` — bash tool card with terminal output styling
- `studio/src/renderer/src/components/tool-cards/WriteCard.tsx` — write tool card with syntax-highlighted content
