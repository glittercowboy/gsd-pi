# Built-in Dialog Methods

The simplest UI — blocking dialogs that wait for user response:

### Selection

```typescript
const choice = await ctx.ui.select("Pick a color:", ["Red", "Green", "Blue"]);
// Returns: "Red" | "Green" | "Blue" | undefined (if cancelled)
```

### Confirmation

```typescript
const ok = await ctx.ui.confirm("Delete file?", "This action cannot be undone.");
// Returns: true | false
```

### Text Input

```typescript
const name = await ctx.ui.input("Project name:", "my-project");
// Returns: string | undefined (if cancelled)
```

### Multi-line Editor

```typescript
const text = await ctx.ui.editor("Edit the description:", "Default text here");
// Returns: string | undefined (if cancelled)
```

### Timed Dialogs (Auto-Dismiss)

Dialogs can auto-dismiss with a live countdown:

```typescript
// Shows "Confirm? (5s)" → "Confirm? (4s)" → ... → auto-dismisses
const ok = await ctx.ui.confirm(
  "Auto-proceed?",
  "Continuing in 5 seconds...",
  { timeout: 5000 }
);
// Returns false on timeout
```

**Timeout return values:**
- `select()` → `undefined`
- `confirm()` → `false`
- `input()` → `undefined`

### Manual Dismissal with AbortSignal

For more control (distinguish timeout from user cancel):

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000);

const ok = await ctx.ui.confirm(
  "Timed Confirm",
  "Auto-cancels in 5s",
  { signal: controller.signal }
);

clearTimeout(timeoutId);

if (ok) {
  // User confirmed
} else if (controller.signal.aborted) {
  // Timed out
} else {
  // User cancelled (Escape)
}
```

---
