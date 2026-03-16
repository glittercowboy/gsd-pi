// Tests for GSD visualizer overlay.
// Verifies filter mode, tab switching, and export key handling.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestContext } from "./test-helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { assertTrue, assertEq, report } = createTestContext();

const overlaySrc = readFileSync(join(__dirname, "..", "visualizer-overlay.ts"), "utf-8");

console.log("\n=== Overlay: Tab Configuration ===");

assertTrue(
  overlaySrc.includes("TAB_COUNT = 7"),
  "TAB_COUNT is 7",
);

assertTrue(
  overlaySrc.includes('"1 Progress"'),
  "has Progress tab label",
);

assertTrue(
  overlaySrc.includes('"5 Agent"'),
  "has Agent tab label",
);

assertTrue(
  overlaySrc.includes('"6 Changes"'),
  "has Changes tab label",
);

assertTrue(
  overlaySrc.includes('"7 Export"'),
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

// Supports 1-7 keys
assertTrue(
  overlaySrc.includes('"1234567"'),
  "supports keys 1-7 for tab switching",
);

// Tab wraps with TAB_COUNT
assertTrue(
  overlaySrc.includes("% TAB_COUNT"),
  "tab key wraps around TAB_COUNT",
);

console.log("\n=== Overlay: Export Key Interception ===");

assertTrue(
  overlaySrc.includes("activeTab === 6"),
  "export key handling checks for tab 7 (index 6)",
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
  overlaySrc.includes("Tab/1-7"),
  "footer hint shows 1-7 tab range",
);

assertTrue(
  overlaySrc.includes("/ filter"),
  "footer hint mentions filter",
);

console.log("\n=== Overlay: Scroll Offsets ===");

assertTrue(
  overlaySrc.includes(`new Array(TAB_COUNT).fill(0)`),
  "scroll offsets sized to TAB_COUNT",
);

report();
