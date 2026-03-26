# The Component Interface — Foundation of Everything

Every visual element in Pi implements this interface:

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```

| Method | Purpose | Required? |
|--------|---------|-----------|
| `render(width)` | Return array of strings (one per line). Each line ≤ `width` visible chars. | **Yes** |
| `handleInput(data)` | Receive keyboard input when component has focus. | Optional |
| `wantsKeyRelease` | If `true`, receive key release events (Kitty protocol). | Optional, default `false` |
| `invalidate()` | Clear cached render state. Called on theme changes. | **Yes** |

### The Render Contract

```typescript
render(width: number): string[] {
  // MUST return an array of strings
  // Each string MUST NOT exceed `width` in visible characters
  // ANSI escape codes (colors, styles) don't count toward visible width
  // Styles are reset at end of each line — reapply per line
  // Return [] for zero-height component
}
```

### The Invalidation Contract

```typescript
invalidate(): void {
  // Clear ALL cached render output
  // Clear any pre-baked themed strings
  // Call super.invalidate() if extending a built-in component
  // After invalidation, next render() must produce fresh output
}
```

---
