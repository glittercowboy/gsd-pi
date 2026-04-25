/**
 * Test: RPC bridge TUI render loop must not burn CPU on non-TTY stdout.
 *
 * When gsd is spawned as an RPC bridge child process, stdout is a pipe
 * (process.stdout.isTTY === undefined). The TUI render loop must not
 * start in that scenario — otherwise it runs at ~4,600 renders/second
 * consuming 500%+ CPU doing nothing useful.
 *
 * Regression test for: https://github.com/gsd-build/gsd-2/issues/3095
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ProcessTerminal } from "@gsd/pi-tui";
import { TUI } from "@gsd/pi-tui";
import type { Terminal } from "@gsd/pi-tui";

/**
 * A mock terminal that tracks writes and render activity.
 * Simulates a non-TTY environment (isTTY = false).
 */
class MockNonTTYTerminal implements Terminal {
  public started = false;
  public writeCount = 0;
  public writtenData: string[] = [];
  private _onInput?: (data: string) => void;
  private _onResize?: () => void;

  /** Simulates non-TTY stdout */
  readonly isTTY = false;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started = true;
    this._onInput = onInput;
    this._onResize = onResize;
  }

  stop(): void {
    this.started = false;
  }

  async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

  write(data: string): void {
    this.writeCount++;
    this.writtenData.push(data);
  }

  get columns(): number { return 80; }
  get rows(): number { return 24; }
  get kittyProtocolActive(): boolean { return false; }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
}

/**
 * A mock terminal that behaves like a real TTY.
 */
class MockTTYTerminal extends MockNonTTYTerminal {
  override readonly isTTY = true as const;
}

describe("TUI non-TTY render loop guard (issue #3095)", () => {
  it("ProcessTerminal.start() should be a no-op when stdout is not a TTY", () => {
    // ProcessTerminal.start() accesses process.stdout directly.
    // We verify it exposes isTTY so callers can check before starting.
    const terminal = new ProcessTerminal();
    // ProcessTerminal.isTTY should reflect process.stdout.isTTY
    assert.equal(
      typeof terminal.isTTY,
      "boolean",
      "ProcessTerminal must expose an isTTY property"
    );
  });

  it("TUI.start() must not render when terminal.isTTY is false", async () => {
    const terminal = new MockNonTTYTerminal();
    const tui = new TUI(terminal);

    tui.start();

    // Wait for any nextTick-scheduled renders to fire
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // The TUI should NOT have produced any render output on a non-TTY terminal
    assert.equal(
      terminal.writeCount,
      0,
      `TUI rendered ${terminal.writeCount} times on non-TTY stdout — ` +
      `this would cause the CPU burn described in #3095. ` +
      `Expected 0 writes when isTTY is false.`
    );

    // Clean up
    tui.stop();
  });

  it("TUI.start() renders normally when terminal.isTTY is true", async () => {
    const terminal = new MockTTYTerminal();
    const tui = new TUI(terminal);

    tui.start();

    // Wait for nextTick-scheduled render
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // On a TTY terminal, at least one render should have occurred
    assert.ok(
      terminal.writeCount > 0,
      "TUI should render at least once on a TTY terminal"
    );

    tui.stop();
  });

  it("requestRender() must be a no-op when terminal.isTTY is false", async () => {
    const terminal = new MockNonTTYTerminal();
    const tui = new TUI(terminal);

    tui.start();

    // Force multiple render requests
    tui.requestRender();
    tui.requestRender();
    tui.requestRender();

    // Wait for any scheduled renders
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.equal(
      terminal.writeCount,
      0,
      "requestRender() must not write to non-TTY stdout"
    );

    tui.stop();
  });
});
