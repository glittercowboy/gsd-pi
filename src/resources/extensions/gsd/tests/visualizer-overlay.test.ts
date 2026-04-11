// Tests for GSD visualizer overlay.
// Verifies filter mode, tab switching, mouse support, page scroll, help overlay, and 10-tab config.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

const overlaySrc = readFileSync(join(__dirname, "..", "visualizer-overlay.ts"), "utf-8");

console.log("\n=== Overlay: Tab Configuration ===");

assert.ok(
  overlaySrc.includes("TAB_COUNT = 10"),
  "TAB_COUNT is 10",
);

assert.ok(
  overlaySrc.includes('"1 Progress"'),
  "has Progress tab label",
);

assert.ok(
  overlaySrc.includes('"2 Timeline"'),
  "has Timeline tab label",
);

assert.ok(
  overlaySrc.includes('"3 Deps"'),
  "has Deps tab label",
);

assert.ok(
  overlaySrc.includes('"5 Health"'),
  "has Health tab label",
);

assert.ok(
  overlaySrc.includes('"6 Agent"'),
  "has Agent tab label",
);

assert.ok(
  overlaySrc.includes('"7 Changes"'),
  "has Changes tab label",
);

assert.ok(
  overlaySrc.includes('"8 Knowledge"'),
  "has Knowledge tab label",
);

assert.ok(
  overlaySrc.includes('"9 Captures"'),
  "has Captures tab label",
);

assert.ok(
  overlaySrc.includes('"0 Export"'),
  "has Export tab label",
);

console.log("\n=== Overlay: Filter Mode ===");

assert.ok(
  overlaySrc.includes('filterMode = false'),
  "filterMode initialized to false",
);

assert.ok(
  overlaySrc.includes('filterText = ""'),
  "filterText initialized to empty string",
);

assert.ok(
  overlaySrc.includes('filterField:'),
  "has filterField state",
);

// Filter mode entry via "/"
assert.ok(
  overlaySrc.includes('data === "/"') || overlaySrc.includes("data === '/'"),
  "/ key enters filter mode",
);

// Filter field cycling via "f"
assert.ok(
  overlaySrc.includes('data === "f"') || overlaySrc.includes("data === 'f'"),
  "f key cycles filter field",
);

console.log("\n=== Overlay: Tab Switching ===");

// Supports 1-9,0 keys
assert.ok(
  overlaySrc.includes('"1234567890"'),
  "supports keys 1-9,0 for tab switching",
);

// Tab wraps with TAB_COUNT
assert.ok(
  overlaySrc.includes("% TAB_COUNT"),
  "tab key wraps around TAB_COUNT",
);

assert.ok(
  overlaySrc.includes('Key.shift("tab")') || overlaySrc.includes("Key.shift('tab')"),
  "supports Shift+Tab for reverse tab switching",
);

console.log("\n=== Overlay: Page/Half-Page Scroll ===");

assert.ok(
  overlaySrc.includes("Key.pageUp"),
  "has Key.pageUp handler",
);

assert.ok(
  overlaySrc.includes("Key.pageDown"),
  "has Key.pageDown handler",
);

assert.ok(
  overlaySrc.includes('Key.ctrl("u")'),
  "has Ctrl+U half-page scroll",
);

assert.ok(
  overlaySrc.includes('Key.ctrl("d")'),
  "has Ctrl+D half-page scroll",
);

console.log("\n=== Overlay: Mouse Support ===");

assert.ok(
  overlaySrc.includes("parseSGRMouse"),
  "has parseSGRMouse method",
);

assert.ok(
  overlaySrc.includes("?1003h"),
  "enables mouse tracking in constructor",
);

assert.ok(
  overlaySrc.includes("?1003l"),
  "disables mouse tracking in dispose",
);

console.log("\n=== Overlay: Collapsible Milestones ===");

