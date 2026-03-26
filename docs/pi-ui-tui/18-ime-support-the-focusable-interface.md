# IME Support — The Focusable Interface

For components that display a text cursor and need IME (Input Method Editor) support for CJK languages:

```typescript
import { CURSOR_MARKER, type Component, type Focusable } from "@mariozechner/pi-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // Set by TUI when focus changes

  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    return [`> ${beforeCursor}${marker}\x1b[7m${atCursor}\x1b[27m${afterCursor}`];
  }
}
```

### Container with Embedded Input

If your container contains an `Input` or `Editor` child, propagate focus:

```typescript
class SearchDialog extends Container implements Focusable {
  private searchInput: Input;
  private _focused = false;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;  // Propagate!
  }

  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }
}
```

Without this, IME candidate windows (Chinese, Japanese, Korean input) appear in the wrong position.

---
