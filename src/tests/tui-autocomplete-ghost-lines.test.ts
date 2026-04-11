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

describe("TUI autocomplete shrink clearing (#3721)", () => {
  it("clears deleted autocomplete rows relative to the content bottom, not the IME cursor row", () => {
    const terminal = new MockTTYTerminal();
    const tui = new TUI(terminal, false);
    const component = new DynamicLinesComponent([
      "top border",
      `prompt${CURSOR_MARKER}`,
      "editor body",
      "autocomplete row 1",
      "autocomplete row 2",
      "autocomplete row 3",
    ]);

    tui.addChild(component);
    (tui as any).doRender();

    terminal.writtenData = [];
    component.lines = [
      "top border",
      `prompt${CURSOR_MARKER}`,
      "editor body",
      "autocomplete row 1",
    ];

    (tui as any).doRender();

    assert.ok(terminal.writtenData.length >= 1, "shrink render should write a differential buffer");
    // After IME positioning, cursor is at row 1 (CURSOR_MARKER line).
    // To clear deleted rows 4-5, cursor must move DOWN to content bottom (row 3),
    // then clear the extra lines below. Movement is relative to actual cursor position.
    assert.ok(
      terminal.writtenData[0].startsWith("\x1b[?2026h\x1b[2B\r"),
      `expected shrink diff to move down from IME cursor to content bottom, got ${JSON.stringify(terminal.writtenData[0])}`,
    );
  });
});
