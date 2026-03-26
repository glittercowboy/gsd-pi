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

// Find the second isDbAvailable check — the one AFTER the open attempts.
// The first check at line ~543 tries to open the DB.
// There must be a SECOND check that gates bootstrap if it's still unavailable.
const firstCheck = afterDbLifecycle.indexOf("isDbAvailable()");
assertTrue(firstCheck > 0, "DB lifecycle section has isDbAvailable() check");

const afterFirstCheck = afterDbLifecycle.slice(firstCheck + "isDbAvailable()".length);
const secondCheck = afterFirstCheck.indexOf("isDbAvailable()");

assertTrue(
  secondCheck > 0,
  "auto-start.ts has a SECOND isDbAvailable() check after the open attempt — this is the gate (#2419)",
);

// The second check must lead to releaseLockAndReturn (abort bootstrap)
if (secondCheck > 0) {
  const gateRegion = afterFirstCheck.slice(secondCheck, secondCheck + 500);
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
