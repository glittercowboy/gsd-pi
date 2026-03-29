/**
 * Guided-flow dynamic routing — regression test for #2958.
 *
 * Verifies that dispatchWorkflow() routes through the dynamic routing pipeline
 * (selectAndApplyModel from auto-model-selection.ts) instead of bypassing it
 * with a direct call to resolveModelWithFallbacksForUnit.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

function readSrc(file: string): string {
  return readFileSync(join(gsdDir, file), "utf-8");
}

const guidedFlowSrc = readSrc("guided-flow.ts");

// ═══════════════════════════════════════════════════════════════════════════
// #2958: dispatchWorkflow must route through dynamic routing pipeline
// ═══════════════════════════════════════════════════════════════════════════

test("#2958: guided-flow imports selectAndApplyModel from auto-model-selection", () => {
  assert.ok(
    guidedFlowSrc.includes("selectAndApplyModel"),
    "guided-flow.ts must import and use selectAndApplyModel from auto-model-selection.ts",
  );
});

test("#2958: dispatchWorkflow does not call resolveModelWithFallbacksForUnit directly", () => {
  // Extract the dispatchWorkflow function body
  const fnStart = guidedFlowSrc.indexOf("async function dispatchWorkflow(");
  assert.ok(fnStart !== -1, "dispatchWorkflow function not found");

  // Find the function body by tracking brace depth
  const openBrace = guidedFlowSrc.indexOf("{", fnStart);
  let depth = 1;
  let pos = openBrace + 1;
  while (depth > 0 && pos < guidedFlowSrc.length) {
    if (guidedFlowSrc[pos] === "{") depth++;
    else if (guidedFlowSrc[pos] === "}") depth--;
    pos++;
  }
  const fnBody = guidedFlowSrc.slice(openBrace, pos);

  assert.ok(
    !fnBody.includes("resolveModelWithFallbacksForUnit"),
    "dispatchWorkflow must NOT call resolveModelWithFallbacksForUnit directly — " +
    "it must route through selectAndApplyModel for dynamic routing support (#2958)",
  );
});

test("#2958: dispatchWorkflow calls selectAndApplyModel for model selection", () => {
  // Extract the dispatchWorkflow function body
  const fnStart = guidedFlowSrc.indexOf("async function dispatchWorkflow(");
  assert.ok(fnStart !== -1, "dispatchWorkflow function not found");

  const openBrace = guidedFlowSrc.indexOf("{", fnStart);
  let depth = 1;
  let pos = openBrace + 1;
  while (depth > 0 && pos < guidedFlowSrc.length) {
    if (guidedFlowSrc[pos] === "{") depth++;
    else if (guidedFlowSrc[pos] === "}") depth--;
    pos++;
  }
  const fnBody = guidedFlowSrc.slice(openBrace, pos);

  assert.ok(
    fnBody.includes("selectAndApplyModel"),
    "dispatchWorkflow must call selectAndApplyModel to route through the dynamic routing pipeline (#2958)",
  );
});

test("#2958: dispatchWorkflow does not use resolveAvailableModel inline", () => {
  const fnStart = guidedFlowSrc.indexOf("async function dispatchWorkflow(");
  assert.ok(fnStart !== -1, "dispatchWorkflow function not found");

  const openBrace = guidedFlowSrc.indexOf("{", fnStart);
  let depth = 1;
  let pos = openBrace + 1;
  while (depth > 0 && pos < guidedFlowSrc.length) {
    if (guidedFlowSrc[pos] === "{") depth++;
    else if (guidedFlowSrc[pos] === "}") depth--;
    pos++;
  }
  const fnBody = guidedFlowSrc.slice(openBrace, pos);

  assert.ok(
    !fnBody.includes("resolveAvailableModel"),
    "dispatchWorkflow must NOT use resolveAvailableModel inline — " +
    "model resolution is handled by selectAndApplyModel (#2958)",
  );
});

test("#2958: guided-flow does not import resolveModelWithFallbacksForUnit", () => {
  // The import should be removed since dispatchWorkflow was the only consumer
  // Check if resolveModelWithFallbacksForUnit is still used elsewhere in the file
  const fnStart = guidedFlowSrc.indexOf("async function dispatchWorkflow(");
  const beforeDispatch = guidedFlowSrc.slice(0, fnStart);
  const afterFnEnd = (() => {
    const openBrace = guidedFlowSrc.indexOf("{", fnStart);
    let depth = 1;
    let p = openBrace + 1;
    while (depth > 0 && p < guidedFlowSrc.length) {
      if (guidedFlowSrc[p] === "{") depth++;
      else if (guidedFlowSrc[p] === "}") depth--;
      p++;
    }
    return guidedFlowSrc.slice(p);
  })();

  // If resolveModelWithFallbacksForUnit is not used outside dispatchWorkflow,
  // the import should be removed
  const usedOutside = beforeDispatch.includes("resolveModelWithFallbacksForUnit(")
    || afterFnEnd.includes("resolveModelWithFallbacksForUnit(");

  if (!usedOutside) {
    // Verify the import line was cleaned up
    const importLines = guidedFlowSrc.split("\n").filter(l =>
      l.includes("import") && l.includes("resolveModelWithFallbacksForUnit"),
    );
    assert.equal(
      importLines.length,
      0,
      "resolveModelWithFallbacksForUnit import should be removed when no longer used outside dispatchWorkflow",
    );
  }
});
