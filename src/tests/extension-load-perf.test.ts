/**
 * Extension loading performance test
 *
 * Regression test for https://github.com/gsd-build/gsd-2/issues/2108
 *
 * Verifies that loading multiple extensions sharing common dependencies
 * does NOT re-compile those dependencies for each extension. The jiti
 * module cache must be shared across extension loads so that shared
 * modules are compiled once.
 *
 * Uses the built dist/ (not raw TS source) because pi-coding-agent uses
 * TypeScript features unsupported by --experimental-strip-types.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import loadExtensions from the compiled dist (it IS re-exported from the
// core/extensions barrel but not from the top-level index).
// Use process.cwd() rather than import.meta.url-relative navigation — the
// compiled test lands in dist-test/src/tests/, so relative paths differ between
// source and compiled contexts. process.cwd() is always the repo root in CI.
const loaderPath = join(
  process.cwd(),
  "packages", "pi-coding-agent", "dist", "core", "extensions", "loader.js",
);

test("loadExtensions shares module cache across extensions (perf regression #2108)", async () => {
  const { loadExtensions } = await import(loaderPath);

  // Create a temp directory with two extensions that import a shared helper
  const tmp = mkdtempSync(join(tmpdir(), "gsd-perf-test-"));

  try {
    // Shared helper module
    const sharedDir = join(tmp, "shared");
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(
      join(sharedDir, "helper.ts"),
      `export const SHARED_VALUE = "shared-${Date.now()}";\n`,
    );

    // Extension A — imports the shared helper
    const extADir = join(tmp, "ext-a");
    mkdirSync(extADir, { recursive: true });
    writeFileSync(
      join(extADir, "index.ts"),
      `import { SHARED_VALUE } from "${join(sharedDir, "helper.ts").replace(/\\/g, "/")}";\n` +
      `export default function(api: any) {\n` +
      `  api.registerCommand("ext-a-cmd", { description: "test A " + SHARED_VALUE, handler: async () => {} });\n` +
      `}\n`,
    );

    // Extension B — imports the same shared helper
    const extBDir = join(tmp, "ext-b");
    mkdirSync(extBDir, { recursive: true });
    writeFileSync(
      join(extBDir, "index.ts"),
      `import { SHARED_VALUE } from "${join(sharedDir, "helper.ts").replace(/\\/g, "/")}";\n` +
      `export default function(api: any) {\n` +
      `  api.registerCommand("ext-b-cmd", { description: "test B " + SHARED_VALUE, handler: async () => {} });\n` +
      `}\n`,
    );

    const paths = [join(extADir, "index.ts"), join(extBDir, "index.ts")];
    const start = Date.now();
    const result = await loadExtensions(paths, tmp);
    const elapsed = Date.now() - start;

    // Both extensions should load without errors
    assert.strictEqual(result.errors.length, 0, `Extension errors: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.extensions.length, 2, "Expected 2 extensions to load");

    // With shared jiti cache, loading 2 trivial extensions that share a
    // dependency should complete in well under 5 seconds.
    assert.ok(
      elapsed < 5000,
      `Extension loading took ${elapsed}ms — expected < 5000ms. ` +
      `This suggests jiti module caching is not shared across extensions.`,
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* cleanup */ }
  }
});
