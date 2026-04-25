/**
 * Tests that the @gsd/native package.json is correctly configured
 * for Node.js module resolution (ESM/CJS compatibility).
 *
 * Regression test for #2861: "type": "module" + "import"-only export
 * conditions caused crashes on Node.js v24 when the parent package also
 * declared "type": "module" and strict ESM resolution was enforced.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

describe("@gsd/native module compatibility (#2861)", () => {
  test("package.json must not declare type: module (compiled output is CJS-compatible)", () => {
    // The compiled output uses createRequire() to load .node addons.
    // Declaring "type": "module" forces Node.js to treat .js files as ESM,
    // but the package needs "type": "commonjs" to override the parent
    // package's "type": "module" and ensure correct CJS semantics.
    assert.notEqual(
      pkg.type,
      "module",
      'package.json must not set "type": "module" — this causes crashes on Node.js v24 ' +
        "when the parent package also declares ESM (see #2861)",
    );
  });

  test("package.json should explicitly declare type: commonjs", () => {
    // When installed as a dependency under a parent with "type": "module"
    // (e.g. gsd-pi), an absent "type" field would inherit the parent's
    // ESM setting. Explicit "commonjs" overrides this.
    assert.equal(
      pkg.type,
      "commonjs",
      'package.json must explicitly set "type": "commonjs" to override ' +
        "the parent package's ESM declaration",
    );
  });

  test("all export conditions must use 'default' (not 'import'-only)", () => {
    // The "import" condition key restricts resolution to ESM import
    // statements only. Using "default" ensures the export works for both
    // require() and import, which is essential for a CJS package that may
    // be consumed from ESM code via Node's CJS interop.
    const exportsMap = pkg.exports;
    assert.ok(exportsMap, "package.json must have an exports map");

    for (const [subpath, conditions] of Object.entries(exportsMap)) {
      assert.ok(
        !conditions.import || conditions.default,
        `exports["${subpath}"] uses "import" condition without "default" — ` +
          `this breaks CJS consumers and Node.js v24 strict resolution`,
      );
    }
  });

  test(
    "compiled CJS output loads under a parent package with type: module (regression guard for #2861)",
    () => {
      // Behavioral guard: the real regression #2861 surfaced when the package
      // was consumed from a parent whose `package.json` declared
      // `"type": "module"`, because the CJS output was parse-errored by
      // Node.js v24. Rather than grep the TypeScript source for forbidden
      // strings (which would break on any equivalent refactor), this test
      // actually requires the compiled CJS from a synthesized parent that
      // mimics the failing layout in the original bug report.
      const distPath = path.resolve(__dirname, "..", "..", "dist", "native.js");
      if (!existsSync(distPath)) {
        // The native package's test runner builds `dist/` before this test
        // runs; however, developers may invoke the file in isolation. Skip
        // rather than fail spuriously — the invariant still fails loudly
        // on any regression under the full `npm test` flow.
        return;
      }

      const parentDir = mkdtempSync(path.join(os.tmpdir(), "gsd-native-modcompat-"));
      // Parent declares "type": "module", reproducing the #2861 layout.
      writeFileSync(
        path.join(parentDir, "package.json"),
        JSON.stringify({ name: "modcompat-parent", type: "module" }),
      );
      const loader = path.join(parentDir, "load.cjs");
      // Use `.cjs` to ensure Node treats the script as CJS regardless of
      // the enclosing directory's module type — this mirrors how the
      // package's own dist files need to resolve as CJS despite an ESM
      // parent. We `require()` the compiled native.js entrypoint; a
      // parse-time crash (as in #2861) would surface as non-zero exit
      // with the error on stderr.
      writeFileSync(
        loader,
        `require(${JSON.stringify(distPath)});\nconsole.log("OK");\n`,
      );

      const result = spawnSync(process.execPath, [loader], {
        encoding: "utf8",
        // Inherit nothing that could mask a native loader failure beyond
        // the addon-missing fallback (which writes to stderr but does not
        // exit non-zero — see `loadNative` proxy fallback in native.ts).
        env: { ...process.env },
      });

      assert.equal(
        result.status,
        0,
        `compiled CJS output failed to load under ESM parent. ` +
          `stderr: ${result.stderr}\nstdout: ${result.stdout}`,
      );
      assert.match(
        result.stdout,
        /OK/,
        "loader script must reach the final log — any earlier crash is a regression",
      );
    },
  );
});
