// Structural contract: shared/mod.ts must never import @gsd/pi-tui.
// TUI-dependent exports live in shared/tui.ts instead.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("shared/mod.ts has no import from @gsd/pi-tui", () => {
  const src = readFileSync(join(__dirname, "../../shared/mod.ts"), "utf-8");
  assert.ok(!src.includes("@gsd/pi-tui"), "mod.ts must not import @gsd/pi-tui");
});
