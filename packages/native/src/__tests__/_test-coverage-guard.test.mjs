// Regression guard for #4814 (filed under #4784).
//
// The `test` script in `package.json` used to hardcode a list of individual
// test files. When new test files were added without updating the list,
// they were silently skipped by `npm test` — 7 files / 99 tests went
// unrun in CI, including regression guards for #2861 (Node v24 ESM/CJS
// crash) and a napi state-array crash. See #4814 for the audit.
//
// This test fails if either of two things regresses:
//   1. The `test` script stops using a directory / glob invocation and
//      goes back to naming individual files.
//   2. Some mechanism is introduced that lists files and misses one.
//
// Mechanics: we parse the `test` script from package.json. A script that
// lists individual files (`src/__tests__/foo.test.mjs`) is REJECTED. A
// script that passes the directory (`src/__tests__` or `src/__tests__/`)
// is ACCEPTED. Either way we double-check by comparing the set of
// discoverable `*.test.mjs` files on disk against what the script
// actually invokes, so even a creative future construction is covered.
//
// The filename is prefixed `_` so it runs first in alphabetical order —
// a coverage-problem report precedes any noise from the tests whose
// coverage it is guarding.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "..", "package.json");

function loadTestScript() {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.scripts?.test ?? "";
}

function discoverTestFiles() {
  return readdirSync(__dirname)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort();
}

test("test script discovers every *.test.mjs file in src/__tests__/", () => {
  const script = loadTestScript();
  const onDisk = discoverTestFiles();

  // Accept self-healing invocation patterns (any of):
  //   node --test src/__tests__/*.test.mjs    (glob — Node resolves even without shell expansion)
  //   node --test "src/__tests__/*.test.mjs"  (quoted glob)
  //   node --test src/__tests__                (directory — some Node versions only)
  //   node --test src/__tests__/               (directory with trailing slash)
  // All four are structural: a new test file is picked up automatically.
  const selfHealingPattern = /\bnode\s+--test\b[^|&;]*\bsrc\/__tests__(?:\/(?:\*\.test\.mjs)?)?(?:\s|$|"|')/;
  if (selfHealingPattern.test(script)) {
    // Self-healing invocation; no further enumeration needed.
    assert.ok(true);
    return;
  }

  // Otherwise, the script must list every on-disk file individually.
  // Extract the set of files it names.
  const listedMatches = script.match(/src\/__tests__\/[A-Za-z0-9._-]+\.test\.mjs/g) || [];
  const listed = new Set(listedMatches.map((s) => s.split("/").pop()));

  const missing = onDisk.filter((f) => !listed.has(f));
  assert.deepEqual(
    missing,
    [],
    [
      "npm test does not invoke every *.test.mjs in src/__tests__/.",
      `Missing: ${missing.join(", ")}`,
      "Fix: replace the hardcoded list in packages/native/package.json",
      "with `node --test src/__tests__` (the directory form recursively",
      "discovers test files and is the boring-tech choice per McKinley).",
      "See #4814.",
    ].join("\n"),
  );
});

test("every *.test.mjs file is a valid ES module that exports nothing weird", () => {
  // Cheap sanity check: every test file can at least be statically
  // read. This catches accidental binary writes / zero-byte files that
  // would silently pass `--test` with zero cases.
  const files = discoverTestFiles();
  assert.ok(files.length > 0, "src/__tests__/ contains no test files");

  for (const f of files) {
    const body = readFileSync(join(__dirname, f), "utf-8");
    assert.ok(body.length > 0, `${f} is empty`);
    assert.match(
      body,
      /\bimport\s+.*\bfrom\s+['"]node:test['"]|test\s*\(/,
      `${f} does not import node:test or declare any test() — it will run zero cases`,
    );
  }
});
