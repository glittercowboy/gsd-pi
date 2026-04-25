# Testing Extensions

This chapter covers practical patterns for testing Pi extensions. All examples use conventions from the existing codebase.

## Test File Location

Tests live in one of two places:

- **Co-located**: `my-extension.test.ts` next to `my-extension.ts`
- **Subdirectory**: `tests/my-feature.test.ts` inside the extension directory

Both patterns are used in the codebase. The subdirectory approach is common when an extension has many test files.

## Running Tests

Pi extensions use Node.js built-in test runner -- no external frameworks required:

```bash
# Run a single test file
node --test src/resources/extensions/my-ext/tests/my-feature.test.ts

# Run all tests in a directory
node --test src/resources/extensions/my-ext/tests/*.test.ts

# Run with TypeScript (Node 22+)
node --experimental-strip-types --test my-extension.test.ts
```

## Imports

Every test file starts with the same core imports:

```typescript
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
```

No Jest, no Mocha, no Vitest. The built-in `node:test` module covers everything needed.

## Mock Patterns

### Mock ExtensionAPI

The `ExtensionAPI` (the `pi` object) is what your `export default function(pi)` receives. Build a minimal mock with only the methods your test needs:

```typescript
function makeMockPi() {
  const registeredTools: any[] = [];
  const registeredCommands: Map<string, any> = new Map();
  const handlers: Map<string, Function> = new Map();
  return {
    registerTool(def: any) { registeredTools.push(def); },
    registerCommand(name: string, opts: any) { registeredCommands.set(name, opts); },
    on(event: string, handler: Function) { handlers.set(event, handler); },
    sendMessage: (...args: unknown[]) => {},
    // expose internals for assertions
    _registeredTools: registeredTools,
    _registeredCommands: registeredCommands,
    _handlers: handlers,
  } as any;
}
```

The `as any` cast lets you provide only the properties you need without satisfying the full interface. Add more methods as your extension requires them.

### Mock ExtensionContext

The `ExtensionContext` (the `ctx` object) is passed to event handlers, command handlers, and tool execute functions:

```typescript
function makeMockCtx() {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    ui: {
      notify: (msg: string, level: string) => {
        notifications.push({ message: msg, level });
      },
      select: async () => null,
      confirm: async () => false,
      input: async () => null,
    },
    cwd: "/tmp/test-project",
    model: { id: "test-model" },
    isIdle: () => true,
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
    },
    _notifications: notifications,
  } as any;
}
```

Underscore-prefixed properties (`_notifications`) are your test hooks -- they let you inspect what your extension did without adding real UI infrastructure.

### Capturing Calls

A recurring pattern: store calls in an array, then assert against it:

```typescript
const calls: string[] = [];
const ctx = {
  ui: {
    notify(msg: string, level: string) { calls.push(`${level}:${msg}`); },
  },
} as any;

// ... run extension code ...

assert.equal(calls.length, 1);
assert.match(calls[0], /info:Extension loaded/);
```

## Testing Tool Registration and Execution

### Verify a tool gets registered

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import myExtension from "../my-extension.ts";

