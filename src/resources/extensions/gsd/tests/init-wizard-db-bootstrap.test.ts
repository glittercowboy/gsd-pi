import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createTestContext } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const srcPath = join(import.meta.dirname, "..", "init-wizard.ts");
const src = readFileSync(srcPath, "utf-8");

console.log("\n=== #3880: gsd.db created during fresh bootstrap ===");

// 1. ensureDbOpen is imported from dynamic-tools
const importIdx = src.indexOf('import("./bootstrap/dynamic-tools.js")');
assertTrue(importIdx >= 0, "init-wizard.ts imports dynamic-tools for ensureDbOpen (#3880)");

// 2. ensureDbOpen() is called
const callIdx = src.indexOf("ensureDbOpen()");
assertTrue(callIdx >= 0, "init-wizard.ts calls ensureDbOpen() (#3880)");

// 3. ensureDbOpen() is called AFTER bootstrapGsdDirectory()
const bootstrapIdx = src.indexOf("bootstrapGsdDirectory(");
assertTrue(bootstrapIdx >= 0, "init-wizard.ts calls bootstrapGsdDirectory()");
assertTrue(
  callIdx > bootstrapIdx,
  "ensureDbOpen() is called after bootstrapGsdDirectory() so .gsd/ exists (#3880)",
);

// 4. The call is wrapped in try/catch (non-fatal)
const ensureRegionStart = src.lastIndexOf("try", callIdx);
const ensureRegionEnd = callIdx;
const tryBeforeEnsure = ensureRegionStart >= 0 && ensureRegionEnd - ensureRegionStart < 200;
assertTrue(
  tryBeforeEnsure,
  "ensureDbOpen() is wrapped in try/catch so failure does not block init (#3880)",
);

report();
