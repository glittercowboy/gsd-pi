import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createTestContext } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const srcPath = join(import.meta.dirname, "..", "auto-start.ts");
const src = readFileSync(srcPath, "utf-8");

console.log("\n=== #3822: worktree bootstrap uses project DB path ===");

const dbLifecycleIdx = src.indexOf("// ── DB lifecycle ──");
assertTrue(dbLifecycleIdx > 0, "auto-start.ts has a DB lifecycle section");

const dbLifecycleRegion = dbLifecycleIdx > 0 ? src.slice(dbLifecycleIdx, dbLifecycleIdx + 600) : "";

assertTrue(
  dbLifecycleRegion.includes("const gsdDbPath = resolveProjectRootDbPath(s.basePath);"),
  "DB lifecycle resolves the project-root DB path after worktree entry (#3822)",
);

assertTrue(
  !dbLifecycleRegion.includes('join(s.basePath, ".gsd", "gsd.db")'),
  "DB lifecycle no longer derives gsd.db directly from the worktree path (#3822)",
);

report();
