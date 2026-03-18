// Tests for GSD visualizer overlay.
// Verifies filter mode, tab switching, mouse support, page scroll, help overlay, and 10-tab config.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestContext } from "./test-helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { assertTrue, assertEq, report } = createTestContext();

const overlaySrc = readFileSync(join(__dirname, "..", "visualizer-overlay.ts"), "utf-8");

console.log("\n=== Overlay: Tab Configuration ===");

assertTrue(
  overlaySrc.includes("TAB_COUNT = 10"),
  "TAB_COUNT is 10",
);

assertTrue(
  overlaySrc.includes('"1 Progress"'),
  "has Progress tab label",
);

assertTrue(
  overlaySrc.includes('"2 Timeline"'),
  "has Timeline tab label",
);

assertTrue(
  overlaySrc.includes('"3 Deps"'),
  "has Deps tab label",
);

assertTrue(
  overlaySrc.includes('"5 Health"'),
  "has Health tab label",
);

assertTrue(
  overlaySrc.includes('"6 Agent"'),
  "has Agent tab label",
);

assertTrue(
  overlaySrc.includes('"7 Changes"'),
  "has Changes tab label",
);

assertTrue(
  overlaySrc.includes('"8 Knowledge"'),
  "has Knowledge tab label",
);

assertTrue(
  overlaySrc.includes('"9 Captures"'),
  "has Captures tab label",
);

assertTrue(
  overlaySrc.includes('"0 Export"'),
  "has Export tab label",
);

console.log("\n=== Overlay: Filter Mode ===");

assertTrue(
  overlaySrc.includes('filterMode = false'),
  "filterMode initialized to false",
);

assertTrue(
  overlaySrc.includes('filterText = ""'),
  "filterText initialized to empty string",
);

assertTrue(
  overlaySrc.includes('filterField:'),
  "has filterField state",
);

// Filter mode entry via "/"
assertTrue(
  overlaySrc.includes('data === "/"') || overlaySrc.includes("data === '/'"),
  "/ key enters filter mode",
);

// Filter field cycling via "f"
assertTrue(
  overlaySrc.includes('data === "f"') || overlaySrc.includes("data === 'f'"),
  "f key cycles filter field",
);

console.log("\n=== Overlay: Tab Switching ===");

// Supports 1-9,0 keys
assertTrue(
  overlaySrc.includes('"1234567890"'),
  "supports keys 1-9,0 for tab switching",
);

// Tab wraps with TAB_COUNT
assertTrue(
  overlaySrc.includes("% TAB_COUNT"),
  "tab key wraps around TAB_COUNT",
);

assertTrue(
  overlaySrc.includes('Key.shift("tab")') || overlaySrc.includes("Key.shift('tab')"),
  "supports Shift+Tab for reverse tab switching",
);

console.log("\n=== Overlay: Page/Half-Page Scroll ===");

assertTrue(
  overlaySrc.includes("Key.pageUp"),
  "has Key.pageUp handler",
);

assertTrue(
  overlaySrc.includes("Key.pageDown"),
  "has Key.pageDown handler",
);

assertTrue(
  overlaySrc.includes('Key.ctrl("u")'),
  "has Ctrl+U half-page scroll",
);

assertTrue(
  overlaySrc.includes('Key.ctrl("d")'),
  "has Ctrl+D half-page scroll",
);

console.log("\n=== Overlay: Mouse Support ===");

assertTrue(
  overlaySrc.includes("parseSGRMouse"),
  "has parseSGRMouse method",
);

assertTrue(
  overlaySrc.includes("?1003h"),
  "enables mouse tracking in constructor",
);

assertTrue(
  overlaySrc.includes("?1003l"),
  "disables mouse tracking in dispose",
);

console.log("\n=== Overlay: Collapsible Milestones ===");

assertTrue(
  overlaySrc.includes("collapsedMilestones"),
  "has collapsedMilestones state",
);

console.log("\n=== Overlay: Help Overlay ===");

assertTrue(
  overlaySrc.includes("showHelp"),
  "has showHelp state",
);

assertTrue(
  overlaySrc.includes('data === "?"'),
  "? key toggles help",
);

console.log("\n=== Overlay: Export Key Interception ===");

assertTrue(
  overlaySrc.includes("activeTab === 9"),
  "export key handling checks for tab 0 (index 9)",
);

assertTrue(
  overlaySrc.includes('handleExportKey'),
  "has handleExportKey method",
);

assertTrue(
  overlaySrc.includes('"m"') && overlaySrc.includes('"j"') && overlaySrc.includes('"s"'),
  "handles m, j, s keys for export",
);

console.log("\n=== Overlay: Footer ===");

assertTrue(
  overlaySrc.includes("1-9,0"),
  "footer hint shows 1-9,0 tab range",
);

assertTrue(
  overlaySrc.includes("PgUp/PgDn"),
  "footer hint mentions PgUp/PgDn",
);

assertTrue(
  overlaySrc.includes("? help"),
  "footer hint mentions ? for help",
);

console.log("\n=== Overlay: Scroll Offsets ===");

assertTrue(
  overlaySrc.includes(`new Array(TAB_COUNT).fill(0)`),
  "scroll offsets sized to TAB_COUNT",
);

console.log("\n=== Overlay: Terminal Resize Handling ===");

assertTrue(
  overlaySrc.includes('resizeHandler'),
  "has resizeHandler property",
);

assertTrue(
  overlaySrc.includes('"resize"'),
  "listens for resize events",
);

assertTrue(
  overlaySrc.includes('removeListener("resize"'),
  "removes resize listener on dispose",
);

console.log("\n=== Overlay: Shared Imports ===");

assertTrue(
  overlaySrc.includes('from "../shared/mod.js"'),
  "imports from shared barrel",
);

report();
