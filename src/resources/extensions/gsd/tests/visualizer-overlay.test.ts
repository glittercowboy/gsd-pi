/**
 * GSD visualizer overlay — behaviour tests.
 *
 * These tests drive the overlay through its public surface:
 *   - construct an instance
 *   - feed input events (keystrokes, SGR mouse sequences)
 *   - observe the rendered line array and mutable state
 *
 * The previous version of this file was 39 `overlaySrc.includes(...)`
 * assertions — a pure source-grep. Replaced with behaviour-driven tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { GSDVisualizerOverlay } from "../visualizer-overlay.ts";

function makeTui() {
  const renders: number[] = [];
  return {
    renders,
    tui: {
      requestRender: () => {
        renders.push(Date.now());
      },
    },
  };
}

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function makeOverlay(t: { after: (fn: () => void) => void }, onClose: () => void = () => {}) {
  const { tui, renders } = makeTui();
  const overlay = new GSDVisualizerOverlay(tui as any, mockTheme, onClose);
  t.after(() => overlay.dispose());
  return { overlay, renders };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Tab bar rendering ───────────────────────────────────────────────────

test("overlay renders 10 tabs (Progress, Timeline, Deps, Metrics, Health, Agent, Changes, Knowledge, Captures, Export)", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.loading = true; // body shows loading text, but tab bar renders regardless

  // Use a very wide terminal so the tab bar is not truncated.
  const lines = overlay.render(200).map(stripAnsi);
  const tabBar = lines.find((l) => l.includes("Progress") && l.includes("Export"));
  assert.ok(tabBar, `expected a tab-bar line containing all labels, got:\n${lines.slice(0, 5).join("\n")}`);
  for (const label of ["Progress", "Timeline", "Deps", "Metrics", "Health", "Agent", "Changes", "Knowledge", "Captures", "Export"]) {
    assert.ok(tabBar!.includes(label), `tab bar missing label ${label}`);
  }
});

test("overlay shows a Captures badge count when pending captures are present", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.loading = true;
  overlay.data = { captures: { pendingCount: 7 } } as any;

  const lines = overlay.render(120).map(stripAnsi);
  const tabBar = lines.find((l) => l.includes("Captures"))!;
  assert.ok(tabBar.includes("(7)"), `captures tab should carry (7) badge, got: ${tabBar}`);
});

// ─── Tab switching via digit keys ────────────────────────────────────────

test("overlay switches tabs via 1–9,0 digit keys", (t) => {
  const { overlay } = makeOverlay(t);

  const cases: Array<[string, number]> = [
    ["1", 0],
    ["2", 1],
    ["3", 2],
    ["4", 3],
    ["5", 4],
    ["6", 5],
    ["7", 6],
    ["8", 7],
    ["9", 8],
    ["0", 9],
  ];
  for (const [key, expected] of cases) {
    overlay.handleInput(key);
    assert.equal(overlay.activeTab, expected, `key ${key} should select tab ${expected}`);
  }
});

test("overlay Tab key cycles forward and wraps around at TAB_COUNT", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.activeTab = 9;
  overlay.handleInput("\t");
  assert.equal(overlay.activeTab, 0, "Tab wraps from 9 back to 0");
});

test("overlay Shift+Tab cycles backward and wraps", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.activeTab = 0;
  overlay.handleInput("\u001b[Z");
  assert.equal(overlay.activeTab, 9, "Shift+Tab wraps from 0 to 9");
});

// ─── Filter mode ─────────────────────────────────────────────────────────

test("overlay / enters filter mode and typed characters accumulate in filterText", (t) => {
  const { overlay } = makeOverlay(t);
  assert.equal(overlay.filterMode, false, "starts out of filter mode");
  assert.equal(overlay.filterText, "", "starts with empty filter text");

  overlay.handleInput("/");
  assert.equal(overlay.filterMode, true, "/ enters filter mode");

  overlay.handleInput("f");
  overlay.handleInput("o");
  overlay.handleInput("o");
  assert.equal(overlay.filterText, "foo");

  overlay.handleInput("\r"); // enter — exits filter mode
  assert.equal(overlay.filterMode, false, "Enter exits filter mode");
  assert.equal(overlay.filterText, "foo", "filter text persists after exit");
});

test("overlay filter backspace deletes last character", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.handleInput("/");
  overlay.handleInput("a");
  overlay.handleInput("b");
  overlay.handleInput("c");
  overlay.handleInput("\u007f"); // backspace
  assert.equal(overlay.filterText, "ab");
});

test("overlay f key cycles filter field on Progress tab: all → status → risk → keyword → all", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.activeTab = 0;
  assert.equal(overlay.filterField, "all");
  overlay.handleInput("f");
  assert.equal(overlay.filterField, "status");
  overlay.handleInput("f");
  assert.equal(overlay.filterField, "risk");
  overlay.handleInput("f");
  assert.equal(overlay.filterField, "keyword");
  overlay.handleInput("f");
  assert.equal(overlay.filterField, "all", "cycles back to all");
});

test("overlay f key on non-Progress tabs only toggles all ↔ keyword", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.activeTab = 2; // Deps tab
  overlay.filterField = "all";
  overlay.handleInput("f");
  assert.equal(overlay.filterField, "keyword");
  overlay.handleInput("f");
  assert.equal(overlay.filterField, "all");
});

// ─── Help overlay ────────────────────────────────────────────────────────

test("overlay ? key shows help, and pressing ? again dismisses it in-place", (t) => {
  let closed = false;
  const { overlay } = makeOverlay(t, () => {
    closed = true;
  });

  overlay.handleInput("?");
  assert.equal(overlay.showHelp, true, "? toggles help on");

  overlay.handleInput("?");
  assert.equal(overlay.showHelp, false, "? pressed again dismisses help");
  assert.equal(closed, false, "toggling help does not close the overlay");
});

// ─── Escape / Ctrl+C close behaviour ─────────────────────────────────────

test("overlay Escape closes when no sub-mode is active", (t) => {
  let closed = false;
  const { overlay } = makeOverlay(t, () => {
    closed = true;
  });
  overlay.handleInput("\u001b");
  assert.equal(closed, true);
});

test("overlay Ctrl+C closes even while filter mode is active", (t) => {
  let closed = false;
  const { overlay } = makeOverlay(t, () => {
    closed = true;
  });
  overlay.filterMode = true;
  overlay.handleInput("\u0003"); // Ctrl+C
  assert.equal(closed, true, "Ctrl+C must close even in filter mode");
});

test("overlay Escape closes even when help is visible (top-level Escape short-circuits)", (t) => {
  let closed = false;
  const { overlay } = makeOverlay(t, () => {
    closed = true;
  });
  overlay.showHelp = true;
  overlay.handleInput("\u001b");
  assert.equal(closed, true, "Escape calls onClose regardless of sub-mode");
});

// ─── Scroll behaviour ────────────────────────────────────────────────────

test("overlay j / Down scrolls one line forward, k / Up scrolls back", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.activeTab = 1;
  overlay.scrollOffsets[1] = 5;

  overlay.handleInput("j");
  assert.equal(overlay.scrollOffsets[1], 6);

  overlay.handleInput("k");
  assert.equal(overlay.scrollOffsets[1], 5);

  overlay.handleInput("\u001b[B"); // Down arrow
  assert.equal(overlay.scrollOffsets[1], 6);

  overlay.handleInput("\u001b[A"); // Up arrow
  assert.equal(overlay.scrollOffsets[1], 5);
});

test("overlay k / Up does not scroll below zero", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.scrollOffsets[0] = 0;
  overlay.handleInput("k");
  assert.equal(overlay.scrollOffsets[0], 0);
});

test("overlay g jumps to top, G jumps to bottom-sentinel", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.scrollOffsets[0] = 50;
  overlay.handleInput("g");
  assert.equal(overlay.scrollOffsets[0], 0);
  overlay.handleInput("G");
  assert.ok(overlay.scrollOffsets[0] >= 100, "G sets a large offset sentinel");
});

test("overlay Ctrl+U / Ctrl+D scroll half-page", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.scrollOffsets[0] = 100;
  overlay.handleInput("\u0004"); // Ctrl+D
  assert.ok(
    overlay.scrollOffsets[0] > 100,
    `Ctrl+D should move forward, got ${overlay.scrollOffsets[0]}`,
  );
  const afterDown = overlay.scrollOffsets[0];
  overlay.handleInput("\u0015"); // Ctrl+U
  assert.ok(
    overlay.scrollOffsets[0] < afterDown,
    "Ctrl+U should move backward",
  );
});

test("overlay PageUp / PageDown scroll one viewport", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.scrollOffsets[0] = 50;
  overlay.handleInput("\u001b[6~"); // Page Down
  assert.ok(overlay.scrollOffsets[0] > 50);
  const after = overlay.scrollOffsets[0];
  overlay.handleInput("\u001b[5~"); // Page Up
  assert.ok(overlay.scrollOffsets[0] < after);
});

// ─── Mouse wheel + click ─────────────────────────────────────────────────

test("overlay SGR mouse wheel up/down scrolls active tab", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.scrollOffsets[0] = 20;
  // SGR mouse wheel down: button 65
  overlay.handleInput("\u001b[<65;10;10M");
  assert.equal(overlay.scrollOffsets[0], 23, "wheel-down scrolls +3");
  // Wheel up: button 64
  overlay.handleInput("\u001b[<64;10;10M");
  assert.equal(overlay.scrollOffsets[0], 20, "wheel-up scrolls −3");
});

test("overlay click on Captures tab badge selects that tab", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.loading = true;
  overlay.data = { captures: { pendingCount: 3 } } as any;

  const lines = overlay.render(120);
  const tabLine = lines.find((line) => line.includes("Captures") && line.includes("(3)"))!;
  assert.ok(tabLine, "rendered tab bar includes captures badge");
  const plain = stripAnsi(tabLine);
  const badgeColumn = plain.indexOf("(3)") + 2;
  overlay.handleInput(`\u001b[<0;${badgeColumn};2M`);
  assert.equal(overlay.activeTab, 8, "clicking the badge area selects the captures tab");
});

// ─── Collapse state on Progress tab ──────────────────────────────────────

test("overlay exposes collapsedMilestones set for Progress-tab collapse tracking", (t) => {
  const { overlay } = makeOverlay(t);
  assert.ok(overlay.collapsedMilestones instanceof Set);
  assert.equal(overlay.collapsedMilestones.size, 0);
});

// ─── Loading state rendering ─────────────────────────────────────────────

test("overlay renders a Loading… marker when no data is loaded yet", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.loading = true;

  const lines = overlay.render(120).map(stripAnsi);
  assert.ok(
    lines.some((l) => l.includes("Loading")),
    "expected Loading… indicator in render output",
  );
});

// ─── Footer hint ─────────────────────────────────────────────────────────

test("overlay footer hint mentions tab navigation, filter, scroll, and help", (t) => {
  const { overlay } = makeOverlay(t);
  overlay.loading = true;

  const lines = overlay.render(120).map(stripAnsi).join("\n");
  assert.ok(lines.includes("1-9,0"), "footer shows 1-9,0 tab range hint");
  assert.ok(lines.includes("PgUp/PgDn") || lines.includes("PgUp"), "footer mentions PgUp/PgDn");
  assert.ok(lines.includes("? help"), "footer mentions ? help");
  assert.ok(lines.includes("/"), "footer mentions / for filter");
});

// ─── Scroll offsets array is sized to TAB_COUNT ──────────────────────────

test("overlay scrollOffsets array has one slot per tab (10 tabs total)", (t) => {
  const { overlay } = makeOverlay(t);
  assert.equal(overlay.scrollOffsets.length, 10, "scrollOffsets sized to TAB_COUNT=10");
  assert.ok(overlay.scrollOffsets.every((n: number) => n === 0), "initialized to zero");
});

// ─── Dispose cleanup ─────────────────────────────────────────────────────

test("overlay dispose is idempotent and flips the disposed flag", (t) => {
  const { tui } = makeTui();
  const overlay = new GSDVisualizerOverlay(tui as any, mockTheme, () => {});
  // Ensure constructor-owned resources are released even if an assertion
  // below fails — dispose() is documented as idempotent, so a teardown
  // call after the body's explicit dispose is a no-op.
  t.after(() => {
    try { overlay.dispose(); } catch { /* already disposed */ }
  });

  // Sanity: disposed flag flips
  assert.equal(overlay.disposed, false);
  overlay.dispose();
  assert.equal(overlay.disposed, true);

  // Calling dispose again is safe (no throw)
  overlay.dispose();
});
