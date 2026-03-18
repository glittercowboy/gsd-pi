# Knowledge Base

Patterns, gotchas, and non-obvious lessons learned during development.

---

## K001: Testing Electron-dependent modules without Electron

**Context:** GsdService imports from `electron` and `child_process`, making it impossible to test directly with `node --test`.

**Solution:** Replicate the pure logic (JSONL parser, dispatch router, fire-and-forget classifier) as standalone functions in the test file. Test those instead of importing the class. This avoids Electron dependency while covering the highest-risk code paths.

**Trade-off:** Logic must be kept in sync manually. The FIRE_AND_FORGET_METHODS test mitigates this by reading the source file and comparing.

---

## K002: JSONL framing — readline is unreliable, use manual buffer drain

**Context:** Node's `readline` module has edge cases with CR+LF boundaries and partial buffer flushes that cause subtle framing errors in high-throughput JSONL streams.

**Solution:** Manual `buffer += chunk` → `indexOf('\n')` loop. Split on LF only. Strip trailing CR from each line. Skip empty lines. Leave incomplete trailing data in the buffer.

**Pattern:**
```
buffer += chunk
while ((idx = buffer.indexOf('\n')) !== -1) {
  let line = buffer.slice(0, idx)
  buffer = buffer.slice(idx + 1)
  if (line.endsWith('\r')) line = line.slice(0, -1)
  if (!line) continue
  // parse line as JSON
}
```

---

## K003: React StrictMode double-mount breaks IPC subscriptions

**Context:** React 18+ StrictMode calls effects twice in development. If the useGsd hook subscribes to IPC events in useEffect without guarding, it creates duplicate subscriptions and fires auto-spawn twice.

**Solution:** Use a `mounted` ref that's set to `true` on first effect run and checked on subsequent runs. Return cleanup that resets it. Keep the hook in an always-mounted component (CenterPanel) so the ref lifecycle is predictable.

**Warning:** If useGsd is ever moved to a conditionally-mounted component, the ref guard won't work correctly on remount. The hook assumes a single mount-for-app-lifetime pattern.

---

## K004: IPC event handler must strip the Electron IpcRendererEvent arg

**Context:** `ipcRenderer.on('channel', handler)` passes `(event, ...args)` where `event` is the IpcRendererEvent. If the preload bridge passes this directly to the renderer callback, the renderer receives the Electron event object instead of the data.

**Solution:** Preload handlers use `(_event, data) => callback(data)` — explicitly strip the first arg before forwarding through contextBridge.

---

## K005: Event type field naming inconsistency in the RPC protocol

**Context:** Some gsd-2 RPC events use `{ type: 'message_update', ... }` and others use `{ event: 'tool_execution_start', ... }`. Both conventions exist in the protocol.

**Solution:** Always check both: `const eventType = data.type ?? data.event`. This is done in useGsd for store routing and in CenterPanel for display badge colors.

---

## K006: Phosphor Icons — X is aliased to AlignBottomSimple

**Context:** In the Phosphor Icons bundle, the named export `X` collides with `AlignBottomSimple`. Importing `X` from `@phosphor-icons/react` gives the wrong icon.

**Solution:** Use `XCircle` for error/close indicators instead of `X`. Always verify Phosphor named exports render the expected glyph.

---

## K007: react-jsx tsconfig breaks JSX.IntrinsicElements global namespace

**Context:** When `tsconfig.json` uses `"jsx": "react-jsx"` (the modern transform), the global `JSX` namespace is not exposed. Code like `JSX.IntrinsicElements['div']` causes TS2503.

**Solution:** Use `ComponentPropsWithoutRef<'div'>` from React instead. It provides the same prop types without depending on the global namespace. Pattern: `type P<T extends keyof React.JSX.IntrinsicElements> = ComponentPropsWithoutRef<T> & ExtraProps`.

---

## K008: Worktree dist/ directories must be built before root tests pass

**Context:** Git worktrees don't share `dist/` output directories. The root `npm run test` imports from `packages/*/dist/` and `dist/`, which don't exist in a fresh worktree.

**Solution:** Build packages before running root tests: `npm run build -w packages/pi-ai && npm run build -w packages/pi-agent-core && npm run build -w packages/pi-tui && npx tsc` (root). `packages/pi-coding-agent` has pre-existing TypeScript errors and cannot be built in the current state. Workspace-scoped tests (`npm run test -w studio`) don't need dist/ builds.
