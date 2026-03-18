# S03: Theme Defaults & Light Mode Color Audit

**Goal:** Dark mode is the default theme; every non-monochrome color in light mode uses semantic design tokens — verified by grep scan and production build.
**Demo:** Open the web app with no stored preference → dark mode renders. Run `rg "emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]" web/components/ -g "*.tsx" -g "*.ts"` → zero hits. `npm run build:web-host` exits 0.

## Must-Haves

- `defaultTheme="dark"` in ThemeProvider (layout.tsx)
- All 24 component files migrated from raw Tailwind accent classes to semantic CSS tokens
- Zero raw Tailwind accent color classes remain in `web/components/` — verified by grep
- `npm run build:web-host` exits 0 — confirms all token references resolve in Tailwind v4

## Verification

- `grep -c 'defaultTheme="dark"' web/app/layout.tsx` returns `1`
- `rg "emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]" web/components/ -g "*.tsx" -g "*.ts" | wc -l` returns `0`
- `npm run build:web-host` exits 0

## Tasks

- [x] **T01: Set default theme to dark** `est:10m`
  - Why: R114 — dark mode should be the default when no user preference is stored, not system preference
  - Files: `web/app/layout.tsx`
  - Do: Change `defaultTheme="system"` to `defaultTheme="dark"` on line 40. Remove `enableSystem` prop from the same ThemeProvider element.
  - Verify: `grep 'defaultTheme="dark"' web/app/layout.tsx` returns a match; `grep 'enableSystem' web/app/layout.tsx` returns nothing
  - Done when: layout.tsx has `defaultTheme="dark"` and no `enableSystem` prop

- [x] **T02: Migrate raw accent colors in the 6 largest component files** `est:1h`
  - Why: R115 — these 6 files contain ~320 of the ~420 raw accent color instances. Migrating them first eliminates the bulk of the inconsistency.
  - Files: `web/components/gsd/visualizer-view.tsx`, `web/components/gsd/command-surface.tsx`, `web/components/gsd/remaining-command-panels.tsx`, `web/components/gsd/knowledge-captures-panel.tsx`, `web/components/gsd/diagnostics-panels.tsx`, `web/components/gsd/settings-panels.tsx`
  - Do: In each file, apply the mechanical color substitution rules: `emerald-*` → `success`, `amber-*`/`orange-*` → `warning`, `red-*` → `destructive`, `sky-*`/`blue-*` → `info`, `green-*` → `success`. Include hover/group-hover/focus variants. Preserve opacity modifiers (e.g., `bg-emerald-500/20` → `bg-success/20`). Do NOT create shade variants — all `-300`/`-400`/`-500` map to the same token.
  - Verify: `rg "emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]" web/components/gsd/visualizer-view.tsx web/components/gsd/command-surface.tsx web/components/gsd/remaining-command-panels.tsx web/components/gsd/knowledge-captures-panel.tsx web/components/gsd/diagnostics-panels.tsx web/components/gsd/settings-panels.tsx` returns zero hits
  - Done when: All 6 files have zero raw Tailwind accent color classes

- [ ] **T03: Migrate remaining 18 files and verify full build** `est:45m`
  - Why: R115 — completes the color audit across all remaining files and proves the migration with a full grep scan and production build
  - Files: `web/components/gsd/chat-mode.tsx`, `web/components/gsd/projects-view.tsx`, `web/components/gsd/scope-badge.tsx`, `web/components/gsd/onboarding/step-ready.tsx`, `web/components/gsd/onboarding/step-optional.tsx`, `web/components/gsd/onboarding/step-authenticate.tsx`, `web/components/gsd/activity-view.tsx`, `web/components/gsd/update-banner.tsx`, `web/components/gsd/status-bar.tsx`, `web/components/gsd/sidebar.tsx`, `web/components/gsd/shell-terminal.tsx`, `web/components/gsd/roadmap.tsx`, `web/components/gsd/onboarding/step-dev-root.tsx`, `web/components/gsd/app-shell.tsx`, `web/components/ui/toast.tsx`, `web/components/gsd/terminal.tsx`, `web/components/gsd/onboarding/step-provider.tsx`, `web/components/gsd/file-content-viewer.tsx`
  - Do: Apply the same mechanical substitution rules as T02 to all 18 remaining files. After all files are migrated, run the full-repo grep scan to confirm zero remaining raw accent colors. Then run `npm run build:web-host` to confirm all semantic token classes resolve correctly in Tailwind v4.
  - Verify: `rg "emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]" web/components/ -g "*.tsx" -g "*.ts" | wc -l` returns `0`; `npm run build:web-host` exits 0
  - Done when: Zero raw accent colors in web/components/, production build passes

## Observability / Diagnostics

- **Theme default:** Inspect the rendered `<html>` element's `class` attribute in the browser — should contain `dark` when no stored preference exists. DevTools → Application → Local Storage → key `theme` shows the active preference (absent = default).
- **Color token resolution:** If a semantic token like `bg-success` fails to resolve, Tailwind v4 build logs will report the missing utility. `npm run build:web-host` stderr surfaces these.
- **Failure visibility:** A failed build from unresolved tokens produces a non-zero exit code and stderr output naming the offending class. Grep scan failures surface as non-zero match counts.

## Verification

- `grep -c 'defaultTheme="dark"' web/app/layout.tsx` returns `1`
- `rg "emerald-|amber-|red-[0-9]|sky-|orange-|green-[0-9]|blue-[0-9]" web/components/ -g "*.tsx" -g "*.ts" | wc -l` returns `0`
- `npm run build:web-host` exits 0
- Open browser with cleared localStorage → `document.documentElement.classList.contains('dark')` returns `true` (failure-path: if `light` class is present instead, ThemeProvider default is wrong)
- `npm run build:web-host 2>&1 | grep -i "error\|unknown utility"` returns empty — confirms no unresolved token references (failure-path: unresolved semantic tokens like `bg-success` produce stderr output naming the offending class and a non-zero exit code)

## Files Likely Touched

- `web/app/layout.tsx`
- `web/components/gsd/visualizer-view.tsx`
- `web/components/gsd/command-surface.tsx`
- `web/components/gsd/remaining-command-panels.tsx`
- `web/components/gsd/knowledge-captures-panel.tsx`
- `web/components/gsd/diagnostics-panels.tsx`
- `web/components/gsd/settings-panels.tsx`
- `web/components/gsd/chat-mode.tsx`
- `web/components/gsd/projects-view.tsx`
- `web/components/gsd/scope-badge.tsx`
- `web/components/gsd/onboarding/step-ready.tsx`
- `web/components/gsd/onboarding/step-optional.tsx`
- `web/components/gsd/onboarding/step-authenticate.tsx`
- `web/components/gsd/activity-view.tsx`
- `web/components/gsd/update-banner.tsx`
- `web/components/gsd/status-bar.tsx`
- `web/components/gsd/sidebar.tsx`
- `web/components/gsd/shell-terminal.tsx`
- `web/components/gsd/roadmap.tsx`
- `web/components/gsd/onboarding/step-dev-root.tsx`
- `web/components/gsd/app-shell.tsx`
- `web/components/ui/toast.tsx`
- `web/components/gsd/terminal.tsx`
- `web/components/gsd/onboarding/step-provider.tsx`
- `web/components/gsd/file-content-viewer.tsx`