test("registers the lookup tool", () => {
  const pi = makeMockPi();
  myExtension(pi);

  assert.equal(pi._registeredTools.length, 1);
  assert.equal(pi._registeredTools[0].name, "lookup");
  assert.equal(pi._registeredTools[0].description, "Look up a record by ID");
});
```

### Test a tool's execute function

Extract the tool definition and call its `execute` directly:

```typescript
test("lookup tool returns formatted result", async () => {
  const pi = makeMockPi();
  myExtension(pi);

  const tool = pi._registeredTools.find((t: any) => t.name === "lookup");
  assert.ok(tool, "tool should be registered");

  const ctx = makeMockCtx();
  const result = await tool.execute({ id: "abc-123" }, ctx);

  assert.ok(result.includes("abc-123"), "result should contain the ID");
});
```

## Testing Command Handlers

Commands are registered with `pi.registerCommand()`. Test them by calling the handler directly:

```typescript
test("status command shows current state", async () => {
  const pi = makeMockPi();
  myExtension(pi);

  const cmd = pi._registeredCommands.get("status");
  assert.ok(cmd, "command should be registered");

  const ctx = makeMockCtx();
  await cmd.handler("--verbose", ctx);

  assert.equal(ctx._notifications.length, 1);
  assert.match(ctx._notifications[0].message, /Current state/);
});
```

## Testing Event Hooks

Event handlers are registered with `pi.on()`. Retrieve and invoke them directly:

### Simple event handler

```typescript
test("session_start hook sends greeting", async () => {
  const pi = makeMockPi();
  myExtension(pi);

  const handler = pi._handlers.get("session_start");
  assert.ok(handler, "session_start handler should be registered");

  const ctx = makeMockCtx();
  await handler({}, ctx);

  assert.equal(ctx._notifications.length, 1);
  assert.equal(ctx._notifications[0].level, "info");
});
```

### session_start with state reconstruction

Extensions often rebuild internal state from session history on startup. Test this by providing mock session entries:

```typescript
test("session_start reconstructs state from prior tool calls", async () => {
  const pi = makeMockPi();
  myExtension(pi);

  const handler = pi._handlers.get("session_start");
  const ctx = {
    ...makeMockCtx(),
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [
        {
          type: "tool_result",
          tool_name: "add_item",
          content: JSON.stringify({ id: 1, text: "Buy milk" }),
        },
        {
          type: "tool_result",
          tool_name: "add_item",
          content: JSON.stringify({ id: 2, text: "Write tests" }),
        },
      ],
    },
  } as any;

  await handler({}, ctx);

  // Verify internal state was reconstructed
  // (how you verify depends on your extension's design)
  const tool = pi._registeredTools.find((t: any) => t.name === "list_items");
  const result = await tool.execute({}, ctx);
  assert.ok(result.includes("Buy milk"));
  assert.ok(result.includes("Write tests"));
});
```

## Filesystem Isolation

When your extension reads or writes files, use temporary directories so tests never touch the real filesystem:

```typescript
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ext-test-"));
}

describe("config persistence", () => {
  let dir: string;

  beforeEach(() => { dir = createTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("saves config to disk", () => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ enabled: true }));

    const loaded = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepEqual(loaded, { enabled: true });
  });

  test("handles missing config gracefully", () => {
    const configPath = join(dir, "config.json");
    // Extension should handle the file not existing
    assert.equal(existsSync(configPath), false);
  });
});
```

Key points:
- `mkdtempSync` creates a unique temporary directory each run
- `beforeEach`/`afterEach` ensure clean state between tests
- Always clean up with `rmSync` in `afterEach` or a `finally` block

## Environment Variable Control

Some extensions read environment variables. Control them in tests:

```typescript
test("respects GSD_DEBUG env var", async () => {
  const original = process.env.GSD_DEBUG;
  try {
    process.env.GSD_DEBUG = "1";
    // ... run extension code that checks GSD_DEBUG ...
    // ... assert debug behavior ...
  } finally {
    if (original === undefined) {
      delete process.env.GSD_DEBUG;
    } else {
      process.env.GSD_DEBUG = original;
    }
  }
});
```

Always restore the original value in a `finally` block to prevent test pollution.

## Tips

1. **Keep mocks minimal** -- Only mock the properties your code actually touches. Adding unused mock methods creates maintenance burden and hides what your test actually depends on.

2. **Test behavior, not implementation** -- Assert on what your extension *does* (notifications sent, files written, values returned) rather than how it does it internally.

3. **Use `as any` freely** -- Full interface compliance is not the goal of test mocks. Cast with `as any` and provide only what the code under test needs.

4. **Test pure functions directly** -- If your extension has helper functions (parsers, validators, formatters), import and test them without any mocking at all. These are the easiest and most valuable tests.

5. **One assertion focus per test** -- Each test should verify one behavior. Multiple assertions are fine when they all relate to the same behavior (e.g., checking both the message and level of a notification).

6. **Prefer `assert.strictEqual` and `assert.deepEqual`** -- Use `strictEqual` for primitives, `deepEqual` for objects and arrays, and `assert.match` for regex checks against strings.

7. **Clean up resources** -- Always use `afterEach` or `try/finally` to remove temp directories, restore env vars, and reset any global state.

---
