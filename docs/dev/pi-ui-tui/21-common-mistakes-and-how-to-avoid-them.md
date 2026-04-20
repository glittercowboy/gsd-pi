# Common Mistakes and How to Avoid Them

### 1. Lines exceed width

**Symptom:** Visual corruption, overlapping lines, garbled display.
**Fix:** Use `truncateToWidth()` on every line.

### 2. Forgetting `tui.requestRender()`

**Symptom:** UI doesn't update after state changes.
**Fix:** Call `this.invalidate()` then `tui.requestRender()` after any state change in `handleInput`.

### 3. Importing theme directly

**Symptom:** Wrong colors, crashes, or stale theme after switching.
**Fix:** Always use `theme` from the callback: `ctx.ui.custom((tui, theme, kb, done) => ...)`.

### 4. Not typing DynamicBorder color param

**Symptom:** TypeScript error or runtime crash.
**Fix:** `new DynamicBorder((s: string) => theme.fg("accent", s))` — always add `s: string`.

### 5. Reusing disposed overlay components

**Symptom:** Component doesn't render, events don't fire.
**Fix:** Create fresh instances each time. Never save references to overlay components.

### 6. Styles bleeding across lines

**Symptom:** Colors from one line appear on the next.
**Fix:** The TUI resets styles at end of each line. Reapply styles per line, or use `wrapTextWithAnsi()`.

### 7. Not implementing invalidate()

**Symptom:** Theme changes don't take effect, stale rendering.
**Fix:** Clear all caches in `invalidate()`. If you pre-bake theme colors, rebuild them.

### 8. Forgetting to call `super.invalidate()`

**Symptom:** Child components don't update when extending Container/Box.
**Fix:** `override invalidate() { super.invalidate(); /* your cleanup */ }`

### 9. Timer not cleaned up

**Symptom:** Errors after component closes, memory leaks, phantom updates.
**Fix:** Call `clearInterval` in a `dispose()` method before calling `done()`.

### 10. Using `ctx.ui` methods in non-interactive mode

**Symptom:** Hangs (dialogs waiting for input that will never come) or silent failures.
**Fix:** Check `ctx.hasUI` before calling dialog methods.

---
