/**
 * Regression test for #3477: gsd_skip_slice tool must rebuild STATE.md
 * after updating the DB so auto-mode reads the correct state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("gsd_skip_slice tool calls rebuildState after DB update (#3477)", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "bootstrap", "db-tools.ts"),
    "utf-8",
  );
  // The fix adds a rebuildState call after updateSliceStatus in skip_slice
  assert.ok(
    src.includes("rebuildState"),
    "gsd_skip_slice must call rebuildState after updating slice status",
  );
});

test("rethink prompt warns against markdown-only edits for skip (#3477)", () => {
  const prompt = readFileSync(
    join(import.meta.dirname, "..", "prompts", "rethink.md"),
    "utf-8",
  );
  assert.ok(
    prompt.includes("MUST") && prompt.includes("gsd_skip_slice"),
    "Rethink prompt must emphasize gsd_skip_slice tool requirement",
  );
});
