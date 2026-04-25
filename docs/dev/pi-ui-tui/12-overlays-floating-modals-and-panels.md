# Overlays — Floating Modals and Panels

Overlays render **on top of existing content** without clearing the screen. Essential for dialogs, side panels, and floating UI.

### Basic Overlay

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyDialog({ onClose: done }),
  { overlay: true }
);
```

### Positioned Overlay

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, _kb, done) => new SidePanel({ onClose: done }),
  {
    overlay: true,
    overlayOptions: {
      // Size (number = columns, string = percentage)
      width: "50%",
      minWidth: 40,
      maxHeight: "80%",

      // Position: anchor-based (9 positions)
      anchor: "right-center",
      offsetX: -2,
      offsetY: 0,

      // Or absolute/percentage positioning
      row: "25%",    // 25% from top
      col: 10,       // column 10

      // Margins
      margin: 2,                              // all sides
      margin: { top: 2, right: 4, bottom: 2, left: 4 },  // per side

      // Responsive: hide on narrow terminals
      visible: (termWidth, termHeight) => termWidth >= 80,
    },
  }
);
```

### Anchor Positions

```
  top-left      top-center      top-right
       ┌────────────────────────────┐
       │                            │
  left-center    center     right-center
       │                            │
       └────────────────────────────┘
  bottom-left  bottom-center  bottom-right
```

### Programmatic Visibility Control

```typescript
let overlayHandle: OverlayHandle | null = null;

const result = await ctx.ui.custom<string | null>(
  (tui, theme, _kb, done) => new MyPanel({ onClose: done }),
  {
    overlay: true,
    overlayOptions: { anchor: "right-center", width: "40%" },
    onHandle: (handle) => {
      overlayHandle = handle;
      // handle.setHidden(true)  — temporarily hide
      // handle.setHidden(false) — show again
      // handle.hide()           — permanently remove
    },
  }
);
```

### Stacked Overlays

Multiple overlays can be shown simultaneously. They stack in order (newest on top). Each one's `done()` closes only that overlay:

```typescript
// Show three stacked overlays
const p1 = ctx.ui.custom(/* ... */, { overlay: true, overlayOptions: { offsetX: -5, offsetY: -3 } });
const p2 = ctx.ui.custom(/* ... */, { overlay: true, overlayOptions: { offsetX: 0, offsetY: 0 } });
const p3 = ctx.ui.custom(/* ... */, { overlay: true, overlayOptions: { offsetX: 5, offsetY: 3 } });

// Last one shown (p3) receives keyboard input
// Closing p3 gives focus to p2, closing p2 gives focus to p1
```

### ⚠️ Overlay Lifecycle Rule

**Overlay components are disposed when closed. Never reuse references.**

```typescript
// ❌ WRONG — stale reference
let menu: MenuComponent;
await ctx.ui.custom((_, __, ___, done) => {
  menu = new MenuComponent(done);
  return menu;
}, { overlay: true });
menu.doSomething();  // DISPOSED — will fail

// ✅ CORRECT — re-call the factory
const showMenu = () => ctx.ui.custom(
  (_, __, ___, done) => new MenuComponent(done),
  { overlay: true }
);
await showMenu();  // First show
await showMenu();  // Re-show with fresh instance
```

---