assert.ok(
  overlaySrc.includes("collapsedMilestones"),
  "has collapsedMilestones state",
);

console.log("\n=== Overlay: Help Overlay ===");

assert.ok(
  overlaySrc.includes("showHelp"),
  "has showHelp state",
);

assert.ok(
  overlaySrc.includes('data === "?"'),
  "? key toggles help",
);

console.log("\n=== Overlay: Export Key Interception ===");

assert.ok(
  overlaySrc.includes("activeTab === 9"),
  "export key handling checks for tab 0 (index 9)",
);

assert.ok(
  overlaySrc.includes('handleExportKey'),
  "has handleExportKey method",
);

assert.ok(
  overlaySrc.includes('"m"') && overlaySrc.includes('"j"') && overlaySrc.includes('"s"'),
  "handles m, j, s keys for export",
);

console.log("\n=== Overlay: Footer ===");

assert.ok(
  overlaySrc.includes("1-9,0"),
  "footer hint shows 1-9,0 tab range",
);

assert.ok(
  overlaySrc.includes("PgUp/PgDn"),
  "footer hint mentions PgUp/PgDn",
);

assert.ok(
  overlaySrc.includes("? help"),
  "footer hint mentions ? for help",
);

console.log("\n=== Overlay: Scroll Offsets ===");

assert.ok(
  overlaySrc.includes(`new Array(TAB_COUNT).fill(0)`),
  "scroll offsets sized to TAB_COUNT",
);

console.log("\n=== Overlay: Terminal Resize Handling ===");

assert.ok(
  overlaySrc.includes('resizeHandler'),
  "has resizeHandler property",
);

assert.ok(
  overlaySrc.includes('"resize"'),
  "listens for resize events",
);

assert.ok(
  overlaySrc.includes('removeListener("resize"'),
  "removes resize listener on dispose",
);

console.log("\n=== Overlay: Shared Imports ===");

assert.ok(
  overlaySrc.includes('from "../shared/mod.js"'),
  "imports from shared barrel",
);

test("visualizer overlay closes on escape in filter and help submodes", async () => {
  const mod = await import("../visualizer-overlay.js");

  const mockTui = { requestRender: () => {} };
  const mockTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  let closedFilter = false;
  const filterOverlay = new mod.GSDVisualizerOverlay(
    mockTui,
    mockTheme as any,
    () => { closedFilter = true; },
  );
  filterOverlay.filterMode = true;
  filterOverlay.handleInput("\u0003");
  assert.equal(closedFilter, true, "Ctrl+C closes while filter mode is active");
  filterOverlay.dispose();

  let closedHelp = false;
  const helpOverlay = new mod.GSDVisualizerOverlay(
    mockTui,
    mockTheme as any,
    () => { closedHelp = true; },
  );
  helpOverlay.showHelp = true;
  helpOverlay.handleInput("\u001b");
  assert.equal(closedHelp, true, "Escape closes while help overlay is visible");
  helpOverlay.dispose();
});

test("visualizer overlay tab hitboxes include rendered badges", async () => {
  const mod = await import("../visualizer-overlay.js");

  const mockTui = { requestRender: () => {} };
  const mockTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  const overlay = new mod.GSDVisualizerOverlay(
    mockTui,
    mockTheme as any,
    () => {},
  );
  overlay.loading = true;
  overlay.data = { captures: { pendingCount: 3 } } as any;

  const lines = overlay.render(120);
  const tabLine = lines.find((line: string) => line.includes("Captures") && line.includes("(3)"));
  assert.ok(tabLine, "rendered tab bar includes captures badge");
  const plain = tabLine!.replace(/\x1b\[[0-9;]*m/g, "");
  const badgeColumn = plain.indexOf("(3)") + 2;
  overlay.handleInput(`\x1b[<0;${badgeColumn};2M`);
  assert.equal(overlay.activeTab, 8, "clicking the badge area selects the captures tab");
  overlay.dispose();
});
