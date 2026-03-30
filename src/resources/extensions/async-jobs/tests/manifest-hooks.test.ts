// Regression test for #3156 — extension manifest hooks parity
// Ensures every pi.on() hook call site in each extension is declared in that
// extension's extension-manifest.json provides.hooks array, and that no stale
// hook names remain in the manifest without a corresponding call site.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionsRoot = resolve(__dirname, "..", "..");

function scanPiOnHooks(dir: string): Set<string> {
  const hooks = new Set<string>();
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === "tests" ||
      entry.name === "__tests__"
    ) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const h of scanPiOnHooks(full)) hooks.add(h);
    } else if (entry.name.endsWith(".ts")) {
      const src = readFileSync(full, "utf-8");
      for (const m of src.matchAll(/pi\.on\(\s*"([^"]+)"/g)) {
        hooks.add(m[1]);
      }
    }
  }
  return hooks;
}

const EXTENSIONS = [
  "async-jobs",
  "bg-shell",
  "browser-tools",
  "context7",
  "google-search",
  "gsd",
  "search-the-web",
];

describe("extension manifest hooks parity (#3156)", () => {
  for (const ext of EXTENSIONS) {
    const extDir = join(extensionsRoot, ext);
    const manifestPath = join(extDir, "extension-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      provides?: { hooks?: string[] };
    };
    const declaredHooks = new Set<string>(manifest.provides?.hooks ?? []);
    const actualHooks = scanPiOnHooks(extDir);

    test(`${ext}: all pi.on hooks are declared in manifest`, () => {
      const missing = [...actualHooks].filter((h) => !declaredHooks.has(h));
      assert.deepEqual(
        missing,
        [],
        `${ext} manifest missing hooks: ${missing.join(", ")}`,
      );
    });

    test(`${ext}: no stale hooks in manifest`, () => {
      const stale = [...declaredHooks].filter((h) => !actualHooks.has(h));
      assert.deepEqual(
        stale,
        [],
        `${ext} manifest has stale hooks not in source: ${stale.join(", ")}`,
      );
    });
  }
});
