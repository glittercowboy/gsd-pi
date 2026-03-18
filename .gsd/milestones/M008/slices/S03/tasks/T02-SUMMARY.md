---
id: T02
parent: S03
milestone: M008
provides:
  - 6 largest component files migrated from raw Tailwind accent colors to semantic design tokens (R115)
key_files:
  - web/components/gsd/visualizer-view.tsx
  - web/components/gsd/command-surface.tsx
  - web/components/gsd/remaining-command-panels.tsx
  - web/components/gsd/knowledge-captures-panel.tsx
  - web/components/gsd/diagnostics-panels.tsx
  - web/components/gsd/settings-panels.tsx
key_decisions:
  - none
patterns_established:
  - "Mechanical sed substitution pattern: `emerald-\\d+` → success, `amber-\\d+`/`orange-\\d+` → warning, `red-\\d+` → destructive, `sky-\\d+`/`blue-\\d+` → info, `green-\\d+` → success. All shade levels map to the same token. Opacity modifiers preserved as-is."
observability_surfaces:
  - "rg 'emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]' on any migrated file returns zero hits — regression detector"
  - "npm run build:web-host stderr surfaces any misspelled or undefined token class"
duration: 10m
verification_result: passed
completed_at: 2026-03-18
blocker_discovered: false
---

# T02: Migrate raw accent colors in the 6 largest component files

**Replaced 175 raw Tailwind accent color classes with semantic design tokens (`success`, `warning`, `destructive`, `info`) across 6 component files.**

## What Happened

Applied mechanical sed substitutions across 6 files containing the bulk (~175 instances) of raw Tailwind accent color usage:

| File | Instances migrated |
|---|---|
| `visualizer-view.tsx` | 53 |
| `command-surface.tsx` | 42 |
| `remaining-command-panels.tsx` | 25 |
| `knowledge-captures-panel.tsx` | 18 |
| `diagnostics-panels.tsx` | 25 |
| `settings-panels.tsx` | 12 |

Substitution rules applied:
- `emerald-\d+` / `green-\d+` → `success`
- `amber-\d+` / `orange-\d+` → `warning`
- `red-\d+` → `destructive`
- `sky-\d+` / `blue-\d+` → `info`

All shade levels (`-300`, `-400`, `-500`) mapped to the same token. Opacity modifiers (`/5`, `/15`, `/20`, etc.) preserved as-is. String literal prop values like `"emerald"` and `"sky"` (used as type union values and object keys) were NOT affected — the sed pattern requires a digit suffix.

## Verification

- `rg "emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]"` on all 6 files → **zero hits** ✅
- Combined verification rg exit code 1 (no matches) ✅
- Spot-checked semantic tokens: `text-success`, `bg-destructive/5`, `border-warning/20`, `from-info/8` all correctly formed ✅
- String literal prop values (`"emerald"`, `"sky"`, `"amber"`) preserved in type unions and object keys ✅

### Slice-level checks

- Slice check 1 (`defaultTheme="dark"`): ✅ passes
- Slice check 2 (raw accent colors = 0 across all components): 59 remaining in other files — expected, T03 scope
- Slice check 3 (production build): deferred to T03
- Slice check 4 (failure-path: build error surface for unresolved tokens): deferred to T03

## Diagnostics

- Run `rg "emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]" web/components/gsd/visualizer-view.tsx web/components/gsd/command-surface.tsx web/components/gsd/remaining-command-panels.tsx web/components/gsd/knowledge-captures-panel.tsx web/components/gsd/diagnostics-panels.tsx web/components/gsd/settings-panels.tsx` — should return zero hits. Any non-zero output indicates regression.
- If a semantic token class fails to resolve in the build, `npm run build:web-host` stderr names the offending utility.
- Visual color discrepancies after migration point to token definitions in `globals.css`, not component code.

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `web/components/gsd/visualizer-view.tsx` — Migrated 53 raw accent color instances to semantic tokens
- `web/components/gsd/command-surface.tsx` — Migrated 42 raw accent color instances to semantic tokens
- `web/components/gsd/remaining-command-panels.tsx` — Migrated 25 raw accent color instances to semantic tokens
- `web/components/gsd/knowledge-captures-panel.tsx` — Migrated 18 raw accent color instances to semantic tokens
- `web/components/gsd/diagnostics-panels.tsx` — Migrated 25 raw accent color instances to semantic tokens
- `web/components/gsd/settings-panels.tsx` — Migrated 12 raw accent color instances to semantic tokens
- `.gsd/milestones/M008/slices/S03/S03-PLAN.md` — Marked T02 done, added failure-path verification step
- `.gsd/milestones/M008/slices/S03/tasks/T02-PLAN.md` — Added Observability Impact section
