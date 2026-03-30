/**
 * Regression tests for #3188 — custom engine bootstrap hijack.
 *
 * When activeEngineId is a non-null, non-"dev" value, bootstrapAutoSession
 * must return early without running the dev-engine state-gate code. Before
 * the fix, custom engines fell through to the dev-engine path, which attempted
 * git init, state derivation, and guided-flow entry — overriding the custom
 * engine's own startup sequence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sourcePath = join(import.meta.dirname, "..", "auto-start.ts");
const source = readFileSync(sourcePath, "utf-8");

test("bootstrapAutoSession has early-exit guard for custom engines (#3188)", () => {
  assert.ok(
    source.includes('s.activeEngineId !== null && s.activeEngineId !== "dev"'),
    [
      "auto-start.ts must contain the early-exit guard:",
      '  if (s.activeEngineId !== null && s.activeEngineId !== "dev") { return true; }',
      "Custom engines must bypass dev-engine bootstrap gates.",
    ].join("\n"),
  );
});

test("custom-engine early exit is placed after lock acquire, before dev-engine state-gate code (#3188)", () => {
  const lockAcquireIdx = source.indexOf("const lockResult = acquireSessionLock(base)");
  assert.ok(lockAcquireIdx > -1, "auto-start.ts must call acquireSessionLock");

  const releaseLockIdx = source.indexOf("function releaseLockAndReturn");
  assert.ok(releaseLockIdx > -1, "auto-start.ts must define releaseLockAndReturn");

  const earlyExitIdx = source.indexOf(
    's.activeEngineId !== null && s.activeEngineId !== "dev"',
  );
  assert.ok(
    earlyExitIdx > -1,
    "auto-start.ts must contain the custom-engine early-exit guard (#3188)",
  );

  // The guard must appear after the lock is acquired and releaseLockAndReturn is defined
  assert.ok(
    earlyExitIdx > lockAcquireIdx,
    "Custom-engine guard must appear after session lock is acquired",
  );
  assert.ok(
    earlyExitIdx > releaseLockIdx,
    "Custom-engine guard must appear after releaseLockAndReturn is defined",
  );

  // The guard must appear before the first dev-engine state-gate call (deriveState)
  const firstDeriveStateIdx = source.indexOf("let state = await deriveState(base)");
  assert.ok(firstDeriveStateIdx > -1, "auto-start.ts must call deriveState");
  assert.ok(
    earlyExitIdx < firstDeriveStateIdx,
    "Custom-engine guard must appear before the first deriveState call (dev-engine state gate)",
  );
});

test("bootstrapAutoSession returns true for custom-engine early exit, not false (#3188)", () => {
  const earlyExitIdx = source.indexOf(
    's.activeEngineId !== null && s.activeEngineId !== "dev"',
  );
  assert.ok(earlyExitIdx > -1, "Custom-engine guard must exist in auto-start.ts");

  // The return value in the guard block must be `true` (custom engine is ready to proceed),
  // not `false` (which would abort auto-mode).
  const guardRegion = source.slice(earlyExitIdx, earlyExitIdx + 120);
  assert.ok(
    guardRegion.includes("return true"),
    [
      "Custom-engine early exit must return true (not false) so auto-mode continues.",
      "Region found: " + guardRegion,
    ].join("\n"),
  );
});

test("null activeEngineId still runs dev-engine path: deriveState is not gated away (#3188)", () => {
  // When activeEngineId is null, the guard condition is false — the function must
  // reach deriveState. Verify deriveState is called unconditionally after the guard.
  const earlyExitIdx = source.indexOf(
    's.activeEngineId !== null && s.activeEngineId !== "dev"',
  );
  const firstDeriveIdx = source.indexOf("let state = await deriveState(base)");

  // Both markers must exist
  assert.ok(earlyExitIdx > -1, "Early-exit guard must exist");
  assert.ok(firstDeriveIdx > -1, "deriveState call must exist after the guard");

  // Ensure deriveState comes after the guard (would be unreachable if guard wrapped it)
  assert.ok(
    firstDeriveIdx > earlyExitIdx,
    "deriveState must be reachable (comes after the early-exit guard, not inside it)",
  );
});
