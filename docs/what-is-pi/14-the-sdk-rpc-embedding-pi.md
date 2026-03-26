# The SDK & RPC — Embedding Pi

Pi isn't just a terminal tool. It's designed to be embedded in other applications.

### SDK (TypeScript)

For Node.js/TypeScript applications, import and use pi directly:

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// Subscribe to events
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

// Send prompts
await session.prompt("What files are in the current directory?");
```

The SDK gives you full control: custom tools, custom resource loaders, session management, model selection, event streaming. See the [openclaw/openclaw](https://github.com/openclaw/openclaw) project for a real-world SDK integration.

### RPC Mode (Any Language)

For non-Node.js applications, spawn pi as a subprocess and communicate via JSON over stdin/stdout:

```bash
pi --mode rpc --provider anthropic
```

Send commands:
```json
{"type": "prompt", "message": "Hello, world!"}
{"type": "steer", "message": "Stop and do this instead"}
{"type": "follow_up", "message": "After you're done, also do this"}
```

Receive events:
```json
{"type": "event", "event": {"type": "message_update", ...}}
{"type": "response", "command": "prompt", "success": true}
```

---
