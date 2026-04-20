import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSourceFilePaths } from "../auto-prompts.ts";

// Regression test for #4416: the fallback string must not mention `rg` because
// auto-mode runs on systems where ripgrep is not installed (e.g. Windows).
test("buildSourceFilePaths fallback does not reference rg or ripgrep", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-fallback-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // No GSD files exist in tmp — forces the fallback branch.
  const result = buildSourceFilePaths(tmp, "M001");

  assert.ok(
    !result.includes("rg ") && !result.includes("`rg`") && !result.includes("ripgrep"),
    `Fallback string must not reference rg/ripgrep. Got: ${result}`,
  );
  assert.ok(result.length > 0, "Fallback string must not be empty");
});

test("buildSourceFilePaths with sid also produces rg-free fallback", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-fallback-sid-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const result = buildSourceFilePaths(tmp, "M001", "S01");

  assert.ok(
    !result.includes("rg ") && !result.includes("`rg`") && !result.includes("ripgrep"),
    `Fallback string must not reference rg/ripgrep. Got: ${result}`,
  );
});
