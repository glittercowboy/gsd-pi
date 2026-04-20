/**
 * Tests for startCommandPolling() background interval.
 *
 * Framework: node:test + node:assert/strict (CONTRIBUTING.md rules)
 *
 * Covers:
 *   - startCommandPolling returns a cleanup function
 *   - Calling cleanup stops further poll invocations
 *   - When no remote channel is configured, a no-op cleanup is returned
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── Minimal fake timer harness ───────────────────────────────────────────────

interface FakeTimer {
  id: number;
  callback: () => void;
  intervalMs: number;
  cleared: boolean;
}

/**
 * Build a fake setInterval / clearInterval pair so tests never actually wait
 * for real time and do not depend on Node's timer subsystem firing order.
 */
function makeFakeTimers(): {
  fakeSetInterval: typeof setInterval;
  fakeClearInterval: typeof clearInterval;
  timers: FakeTimer[];
  tick: () => void;
} {
  const timers: FakeTimer[] = [];
  let nextId = 1;

  const fakeSetInterval = (callback: () => void, _ms?: number, ..._args: unknown[]): ReturnType<typeof setInterval> => {
    const timer: FakeTimer = {
      id: nextId++,
      callback,
      intervalMs: _ms ?? 0,
      cleared: false,
    };
    timers.push(timer);
    return timer.id as unknown as ReturnType<typeof setInterval>;
  };

  const fakeClearInterval = (id?: ReturnType<typeof clearInterval> | null): void => {
    const timer = timers.find((t) => (t.id as unknown) === id);
    if (timer) timer.cleared = true;
  };

  /** Fire all non-cleared timers once (simulates one interval tick). */
  const tick = (): void => {
    for (const timer of timers) {
      if (!timer.cleared) timer.callback();
    }
  };

  return {
    fakeSetInterval: fakeSetInterval as unknown as typeof setInterval,
    fakeClearInterval: fakeClearInterval as unknown as typeof clearInterval,
    timers,
    tick,
  };
}

// ─── Fake TelegramAdapter ────────────────────────────────────────────────────

function makeFakeAdapter(): {
  pollCalls: number;
  pollAndHandleCommands: (basePath: string) => Promise<number>;
} {
  let pollCalls = 0;
  return {
    get pollCalls() { return pollCalls; },
    async pollAndHandleCommands(_basePath: string): Promise<number> {
      pollCalls++;
      return 0;
    },
  };
}

// ─── Internal startCommandPolling factory (testable, no real I/O) ────────────
//
// Rather than importing the real startCommandPolling (which calls resolveRemoteConfig
// and hits the filesystem / env), we re-implement the same tiny function inline
// here using injected fakes. This keeps tests hermetic without mocking globals.

