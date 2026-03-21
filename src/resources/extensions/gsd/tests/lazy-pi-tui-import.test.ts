// Verifies that shared/ui.ts does NOT eagerly import @gsd/pi-tui at the
// module level.  An eager top-level import causes /exit (and any other
// command that transitively loads shared/mod → shared/ui) to blow up when
// @gsd/pi-tui cannot be resolved — e.g. extensions copied to
// ~/.gsd/agent/extensions/ where no node_modules tree exists.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiSrc = readFileSync(join(__dirname, "../../shared/ui.ts"), "utf-8");

test("shared/ui.ts has no top-level import from @gsd/pi-tui", () => {
  // Match lines like: import { ... } from "@gsd/pi-tui";
  // But ignore type-only imports (import type / import("@gsd/pi-tui").X)
  // and comments.
  const lines = uiSrc.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and type-only references
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    // Skip type-only import statements
    if (trimmed.startsWith("import type ")) continue;
    // Skip inline import() type annotations (erased at runtime)
    if (/import\(["']@gsd\/pi-tui["']\)/.test(trimmed) && !trimmed.startsWith("import ")) continue;

    // Flag any eager import statement pulling runtime values from @gsd/pi-tui
    if (/^\s*import\s+\{/.test(line) && line.includes("@gsd/pi-tui")) {
      assert.fail(
        `Found eager top-level import from @gsd/pi-tui — this must be lazy.\n` +
          `Line: ${trimmed}`,
      );
    }
  }
});

test("shared/ui.ts lazily resolves @gsd/pi-tui inside makeUI", () => {
  // The lazy accessor pattern: require("@gsd/pi-tui") inside a function body
  assert.ok(
    uiSrc.includes('require("@gsd/pi-tui")'),
    "Expected a lazy require(\"@gsd/pi-tui\") call inside a function body",
  );
});
