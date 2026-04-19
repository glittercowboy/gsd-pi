import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const autoSource = readFileSync(join(__dirname, "..", "auto.ts"), "utf-8");

test("#3370: cleanupAfterLoopExit preserves paused auto badge after provider pause", () => {
  const cleanupIdx = autoSource.indexOf("function cleanupAfterLoopExit");
  assert.ok(cleanupIdx > -1, "auto.ts should define cleanupAfterLoopExit");

  const dispatchIdx = autoSource.indexOf("export async function dispatchHookUnit", cleanupIdx);
  assert.ok(dispatchIdx > cleanupIdx, "cleanupAfterLoopExit body should be bounded by the next export");

  const cleanupBody = autoSource.slice(cleanupIdx, dispatchIdx);
  const pausedGuardIdx = cleanupBody.indexOf("if (!s.paused) {");
  const clearStatusIdx = cleanupBody.indexOf('ctx.ui.setStatus("gsd-auto", undefined);');

  assert.ok(pausedGuardIdx > -1, "loop-exit cleanup must guard UI clearing when auto is paused");
  assert.ok(clearStatusIdx > pausedGuardIdx, "status clearing must live behind the paused guard");
  assert.ok(
    autoSource.includes('ctx?.ui.setStatus("gsd-auto", "paused");'),
    "pauseAuto must still set the paused badge for transient provider pauses",
  );
});
