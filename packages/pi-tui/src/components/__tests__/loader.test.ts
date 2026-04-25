// pi-tui Loader component regression tests
//
// The previous version of this file contained 3 tests that called
// `start()`/`stop()`/`dispose()` with no assertions at all — the claimed
// regression ("interval leak") would not have failed any of them. See
// #4794 / #4784.
//
// This rewrite uses Node's `mock.timers` to observe the interval that
// `Loader` registers internally, and `mock.fn()` on the mock TUI to
// count render requests. Each test asserts on observable behaviour:
// how many `requestRender` calls happen per tick, whether the interval
// is cleared on stop/dispose, and whether post-dispose stop() is safe.

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Loader } from "../loader.js";

interface MockTui {
  requestRender: ReturnType<typeof mock.fn>;
}

function makeMockTUI(): MockTui {
  return { requestRender: mock.fn() };
}

describe("Loader", () => {
  let loader: Loader;
  let tui: MockTui;

  beforeEach(() => {
    tui = makeMockTUI();
    mock.timers.enable({ apis: ["setInterval"] });
  });

  afterEach(() => {
    try {
      loader?.stop();
    } catch {
      /* best-effort */
    }
    mock.timers.reset();
  });

  it("constructor starts a spinner that ticks every 80ms and requests renders", () => {
    loader = new Loader(tui as never, (s) => s, (s) => s, "test");
    // Initial render request from start().
    const initial = tui.requestRender.mock.callCount();
    assert.ok(
      initial >= 1,
      `constructor should trigger at least one render (got ${initial})`,
    );

    // Advance 80ms — one interval tick should call requestRender once more.
    mock.timers.tick(80);
    assert.equal(
      tui.requestRender.mock.callCount(),
      initial + 1,
      "80ms tick should advance the spinner and call requestRender",
    );

    // Advance another 240ms — three more ticks.
    mock.timers.tick(240);
    assert.equal(
      tui.requestRender.mock.callCount(),
      initial + 4,
      "four total ticks after the initial render",
    );
  });

  it("start() is idempotent — calling twice does not leak intervals", () => {
    loader = new Loader(tui as never, (s) => s, (s) => s, "test");
    // Constructor already started one interval. Call start() again.
    loader.start();

    const before = tui.requestRender.mock.callCount();
    mock.timers.tick(80);
    const after = tui.requestRender.mock.callCount();
    // Exactly ONE tick's worth of work should happen — if the second
    // start() leaked an interval, we'd see two increments per tick.
    assert.equal(
      after - before,
      1,
      "double-start must not double-tick (interval leak would show 2 increments)",
    );
  });

  it("stop() clears the interval — no more ticks advance requestRender", () => {
    loader = new Loader(tui as never, (s) => s, (s) => s, "test");
    loader.stop();

    const beforeTick = tui.requestRender.mock.callCount();
    mock.timers.tick(400); // 5 tick intervals
    assert.equal(
      tui.requestRender.mock.callCount(),
      beforeTick,
      "stopped loader must not advance renders",
    );
  });

  it("dispose() stops the interval and nulls the TUI reference", () => {
    loader = new Loader(tui as never, (s) => s, (s) => s, "test");
    loader.dispose();

    const beforeTick = tui.requestRender.mock.callCount();
    mock.timers.tick(400);
    assert.equal(
      tui.requestRender.mock.callCount(),
      beforeTick,
      "disposed loader must not advance renders",
    );

    // Calling stop() after dispose() must not throw.
    assert.doesNotThrow(() => loader.stop());
  });

  it("stop() is safe to call multiple times without throwing", () => {
    loader = new Loader(tui as never, (s) => s, (s) => s, "test");
    loader.stop();
    assert.doesNotThrow(() => loader.stop());
    assert.doesNotThrow(() => loader.stop());
  });
});
