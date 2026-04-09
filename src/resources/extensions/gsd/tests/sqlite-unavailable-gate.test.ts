/**
 * sqlite-unavailable-gate.test.ts — #2419
 *
 * When the SQLite provider fails to open, bootstrapAutoSession must
 * refuse to start auto-mode. Otherwise gsd_task_complete returns
 * "db_unavailable", artifact retry re-dispatches the same task, and
 * the session loops forever.
 *
 * This test verifies the gate by reading auto-start.ts source and
 * confirming the pattern: after the DB lifecycle block, if the DB
 * file exists on disk but isDbAvailable() still returns false after
 * the open attempt, bootstrap must abort with an error notification.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestContext } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const srcPath = join(import.meta.dirname, "..", "auto-start.ts");
const src = readFileSync(srcPath, "utf-8");

console.log("\n=== #2419: SQLite unavailable gate in auto-start.ts ===");

// The DB lifecycle section tries to open the DB. After those try/catch
// blocks, there must be a HARD GATE: if the DB file exists on disk but
// isDbAvailable() is still false (open failed), bootstrap must abort
// by calling releaseLockAndReturn() with an error notification.

const dbLifecycleIdx = src.indexOf("DB lifecycle");
assertTrue(dbLifecycleIdx > 0, "auto-start.ts has a DB lifecycle section");

const afterDbLifecycle = src.slice(dbLifecycleIdx);

// The DB lifecycle section may contain multiple isDbAvailable() checks now that
// cold-start bootstrap can pre-open the DB earlier in the file. What matters
// for #2419 is the explicit abort gate after the DB open attempts.
assertTrue(
  afterDbLifecycle.includes("!isDbAvailable()"),
  "DB lifecycle section still checks for unavailable DB state (#2419)",
);

const gateMatch = afterDbLifecycle.match(
  /if\s*\(existsSync\(gsdDbPath\)\s*&&\s*!isDbAvailable\(\)\)\s*\{[\s\S]*?releaseLockAndReturn\(\);[\s\S]*?\}/,
);

assertTrue(
  !!gateMatch,
  "auto-start.ts has a hard abort gate when gsd.db exists but SQLite is still unavailable (#2419)",
);

if (gateMatch) {
  const gateRegion = gateMatch[0];
  assertTrue(
    gateRegion.includes("releaseLockAndReturn"),
    "The DB availability gate calls releaseLockAndReturn() to abort bootstrap (#2419)",
  );
  assertTrue(
    /database|sqlite|db.*unavailable/i.test(gateRegion),
    "The DB availability gate includes a user-facing error message about the database (#2419)",
  );
}

report();
