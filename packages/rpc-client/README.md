# @gsd-build/rpc-client

Standalone RPC client SDK for GSD. Spawn the agent process, perform a v2 protocol handshake, send commands, and consume typed events via an async generator — all in a few lines of TypeScript.

Zero internal dependencies. Ships its own inlined types.

## Installation

```bash
npm install @gsd-build/rpc-client
```

## Quick Start

```typescript
import { RpcClient } from '@gsd-build/rpc-client';

const client = new RpcClient({ cwd: process.cwd() });
await client.start();
const { sessionId } = await client.init({ clientId: 'my-app' });
console.log(`Session: ${sessionId}`);

await client.prompt('Create a hello world script');
for await (const event of client.events()) {
  if (event.type === 'execution_complete') break;
  console.log(event.type);
}
await client.shutdown();
```

## API

### Constructor

```typescript
const client = new RpcClient(options?: RpcClientOptions);
```

| Option     | Type                     | Description                              |
|------------|--------------------------|------------------------------------------|
| `cliPath`  | `string`                 | Path to the CLI entry point              |
| `cwd`      | `string`                 | Working directory for the agent          |
| `env`      | `Record<string, string>` | Environment variables                    |
| `provider` | `string`                 | AI provider (e.g. `"anthropic"`)         |
| `model`    | `string`                 | Model ID (e.g. `"claude-sonnet"`)        |
| `args`     | `string[]`               | Additional CLI arguments                 |

### Lifecycle

| Method        | Description                                    |
|---------------|------------------------------------------------|
| `start()`     | Spawn the agent process                        |
| `init(opts?)` | v2 handshake — returns `sessionId`, capabilities |
| `shutdown()`  | Graceful shutdown                              |
| `stop()`      | Force-kill the process                         |

### Commands

| Method                         | Description                            |
|--------------------------------|----------------------------------------|
| `prompt(message, images?)`     | Send a prompt                          |
| `steer(message, images?)`      | Interrupt with a steering message      |
| `followUp(message, images?)`   | Queue a follow-up message              |
| `abort()`                      | Abort current operation                |
| `subscribe(events)`            | Subscribe to event types (`["*"]` for all) |

### Events

```typescript
// Async generator — recommended
for await (const event of client.events()) {
  console.log(event.type);
}

// Callback-based
const unsubscribe = client.onEvent((event) => {
  console.log(event.type);
});
```

### Helpers

| Method                                | Description                              |
|---------------------------------------|------------------------------------------|
| `waitForIdle(timeout?)`               | Wait for `agent_end` event               |
| `collectEvents(timeout?)`             | Collect events until idle                |
| `promptAndWait(message, images?, t?)` | Send prompt and collect events           |

### Session & Model

| Method                           | Description                       |
|----------------------------------|-----------------------------------|
| `getState()`                     | Get session state                 |
| `setModel(provider, modelId)`    | Set model                         |
| `cycleModel()`                   | Cycle to next model               |
| `getAvailableModels()`           | List available models             |
| `setThinkingLevel(level)`        | Set thinking level                |
| `cycleThinkingLevel()`           | Cycle thinking level              |
| `compact(instructions?)`         | Compact session context           |
| `getSessionStats()`              | Get session statistics            |
| `bash(command)`                  | Execute a bash command            |
| `newSession(parent?)`            | Start a new session               |
| `sendUIResponse(id, response)`   | Respond to extension UI requests  |

## Type Exports

All protocol types are exported from the package root:

```typescript
import type {
  RpcCommand,
  RpcResponse,
  RpcInitResult,
  RpcExecutionCompleteEvent,
  RpcCostUpdateEvent,
  RpcV2Event,
  SessionStats,
  SdkAgentEvent,
  RpcClientOptions,
} from '@gsd-build/rpc-client';
```

## License

MIT
