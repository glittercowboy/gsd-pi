---
estimated_steps: 3
estimated_files: 1
---

# T01: Add progress bar color interpolation to dashboard

**Slice:** S05 — Progress Bar Dynamics & Terminal Text Size
**Milestone:** M008

## Description

The dashboard progress bar currently uses `bg-foreground` (monochrome) for all completion percentages. This task adds an oklch color interpolation function that transitions the bar from red (0%) through yellow (~50%) to green (100%), making progress visually intuitive at a glance. This directly satisfies R116.

## Steps

1. Open `web/components/gsd/dashboard.tsx`. The progress bar is around line 387–392 — a `div` with `className="h-full rounded-full bg-foreground transition-all duration-500"` and `style={{ width: '${progressPercent}%' }}`. The `progressPercent` variable is computed around line 142.

2. Write a `getProgressColor(percent: number): string` function (can be defined at the top of the file or just above the progress bar JSX) that:
   - Takes a 0–100 percentage value
   - Returns an `oklch(L C H)` color string
   - Interpolates **hue** linearly: 25 (red/destructive) at 0% → 85 (yellow/warning) at 50% → 145 (green/success) at 100%
   - Uses lightness ~0.65 and chroma ~0.18 as reasonable defaults that work in both light and dark themes (check `web/app/globals.css` for reference — the existing `--destructive`, `--warning`, `--success` tokens use oklch with similar ranges)
   - Clamps percent to 0–100

3. Update the progress bar div:
   - Remove `bg-foreground` from the className
   - Add `backgroundColor: getProgressColor(progressPercent)` to the existing inline style object (merge with the existing width style)
   - Keep `transition-all duration-500` in className for smooth color transitions

## Must-Haves

- [ ] `getProgressColor()` returns oklch color string interpolating hue 25→85→145 across 0→50→100%
- [ ] `bg-foreground` removed from progress bar div className
- [ ] Progress bar uses inline `backgroundColor` from interpolation function
- [ ] Existing `transition-all duration-500` preserved for smooth transitions

## Verification

- `npm run build:web-host` exits 0
- `rg "bg-foreground" web/components/gsd/dashboard.tsx` does not match the progress bar element (may still match other elements in the file — that's fine, just not the progress bar div)
- Visual: progress bar shows red at low %, yellow at ~50%, green at ~100%

## Inputs

- `web/components/gsd/dashboard.tsx` — existing progress bar at ~line 387, `progressPercent` computed at ~line 142
- `web/app/globals.css` — oklch token values for reference (hue 25 destructive, 85 warning, 145 success)

## Expected Output

- `web/components/gsd/dashboard.tsx` — progress bar div uses dynamic `backgroundColor` from `getProgressColor(progressPercent)` instead of `bg-foreground`
