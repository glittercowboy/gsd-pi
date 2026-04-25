/**
 * Regression test for #3764: TUI input clears and jumps up after PR #3744.
 *
 * PR #3744 introduced contentCursorRow which diverged from the actual terminal
 * cursor position, causing computeLineDiff to compute wrong movement deltas.
 * The fix reverts to using hardwareCursorRow (actual cursor position) as the
 * baseline for all cursor movement calculations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, TUI, type Component, type Terminal } from "@gsd/pi-tui";

class MockTTYTerminal implements Terminal {
  public writtenData: string[] = [];

  readonly isTTY = true;

  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

  write(data: string): void {
    this.writtenData.push(data);
  }

  get columns(): number {
    return 80;
  }

  get rows(): number {
    return 24;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
}

class DynamicLinesComponent implements Component {
  public lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  render(_width: number): string[] {
    return this.lines;
  }

  invalidate(): void {}
}

describe("TUI cursor tracking regression (#3764)", () => {
  it("does not produce spurious cursor jumps when content changes after IME positioning", () => {
    const terminal = new MockTTYTerminal();
    const tui = new TUI(terminal, false);
    const component = new DynamicLinesComponent([
      "header",
      `input: hello${CURSOR_MARKER}`,
      "status line",
    ]);

    tui.addChild(component);
    (tui as any).doRender();

    // After first render, hardwareCursorRow is at IME position (row 1)
    assert.strictEqual(
      (tui as any).hardwareCursorRow,
      1,
      "hardwareCursorRow should be at IME cursor position (row 1)",
    );

    // Simulate typing — content changes on the same line
    terminal.writtenData = [];
    component.lines = [
      "header",
      `input: hello world${CURSOR_MARKER}`,
      "status line",
    ];

    (tui as any).doRender();

    assert.ok(terminal.writtenData.length >= 1, "typing should trigger a render");

    const buffer = terminal.writtenData[0];
    // Should not contain large upward jumps (3+ rows)
    const largeUpJump = buffer.match(/\x1b\[([3-9]|\d{2,})A/);
    assert.strictEqual(
      largeUpJump,
      null,
      `should not produce large upward cursor jumps, got: ${JSON.stringify(buffer)}`,
    );
  });

  it("handles editor-to-selector swap without cursor corruption", () => {
    // Simulates /gsd prefs: editor with CURSOR_MARKER is replaced by
    // a selector component (no CURSOR_MARKER) that has different line count.
    const terminal = new MockTTYTerminal();
    const tui = new TUI(terminal, false);

    // Initial state: chat + editor with cursor marker (typical idle state)
    const chatLines = Array.from({ length: 15 }, (_, i) => `chat line ${i}`);
    const editorComponent = new DynamicLinesComponent([
      ...chatLines,
      `> ${CURSOR_MARKER}`,  // editor input line with cursor
    ]);

    tui.addChild(editorComponent);
    (tui as any).doRender();

    // Cursor should be at the CURSOR_MARKER line (row 15)
    assert.strictEqual(
      (tui as any).hardwareCursorRow,
      15,
      "hardwareCursorRow should be at editor cursor position (row 15)",
    );

    // Now swap editor for selector (simulating showExtensionSelector)
    terminal.writtenData = [];
    editorComponent.lines = [
      ...chatLines,
      "─── Select preference ───",
      "→ Model routing",
      "  Timeouts",
      "  Budget",
      "  Cancel",
      "─────────────────────────",
    ];

    (tui as any).doRender();

    assert.ok(terminal.writtenData.length >= 1, "selector render should produce output");

    const buffer = terminal.writtenData[0];
    // Verify no extremely large cursor jumps that would cause visual corruption
    const hugeJump = buffer.match(/\x1b\[(\d{2,})A/);
    if (hugeJump) {
      const jumpSize = parseInt(hugeJump[1], 10);
      assert.ok(
        jumpSize < 20,
        `cursor jump of ${jumpSize} rows is too large — likely a baseline desync, got: ${JSON.stringify(buffer.slice(0, 200))}`,
      );
    }

    // hardwareCursorRow should NOT be at old IME position
    // since there's no CURSOR_MARKER in the selector
    const hwRow = (tui as any).hardwareCursorRow;
    assert.ok(
      hwRow >= 15 && hwRow <= 20,
      `hardwareCursorRow should be at rendered content (${hwRow}), not stuck at old IME position`,
    );

    // Now simulate user pressing ↓ in selector (one line changes)
    terminal.writtenData = [];
    editorComponent.lines = [
      ...chatLines,
      "─── Select preference ───",
      "  Model routing",
      "→ Timeouts",
      "  Budget",
      "  Cancel",
      "─────────────────────────",
    ];

    (tui as any).doRender();

    if (terminal.writtenData.length > 0) {
      const navBuffer = terminal.writtenData[0];
      // The differential render should only update the 2 changed lines (16 and 17)
      // Verify no large upward jumps from wrong baseline
      const navJump = navBuffer.match(/\x1b\[(\d{2,})A/);
      if (navJump) {
        const jumpSize = parseInt(navJump[1], 10);
        assert.ok(
          jumpSize < 20,
          `navigation caused jump of ${jumpSize} rows — cursor baseline may be wrong`,
        );
      }
    }
  });

  it("handles selector-to-editor swap restoring cursor correctly", () => {
    // After dismissing a selector, the editor returns with CURSOR_MARKER.
    // The cursor must move to the new marker position without corruption.
    const terminal = new MockTTYTerminal();
    const tui = new TUI(terminal, false);

    const chatLines = Array.from({ length: 10 }, (_, i) => `chat ${i}`);
    const component = new DynamicLinesComponent([
      ...chatLines,
      "─── Selector ───",
      "→ Option A",
      "  Option B",
      "────────────────",
    ]);

    tui.addChild(component);
    (tui as any).doRender();

    // No CURSOR_MARKER → cursor stays at last rendered line
    const hwRowAfterSelector = (tui as any).hardwareCursorRow;

    // Swap back to editor with CURSOR_MARKER
    terminal.writtenData = [];
    component.lines = [
      ...chatLines,
      `> ${CURSOR_MARKER}`,
    ];

    (tui as any).doRender();

    // CURSOR_MARKER is at row 10 — cursor should be positioned there
    assert.strictEqual(
      (tui as any).hardwareCursorRow,
      10,
      "hardwareCursorRow should move to editor cursor after selector dismiss",
    );
  });

  it("handles input component swap (prefs wizard text input)", () => {
    // Simulates /gsd prefs input step: selector replaced by text input with cursor
    const terminal = new MockTTYTerminal();
    const tui = new TUI(terminal, false);

    const chatLines = Array.from({ length: 8 }, (_, i) => `msg ${i}`);
    const component = new DynamicLinesComponent([
      ...chatLines,
      "─── Enter value ───",
      `Value: ${CURSOR_MARKER}`,
      "───────────────────",
    ]);

    tui.addChild(component);
    (tui as any).doRender();

    assert.strictEqual(
      (tui as any).hardwareCursorRow,
      9,
      "hardwareCursorRow should be at input cursor (row 9)",
    );

    // Simulate typing in the input
    terminal.writtenData = [];
    component.lines = [
      ...chatLines,
      "─── Enter value ───",
      `Value: hello${CURSOR_MARKER}`,
      "───────────────────",
    ];

    (tui as any).doRender();

    assert.ok(terminal.writtenData.length >= 1, "typing should trigger render");

    const buffer = terminal.writtenData[0];
    // Should not jump to wrong row — only line 9 changed
    const upJump = buffer.match(/\x1b\[(\d+)A/);
    if (upJump) {
      const jumpSize = parseInt(upJump[1], 10);
      // Cursor was at row 9 (IME), need to go to row 9 (changed line) = no jump needed
      assert.ok(jumpSize <= 1, `typing in input caused unexpected up-jump of ${jumpSize}`);
    }

    assert.strictEqual(
      (tui as any).hardwareCursorRow,
      9,
      "hardwareCursorRow should stay at input cursor after typing",
    );
  });

  it("hardwareCursorRow tracks actual terminal position through IME and shrink", () => {
    const terminal = new MockTTYTerminal();
    const tui = new TUI(terminal, false);
    const component = new DynamicLinesComponent([
      "line 1",
      `line 2${CURSOR_MARKER}`,
      "line 3",
      "line 4",
      "line 5",
    ]);

    tui.addChild(component);
    (tui as any).doRender();

    // After IME positioning, hardwareCursorRow is at CURSOR_MARKER line (row 1)
    assert.strictEqual(
      (tui as any).hardwareCursorRow,
      1,
      "hardwareCursorRow should be at IME position (row 1) after first render",
    );

    // Shrink content
    terminal.writtenData = [];
    component.lines = [
      "line 1",
      `line 2${CURSOR_MARKER}`,
      "line 3",
    ];

    (tui as any).doRender();

    // After shrink, hardwareCursorRow should be at IME position again
    assert.strictEqual(
      (tui as any).hardwareCursorRow,
      1,
      "hardwareCursorRow should be at IME position after shrink render",
    );
  });
});
