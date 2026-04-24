/**
 * Tests for the REAL `startCommandPolling()` background interval.
 *
 * Previous version of this file re-implemented `startCommandPolling`
 * inline (as `makeStartCommandPolling`) and tested the re-implementation.
 * The file header said exactly that: "Rather than importing the real
 * startCommandPolling (which calls resolveRemoteConfig and hits the
 * filesystem / env), we re-implement the same tiny function inline
 * here using injected fakes." If the real function regressed (wrong
 * channel gate, missing cleanup, wrong handler invocation), none of
 * those tests would have failed. See #4806 / #4784.
 *
 * Rewrite uses the DI seam now exposed on `startCommandPolling`
 * (`CommandPollingDeps`) to drive the real function with a stubbed
 * config resolver, adapter factory, and timer pair.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ResolvedConfig } from "../config.ts";
import {
  startCommandPolling,
  type PollingAdapter,
  type CommandPollingDeps,
} from "../manager.ts";

// ─── Fake timer harness ───────────────────────────────────────────────────────

interface FakeTimer {
  id: number;
  callback: () => void;
  intervalMs: number;
  cleared: boolean;
}

function makeFakeTimers(): {
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
  timers: FakeTimer[];
  tick: () => void;
} {
  const timers: FakeTimer[] = [];
  let nextId = 1;

  const setIntervalFn = ((callback: () => void, ms?: number): ReturnType<typeof setInterval> => {
    const timer: FakeTimer = {
      id: nextId++,
      callback,
      intervalMs: ms ?? 0,
      cleared: false,
    };
    timers.push(timer);
    return timer.id as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  const clearIntervalFn = ((id?: ReturnType<typeof clearInterval> | null): void => {
    const timer = timers.find((t) => (t.id as unknown) === id);
    if (timer) timer.cleared = true;
  }) as unknown as typeof clearInterval;

  const tick = (): void => {
    for (const timer of timers) {
      if (!timer.cleared) timer.callback();
    }
  };

  return { setIntervalFn, clearIntervalFn, timers, tick };
}

// ─── Config + adapter stubs ───────────────────────────────────────────────────

function telegramConfig(): ResolvedConfig {
  return {
    channel: "telegram",
    token: "fake-token",
    channelId: "fake-channel-id",
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
  } as ResolvedConfig;
}

function slackConfig(): ResolvedConfig {
  return {
    channel: "slack",
    token: "fake-token",
    channelId: "fake-channel-id",
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
  } as ResolvedConfig;
}

function makeFakeAdapter(): PollingAdapter & { readonly pollCalls: number } {
  let pollCalls = 0;
  const adapter = {
    get pollCalls(): number {
      return pollCalls;
    },
    async pollAndHandleCommands(_basePath: string): Promise<number> {
      pollCalls++;
      return 0;
    },
  };
  return adapter;
}

// ─── Tests against the real startCommandPolling ───────────────────────────────

describe("startCommandPolling (real function via DI seam)", () => {
  it("returns a cleanup function for a Telegram config", () => {
    const { setIntervalFn, clearIntervalFn } = makeFakeTimers();
    const adapter = makeFakeAdapter();

    const deps: CommandPollingDeps = {
      resolveConfig: () => telegramConfig(),
      createAdapter: () => adapter,
      setIntervalFn,
      clearIntervalFn,
    };

    const stop = startCommandPolling("/tmp/project", 5_000, deps);
    assert.equal(typeof stop, "function", "must return a cleanup function");
    stop();
  });

  it("invokes the adapter's pollAndHandleCommands on each tick", async () => {
    const { setIntervalFn, clearIntervalFn, tick } = makeFakeTimers();
    const adapter = makeFakeAdapter();

    const stop = startCommandPolling("/tmp/project", 5_000, {
      resolveConfig: () => telegramConfig(),
      createAdapter: () => adapter,
      setIntervalFn,
      clearIntervalFn,
    });

    assert.equal(adapter.pollCalls, 0, "no poll before any tick");

    tick();
    // Yield so the async adapter call settles before we assert.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(adapter.pollCalls, 1, "one tick → one poll");

    tick();
    tick();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(adapter.pollCalls, 3, "three ticks → three polls");

    stop();
  });

  it("cleanup stops further polls", async () => {
    const { setIntervalFn, clearIntervalFn, tick } = makeFakeTimers();
    const adapter = makeFakeAdapter();

    const stop = startCommandPolling("/tmp/project", 5_000, {
      resolveConfig: () => telegramConfig(),
      createAdapter: () => adapter,
      setIntervalFn,
      clearIntervalFn,
    });

    tick();
    await Promise.resolve();
    await Promise.resolve();
    const pollsBeforeStop = adapter.pollCalls;
    assert.ok(pollsBeforeStop > 0, "at least one poll before stop");

    stop();

    tick();
    tick();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      adapter.pollCalls,
      pollsBeforeStop,
      "no additional polls after stop() — cleared interval must stop ticking",
    );
  });

  it("returns a no-op when no remote channel is configured", () => {
    const { setIntervalFn, clearIntervalFn, timers } = makeFakeTimers();
    const adapter = makeFakeAdapter();

    const stop = startCommandPolling("/tmp/project", 5_000, {
      resolveConfig: () => null,
      createAdapter: () => adapter,
      setIntervalFn,
      clearIntervalFn,
    });

    assert.equal(typeof stop, "function", "still returns a function");
    assert.equal(
      timers.length,
      0,
      "no interval registered when config is absent",
    );
    assert.doesNotThrow(() => stop());
  });

  it("returns a no-op for non-Telegram channels (e.g. Slack)", () => {
    const { setIntervalFn, clearIntervalFn, timers } = makeFakeTimers();
    const adapter = makeFakeAdapter();
    let adapterCreated = false;

    const stop = startCommandPolling("/tmp/project", 5_000, {
      resolveConfig: () => slackConfig(),
      createAdapter: () => {
        adapterCreated = true;
        return adapter;
      },
      setIntervalFn,
      clearIntervalFn,
    });

    assert.equal(
      timers.length,
      0,
      "no interval registered for non-Telegram channel",
    );
    assert.equal(
      adapterCreated,
      false,
      "adapter must not be instantiated when channel is unsupported",
    );
    stop();
  });

  it("does not surface adapter polling errors (best-effort)", async () => {
    const { setIntervalFn, clearIntervalFn, tick } = makeFakeTimers();
    const adapter: PollingAdapter = {
      async pollAndHandleCommands(_basePath: string): Promise<number> {
        throw new Error("network hiccup");
      },
    };

    const stop = startCommandPolling("/tmp/project", 5_000, {
      resolveConfig: () => telegramConfig(),
      createAdapter: () => adapter,
      setIntervalFn,
      clearIntervalFn,
    });

    // Tick must not throw; the `.catch(() => {})` in production code
    // swallows the rejection so one bad network call doesn't crash
    // the polling loop.
    assert.doesNotThrow(() => tick());
    await Promise.resolve();
    await Promise.resolve();

    stop();
  });
});
