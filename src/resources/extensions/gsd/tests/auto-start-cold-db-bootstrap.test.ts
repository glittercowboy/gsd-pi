import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createTestContext } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const srcPath = join(import.meta.dirname, "..", "auto-start.ts");
const src = readFileSync(srcPath, "utf-8");

console.log("\n=== #2841: cold DB opened before initial deriveState ===");

const helperIdx = src.indexOf("async function openProjectDbIfPresent");
assertTrue(helperIdx >= 0, "auto-start.ts defines a helper for pre-derive DB open (#2841)");

const helperRegion = helperIdx >= 0 ? src.slice(helperIdx, helperIdx + 500) : "";
assertTrue(
  helperRegion.includes("resolveProjectRootDbPath(basePath)"),
  "pre-derive DB helper resolves the project-root DB path (#2841)",
);
assertTrue(
  helperRegion.includes("openDatabase(gsdDbPath)"),
  "pre-derive DB helper opens the resolved DB path (#2841)",
);

const firstDeriveIdx = src.indexOf("let state = await deriveState(base);");
assertTrue(firstDeriveIdx > 0, "auto-start.ts has the initial deriveState(base) call");

const preDeriveRegion = firstDeriveIdx > 0 ? src.slice(0, firstDeriveIdx) : "";
const preDeriveOpenIdx = preDeriveRegion.lastIndexOf("await openProjectDbIfPresent(base);");

assertTrue(
  preDeriveOpenIdx > 0,
  "bootstrapAutoSession opens the DB before the first deriveState(base) call (#2841)",
);

report();
