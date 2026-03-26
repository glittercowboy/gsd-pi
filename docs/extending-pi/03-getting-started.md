# Getting Started


### Minimal Extension

Create `~/.gsd/agent/extensions/my-extension.ts`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });
}
```

### Testing

```bash
# Quick test (doesn't need to be in extensions dir)
pi -e ./my-extension.ts

# Or just place it in the extensions dir and start pi
pi
```

### Hot Reload

Extensions in auto-discovered locations (`~/.gsd/agent/extensions/` or `.gsd/extensions/`) can be hot-reloaded:

```
/reload
```

---
