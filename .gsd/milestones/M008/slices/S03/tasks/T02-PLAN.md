---
estimated_steps: 7
estimated_files: 6
---

# T02: Migrate raw accent colors in the 6 largest component files

**Slice:** S03 — Theme Defaults & Light Mode Color Audit
**Milestone:** M008

## Description

Migrate all raw Tailwind accent color classes to semantic CSS custom property tokens in the 6 highest-instance-count component files. These 6 files contain ~320 of the ~420 total raw accent color instances. The semantic token infrastructure already exists in `globals.css` — `--success`, `--warning`, `--info`, `--destructive` are defined in both `:root` and `.dark` blocks, and registered in `@theme inline` as `--color-success`, `--color-warning`, `--color-info`, `--color-destructive`. Classes like `text-success`, `bg-success/15`, `border-warning/20` work out of the box in Tailwind v4.

## Steps

1. **Migrate `web/components/gsd/visualizer-view.tsx` (~93 instances).** Apply these substitutions throughout the file:
   - `emerald-*` variants (`emerald-300`, `emerald-400`, `emerald-500`) → `success` (e.g., `text-emerald-400` → `text-success`, `bg-emerald-500/20` → `bg-success/20`)
   - `amber-*` variants → `warning`
   - `red-*` variants (with digit suffix like `red-400`, `red-500`) → `destructive`
   - `sky-*` variants → `info`
   - `blue-*` variants (with digit suffix) → `info`
   - `green-*` variants (with digit suffix) → `success`
   - `orange-*` variants → `warning`
   - Include all modifier prefixes: `hover:`, `group-hover:`, `focus:`, `dark:`, etc.
   - Preserve opacity modifiers: `bg-emerald-500/20` → `bg-success/20`, NOT `bg-success opacity-20`
   - All shade levels (`-300`, `-400`, `-500`) map to the SAME token — do NOT create `-light` variants
   - After editing, verify: `rg "emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]" web/components/gsd/visualizer-view.tsx` returns zero hits

2. **Migrate `web/components/gsd/command-surface.tsx` (~66 instances).** Same substitution rules. Verify zero hits after.

3. **Migrate `web/components/gsd/remaining-command-panels.tsx` (~55 instances).** Same rules. Verify zero hits after.

4. **Migrate `web/components/gsd/knowledge-captures-panel.tsx` (~42 instances).** Same rules. Verify zero hits after.

5. **Migrate `web/components/gsd/diagnostics-panels.tsx` (~41 instances).** Watch for the `animate-ping` pattern — `bg-emerald-500/20` → `bg-success/20` works fine with the animation. Verify zero hits after.

6. **Migrate `web/components/gsd/settings-panels.tsx` (~25 instances).** Same rules. Verify zero hits after.

7. Run combined verification: `rg "emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]" web/components/gsd/visualizer-view.tsx web/components/gsd/command-surface.tsx web/components/gsd/remaining-command-panels.tsx web/components/gsd/knowledge-captures-panel.tsx web/components/gsd/diagnostics-panels.tsx web/components/gsd/settings-panels.tsx` — must return zero hits.

## Must-Haves

- [ ] `visualizer-view.tsx` has zero raw Tailwind accent colors
- [ ] `command-surface.tsx` has zero raw Tailwind accent colors
- [ ] `remaining-command-panels.tsx` has zero raw Tailwind accent colors
- [ ] `knowledge-captures-panel.tsx` has zero raw Tailwind accent colors
- [ ] `diagnostics-panels.tsx` has zero raw Tailwind accent colors
- [ ] `settings-panels.tsx` has zero raw Tailwind accent colors

## Verification

- `rg "emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]" web/components/gsd/visualizer-view.tsx web/components/gsd/command-surface.tsx web/components/gsd/remaining-command-panels.tsx web/components/gsd/knowledge-captures-panel.tsx web/components/gsd/diagnostics-panels.tsx web/components/gsd/settings-panels.tsx` returns zero hits

## Observability Impact

- **Grep scan signal:** After this task, `rg "emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]" web/components/gsd/visualizer-view.tsx web/components/gsd/command-surface.tsx web/components/gsd/remaining-command-panels.tsx web/components/gsd/knowledge-captures-panel.tsx web/components/gsd/diagnostics-panels.tsx web/components/gsd/settings-panels.tsx` returns zero hits. Any future regressions (new raw colors introduced) surface as non-zero grep output.
- **Build failure surface:** If any migrated token class is misspelled or the token is undefined, `npm run build:web-host` fails with stderr naming the offending utility class. This catches typos like `text-sucess` immediately.
- **Visual inspection:** Semantic tokens resolve differently in `:root` (light) vs `.dark` blocks. If a color appears wrong visually after migration, the issue is in the token definition in `globals.css`, not in the component — narrowing the debugging surface.

## Inputs

- T01 completed (default theme change)
- `web/app/globals.css` — already defines `--success`, `--warning`, `--info`, `--destructive` tokens in both `:root` and `.dark`, registered in `@theme inline` as `--color-success`, `--color-warning`, `--color-info`, `--color-destructive`. No changes needed to this file.
- The 6 component files listed above — each currently uses raw Tailwind accent colors that need migration

## Expected Output

- `web/components/gsd/visualizer-view.tsx` — all accent colors use semantic tokens
- `web/components/gsd/command-surface.tsx` — all accent colors use semantic tokens
- `web/components/gsd/remaining-command-panels.tsx` — all accent colors use semantic tokens
- `web/components/gsd/knowledge-captures-panel.tsx` — all accent colors use semantic tokens
- `web/components/gsd/diagnostics-panels.tsx` — all accent colors use semantic tokens
- `web/components/gsd/settings-panels.tsx` — all accent colors use semantic tokens