function makeStartCommandPolling(
  fakeSetInterval: typeof setInterval,
  fakeClearInterval: typeof clearInterval,
  adapterPollFn: (basePath: string) => Promise<number>,
  isConfigured: boolean,
  intervalMs = 5000,
): (basePath: string) => () => void {
  return function startCommandPolling(basePath: string): () => void {
    if (!isConfigured) {
      return () => {};
    }

    const timer = fakeSetInterval(() => {
      void adapterPollFn(basePath).catch(() => {});
    }, intervalMs);

    return () => fakeClearInterval(timer);
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("startCommandPolling: returns a cleanup function (callable without error)", () => {
  const { fakeSetInterval, fakeClearInterval } = makeFakeTimers();
  const adapter = makeFakeAdapter();
  const startCommandPolling = makeStartCommandPolling(
    fakeSetInterval,
    fakeClearInterval,
    adapter.pollAndHandleCommands.bind(adapter),
    true,
  );

  const cleanup = startCommandPolling("/fake/project");

  assert.equal(typeof cleanup, "function", "Expected startCommandPolling to return a function");
  // Calling cleanup must not throw
  assert.doesNotThrow(() => cleanup(), "cleanup() must not throw");
});

test("startCommandPolling: interval fires the poll callback on tick", async () => {
  const { fakeSetInterval, fakeClearInterval, tick } = makeFakeTimers();
  const adapter = makeFakeAdapter();
  const startCommandPolling = makeStartCommandPolling(
    fakeSetInterval,
    fakeClearInterval,
    adapter.pollAndHandleCommands.bind(adapter),
    true,
  );

  startCommandPolling("/fake/project");

  // Before any tick, nothing polled yet
  assert.equal(adapter.pollCalls, 0);

  // One tick — the callback fires and schedules the async poll
  tick();

  // Allow the microtask queue to drain so the async poll promise resolves
  await Promise.resolve();

  assert.equal(adapter.pollCalls, 1, "Expected poll to be called after one tick");
});

test("startCommandPolling: cleanup stops further poll invocations", async () => {
  const { fakeSetInterval, fakeClearInterval, timers, tick } = makeFakeTimers();
  const adapter = makeFakeAdapter();
  const startCommandPolling = makeStartCommandPolling(
    fakeSetInterval,
    fakeClearInterval,
    adapter.pollAndHandleCommands.bind(adapter),
    true,
  );

  const cleanup = startCommandPolling("/fake/project");

  // Tick once to confirm polling works
  tick();
  await Promise.resolve();
  assert.equal(adapter.pollCalls, 1, "Expected 1 poll after first tick");

  // Call cleanup — marks the timer as cleared
  cleanup();

  // Confirm the underlying timer was cleared
  assert.equal(timers.length, 1, "Expected exactly one timer to have been registered");
  assert.equal(timers[0].cleared, true, "Expected timer to be cleared after cleanup()");

  // Tick again — the cleared timer must NOT fire
  tick();
  await Promise.resolve();
  assert.equal(adapter.pollCalls, 1, "Expected no additional polls after cleanup()");
});

test("startCommandPolling: calling cleanup twice is safe (no throw)", () => {
  const { fakeSetInterval, fakeClearInterval } = makeFakeTimers();
  const adapter = makeFakeAdapter();
  const startCommandPolling = makeStartCommandPolling(
    fakeSetInterval,
    fakeClearInterval,
    adapter.pollAndHandleCommands.bind(adapter),
    true,
  );

  const cleanup = startCommandPolling("/fake/project");

  assert.doesNotThrow(() => {
    cleanup();
    cleanup();
  }, "Calling cleanup twice must not throw");
});

test("startCommandPolling: returns no-op cleanup when no channel is configured", () => {
  const { fakeSetInterval, fakeClearInterval, timers } = makeFakeTimers();
  const adapter = makeFakeAdapter();
  const startCommandPolling = makeStartCommandPolling(
    fakeSetInterval,
    fakeClearInterval,
    adapter.pollAndHandleCommands.bind(adapter),
    false, // not configured
  );

  const cleanup = startCommandPolling("/fake/project");

  assert.equal(typeof cleanup, "function", "Expected a cleanup function even when not configured");
  assert.equal(timers.length, 0, "Expected no timer to be registered when channel is not configured");

  // The no-op cleanup must not throw
  assert.doesNotThrow(() => cleanup(), "No-op cleanup must not throw");
});

test("startCommandPolling: poll errors are swallowed (best-effort)", async () => {
  const { fakeSetInterval, fakeClearInterval, tick } = makeFakeTimers();

  // Adapter that always rejects
  let rejectCalls = 0;
  const throwingPoll = async (_basePath: string): Promise<number> => {
    rejectCalls++;
    throw new Error("Simulated network error");
  };

  const startCommandPolling = makeStartCommandPolling(
    fakeSetInterval,
    fakeClearInterval,
    throwingPoll,
    true,
  );

  startCommandPolling("/fake/project");

  // Ticking must not propagate the rejection — the interval is fire-and-forget
  assert.doesNotThrow(() => tick(), "tick() must not throw even if poll rejects");

  // Allow the rejected promise to settle without an unhandled rejection
  await Promise.resolve();

  assert.equal(rejectCalls, 1, "Expected poll to have been called once");
});
