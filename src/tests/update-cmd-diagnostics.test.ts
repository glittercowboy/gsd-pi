/**
 * Regression test for #3445: gsd update must print both current and latest
 * versions for diagnostics, and bypass npm cache.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("update-cmd prints latest version before comparison (#3445)", () => {
  const src = readFileSync(join(__dirname, "..", "update-cmd.ts"), "utf-8");
  const latestPrintIdx = src.indexOf("Latest version:");
  const comparisonIdx = src.indexOf("compareSemver(latest, current)");
  assert.ok(latestPrintIdx !== -1, "Must print latest version");
  assert.ok(latestPrintIdx < comparisonIdx, "Must print latest BEFORE comparison");
});

test("update commands use the registry fetch helper instead of npm view (#3806)", () => {
  const src = readFileSync(join(__dirname, "..", "update-cmd.ts"), "utf-8");
  const handlerSrc = readFileSync(join(__dirname, "..", "resources", "extensions", "gsd", "commands-handlers.ts"), "utf-8");
  assert.ok(
    src.includes("fetchLatestVersionFromRegistry"),
    "update-cmd should use the shared registry fetch helper",
  );
  assert.ok(!src.includes("npm view "), "update-cmd should no longer shell out to npm view");
  assert.ok(
    handlerSrc.includes("fetchLatestVersionForCommand"),
    "/gsd update should fetch the latest version through a registry helper too",
  );
  assert.ok(!handlerSrc.includes("npm view "), "/gsd update should no longer shell out to npm view");
});
