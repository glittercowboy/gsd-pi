/**
 * stop-auto-race-null-unit.test.ts — Regression test for #2939.
 *
 * When the user stops auto-mode while a unit is executing, stopAuto()
 * calls s.reset() which sets s.currentUnit = null. The resumed
 * runUnitPhase() then hits s.currentUnit.startedAt on the closeout
 * line and throws a TypeError.
 *
 * The fix adds null guards (matching the existing pattern at lines 136
 * and 344) so that closeout and subsequent accesses are skipped when
 * s.currentUnit has been nulled by a concurrent stopAuto().
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestContext, extractSourceRegion } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const phasesPath = join(import.meta.dirname, "..", "auto", "phases.ts");
const phasesSrc = readFileSync(phasesPath, "utf-8");

console.log("\n=== #2939: stopAuto race — null guard on s.currentUnit in closeout ===");

// ── Test 1: closeoutUnit call is guarded by if (s.currentUnit) ──────────
// The closeout block starting around the "Immediate unit closeout" comment
// must be wrapped in an `if (s.currentUnit)` guard, matching the pattern
// already used at lines 136 and 344.

const closeoutComment = "Immediate unit closeout";
const closeoutIdx = phasesSrc.indexOf(closeoutComment);
assertTrue(
  closeoutIdx > 0,
  "phases.ts contains the 'Immediate unit closeout' comment block",
);

// Extract the region from the closeout comment to the next section comment
const closeoutRegion = extractSourceRegion(phasesSrc, closeoutComment);
assertTrue(
  closeoutRegion.includes("if (s.currentUnit)"),
  "closeoutUnit call is guarded by `if (s.currentUnit)` check (#2939)",
);

// ── Test 2: zero-tool-call guard uses s.currentUnit?.startedAt ──────────
// The zero-tool-call section accesses s.currentUnit!.startedAt (non-null
// assertion) which will throw if currentUnit is null.

const zeroToolComment = "Zero tool-call guard";
const zeroToolIdx = phasesSrc.indexOf(zeroToolComment);
assertTrue(
  zeroToolIdx > 0,
  "phases.ts contains the 'Zero tool-call guard' comment block",
);

const zeroToolRegion = extractSourceRegion(phasesSrc, zeroToolComment);

// The non-null assertion `s.currentUnit!.startedAt` must be replaced with
// optional chaining `s.currentUnit?.startedAt`
assertTrue(
  !zeroToolRegion.includes("s.currentUnit!.startedAt"),
  "zero-tool-call guard no longer uses non-null assertion on s.currentUnit (#2939)",
);

// ── Test 3: return value uses optional chaining for startedAt ───────────
// The final return at the end of runUnitPhase uses s.currentUnit.startedAt
// which will throw if currentUnit was nulled. It must use optional chaining.

// Find the last return statement in runUnitPhase that references startedAt.
// There are two: one inside the zero-tool-call block and one at the end.
// Both must use s.currentUnit?.startedAt

// Count unguarded s.currentUnit.startedAt (without optional chaining)
// after the "Immediate unit closeout" comment. All of them should use
// optional chaining or be inside a guard.
const afterCloseout = phasesSrc.slice(closeoutIdx);

// Count s.currentUnit!.startedAt (non-null assertion — always unsafe)
const nonNullPattern = /s\.currentUnit!\.startedAt/g;
const nonNullAfterCloseout = [...afterCloseout.matchAll(nonNullPattern)];
assertTrue(
  nonNullAfterCloseout.length === 0,
  `no non-null assertions s.currentUnit!.startedAt after closeout comment (found ${nonNullAfterCloseout.length}, expected 0) (#2939)`,
);

// Count bare s.currentUnit.startedAt that are NOT inside an if (s.currentUnit) guard.
// The closeout block itself uses s.currentUnit.startedAt inside a guard — that's fine.
// But any usage outside a guard block (e.g. in a return statement) must use optional chaining.
// We check that all return statements use optional chaining.
const returnWithBareAccess = /return\s*\{[^}]*s\.currentUnit\.startedAt/g;
const bareReturnCount = [...afterCloseout.matchAll(returnWithBareAccess)].length;
assertTrue(
  bareReturnCount === 0,
  `no return statements use bare s.currentUnit.startedAt (found ${bareReturnCount}, expected 0) (#2939)`,
);

// ── Test 4: the return at end of runUnitPhase uses optional chaining ────
// The final `return { action: "next", data: { unitStartedAt: s.currentUnit?.startedAt } }`
// must use optional chaining.

const finalReturnPattern = /unitStartedAt:\s*s\.currentUnit\?\.startedAt/;
assertTrue(
  finalReturnPattern.test(afterCloseout),
  "final return uses s.currentUnit?.startedAt with optional chaining (#2939)",
);

report();
