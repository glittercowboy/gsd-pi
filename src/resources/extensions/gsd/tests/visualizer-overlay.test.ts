// Behavioral unit tests for GSDVisualizerOverlay.
// Tests exercise handleInput() and assert on state — no source-reading.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GSDVisualizerOverlay } from "../visualizer-overlay.ts";

describe("GSDVisualizerOverlay", () => {
  let overlay: GSDVisualizerOverlay;
  let renderCalls: number;
  let closed: boolean;

  beforeEach(() => {
    renderCalls = 0;
    closed = false;
    const tui = { requestRender: () => { renderCalls++; } };
    const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s } as any;
    overlay = new GSDVisualizerOverlay(tui, theme, () => { closed = true; });
  });

  afterEach(() => {
    if (!overlay.disposed) overlay.dispose();
  });

  // ─── 1. Tab switching via number keys ──────────────────────────────────────

  it("key '1' sets activeTab to 0 and calls requestRender", () => {
    overlay.activeTab = 5;
    const before = renderCalls;
    overlay.handleInput("1");
    assert.equal(overlay.activeTab, 0);
    assert.ok(renderCalls > before);
  });

  it("key '2' sets activeTab to 1", () => {
    overlay.handleInput("2");
    assert.equal(overlay.activeTab, 1);
  });

  it("key '9' sets activeTab to 8", () => {
    overlay.handleInput("9");
    assert.equal(overlay.activeTab, 8);
  });

  it("key '0' sets activeTab to 9", () => {
    overlay.handleInput("0");
    assert.equal(overlay.activeTab, 9);
  });

  it("each number key triggers requestRender", () => {
    const before = renderCalls;
    for (const k of "1234567890") overlay.handleInput(k);
    assert.ok(renderCalls > before);
  });

  // ─── 2. Tab cycling via Tab / Shift+Tab ────────────────────────────────────

  it("Tab key advances activeTab by 1", () => {
    overlay.activeTab = 0;
    overlay.handleInput("\t");
    assert.equal(overlay.activeTab, 1);
  });

  it("Tab key wraps from tab 9 to tab 0", () => {
    overlay.activeTab = 9;
    overlay.handleInput("\t");
    assert.equal(overlay.activeTab, 0);
  });

  it("Shift+Tab wraps from tab 0 to tab 9", () => {
    overlay.activeTab = 0;
    overlay.handleInput("\x1b[Z");
    assert.equal(overlay.activeTab, 9);
  });

  it("Shift+Tab decrements activeTab from 3 to 2", () => {
    overlay.activeTab = 3;
    overlay.handleInput("\x1b[Z");
    assert.equal(overlay.activeTab, 2);
  });

  // ─── 3. Filter mode entry and text editing ─────────────────────────────────

  it("'/' enters filter mode with empty filterText", () => {
    overlay.handleInput("/");
    assert.equal(overlay.filterMode, true);
    assert.equal(overlay.filterText, "");
  });

  it("typing while in filter mode accumulates filterText", () => {
    overlay.handleInput("/");
    for (const ch of "hello") overlay.handleInput(ch);
    assert.equal(overlay.filterText, "hello");
  });

  it("backspace in filter mode removes last character", () => {
    overlay.handleInput("/");
    overlay.handleInput("a");
    overlay.handleInput("b");
    overlay.handleInput("\x7f");
    assert.equal(overlay.filterText, "a");
  });

  it("escape in filter mode clears filterMode and filterText", () => {
    overlay.handleInput("/");
    overlay.handleInput("x");
    overlay.handleInput("\x1b");
    assert.equal(overlay.filterMode, false);
    assert.equal(overlay.filterText, "");
  });

  it("enter in filter mode exits filter mode but preserves filterText", () => {
    overlay.handleInput("/");
    for (const ch of "test") overlay.handleInput(ch);
    overlay.handleInput("\r");
    assert.equal(overlay.filterMode, false);
    assert.equal(overlay.filterText, "test");
  });

  // ─── 4. Filter field cycling with "f" ──────────────────────────────────────

  it("'f' on tab 0 cycles: all → status → risk → keyword → all", () => {
    overlay.activeTab = 0;
    assert.equal(overlay.filterField, "all");
    overlay.handleInput("f");
    assert.equal(overlay.filterField, "status");
    overlay.handleInput("f");
    assert.equal(overlay.filterField, "risk");
    overlay.handleInput("f");
    assert.equal(overlay.filterField, "keyword");
    overlay.handleInput("f");
    assert.equal(overlay.filterField, "all");
  });

  it("'f' on tab 1 cycles: all → keyword → all", () => {
    overlay.activeTab = 1;
    assert.equal(overlay.filterField, "all");
    overlay.handleInput("f");
    assert.equal(overlay.filterField, "keyword");
    overlay.handleInput("f");
    assert.equal(overlay.filterField, "all");
  });

  it("'f' on tab 5 cycles: all → keyword → all", () => {
    overlay.activeTab = 5;
    overlay.handleInput("f");
    assert.equal(overlay.filterField, "keyword");
    overlay.handleInput("f");
    assert.equal(overlay.filterField, "all");
  });

  // ─── 5. Help overlay ───────────────────────────────────────────────────────

  it("'?' sets showHelp to true", () => {
    overlay.handleInput("?");
    assert.equal(overlay.showHelp, true);
  });

  it("'?' while showHelp is true sets showHelp to false", () => {
    overlay.showHelp = true;
    overlay.handleInput("?");
    assert.equal(overlay.showHelp, false);
  });

  it("escape while showHelp is true sets showHelp to false", () => {
    overlay.showHelp = true;
    overlay.handleInput("\x1b");
    assert.equal(overlay.showHelp, false);
  });

  it("other keys while showHelp is true are absorbed (activeTab unchanged)", () => {
    overlay.activeTab = 2;
    overlay.showHelp = true;
    overlay.handleInput("1");
    assert.equal(overlay.activeTab, 2);
  });

  // ─── 6. Scroll clamp — never below 0 ──────────────────────────────────────

  it("pageUp at offset 0 stays at 0", () => {
    overlay.scrollOffsets[overlay.activeTab] = 0;
    overlay.handleInput("\x1b[5~");
    assert.equal(overlay.scrollOffsets[overlay.activeTab], 0);
  });

  it("ctrl+u at offset 0 stays at 0", () => {
    overlay.scrollOffsets[overlay.activeTab] = 0;
    overlay.handleInput("\x15");
    assert.equal(overlay.scrollOffsets[overlay.activeTab], 0);
  });

  it("up arrow at offset 0 stays at 0", () => {
    overlay.scrollOffsets[overlay.activeTab] = 0;
    overlay.handleInput("\x1b[A");
    assert.equal(overlay.scrollOffsets[overlay.activeTab], 0);
  });

  it("'k' at offset 0 stays at 0", () => {
    overlay.scrollOffsets[overlay.activeTab] = 0;
    overlay.handleInput("k");
    assert.equal(overlay.scrollOffsets[overlay.activeTab], 0);
  });

  // ─── 7. Scroll down then up ────────────────────────────────────────────────

  it("pageDown increases scroll offset", () => {
    const tab = overlay.activeTab;
    overlay.scrollOffsets[tab] = 0;
    overlay.handleInput("\x1b[6~");
    assert.ok(overlay.scrollOffsets[tab] > 0);
  });

  it("pageDown then pageUp returns offset to 0", () => {
    const tab = overlay.activeTab;
    overlay.scrollOffsets[tab] = 0;
    overlay.handleInput("\x1b[6~");
    overlay.handleInput("\x1b[5~");
    assert.equal(overlay.scrollOffsets[tab], 0);
  });

  // ─── 8. Close on escape / ctrl+c ───────────────────────────────────────────

  it("escape when not in filter mode and not in help calls onClose", () => {
    assert.equal(closed, false);
    overlay.handleInput("\x1b");
    assert.equal(closed, true);
  });

  it("ctrl+c calls onClose", () => {
    overlay.handleInput("\x03");
    assert.equal(closed, true);
  });

  // ─── 9. Filter mode blocks global keys ────────────────────────────────────

  it("tab key in filter mode does not change activeTab", () => {
    overlay.activeTab = 0;
    overlay.handleInput("/");
    overlay.handleInput("\t");
    assert.equal(overlay.activeTab, 0);
  });

  it("number keys in filter mode append to filterText, not switch tab", () => {
    overlay.activeTab = 0;
    overlay.handleInput("/");
    overlay.handleInput("3");
    assert.equal(overlay.filterText, "3");
    assert.equal(overlay.activeTab, 0);
  });

  // ─── 10. Tab-specific scroll state ────────────────────────────────────────

  it("scrolling on tab 0 does not affect tab 1 scroll offset", () => {
    overlay.activeTab = 0;
    overlay.handleInput("\x1b[6~");
    assert.ok(overlay.scrollOffsets[0] > 0);
    assert.equal(overlay.scrollOffsets[1], 0);
  });

  it("each tab maintains independent scroll state", () => {
    overlay.activeTab = 0;
    overlay.handleInput("\x1b[6~");
    overlay.handleInput("\x1b[6~");
    overlay.handleInput("2"); // switch to tab index 1
    overlay.handleInput("\x1b[6~");
    assert.ok(overlay.scrollOffsets[0] > overlay.scrollOffsets[1]);
  });
});
