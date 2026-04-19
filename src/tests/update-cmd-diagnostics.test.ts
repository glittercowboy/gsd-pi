/**
 * Regression test for #3445: gsd update must print both current and latest
 * versions for diagnostics, and bypass npm cache.
 * Regression test for #4145: gsd update must use bun when installed via Bun.
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

test("update-check exports resolveInstallCommand (#4145)", async () => {
  const { resolveInstallCommand } = await import("../update-check.js");
  assert.equal(typeof resolveInstallCommand, "function", "resolveInstallCommand must be exported from update-check");
});

test("resolveInstallCommand returns bun command when running under Bun (#4145)", async () => {
  const { resolveInstallCommand } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  try {
    (process.versions as Record<string, string | undefined>).bun = "1.0.0";
    assert.equal(resolveInstallCommand("gsd-pi@latest"), "bun add -g gsd-pi@latest");
  } finally {
    if (orig === undefined) {
      delete (process.versions as Record<string, string | undefined>).bun;
    } else {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
  }
});

test("resolveInstallCommand returns npm command when not running under Bun (#4145)", async () => {
  const { resolveInstallCommand } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  try {
    delete (process.versions as Record<string, string | undefined>).bun;
    assert.equal(resolveInstallCommand("gsd-pi@latest"), "npm install -g gsd-pi@latest");
  } finally {
    if (orig !== undefined) {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
  }
});

test("update-cmd uses resolveInstallCommand instead of hardcoded npm (#4145)", () => {
  const src = readFileSync(join(__dirname, "..", "update-cmd.ts"), "utf-8");
  assert.ok(
    src.includes("resolveInstallCommand"),
    "update-cmd should use resolveInstallCommand for package manager detection",
  );
});

test("commands-handlers uses resolveInstallCommand instead of hardcoded npm (#4145)", () => {
  const handlerSrc = readFileSync(join(__dirname, "..", "resources", "extensions", "gsd", "commands-handlers.ts"), "utf-8");
  assert.ok(
    handlerSrc.includes("resolveInstallCommand"),
    "/gsd update handler should use resolveInstallCommand for package manager detection",
  );
});

test("isBunInstall detects bun install via argv[1] even when process.versions.bun is undefined (#4145)", async () => {
  const { isBunInstall } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  const origArgv1 = process.argv[1];
  const origBunInstall = process.env.BUN_INSTALL;
  try {
    // Simulate running under Node (not Bun) — matches the real-world shim case
    // where the bun-installed symlink's target has #!/usr/bin/env node.
    delete (process.versions as Record<string, string | undefined>).bun;
    delete process.env.BUN_INSTALL;

    // argv[1] preserves the unresolved symlink path, not the realpath target.
    process.argv[1] = join(process.env.HOME ?? "/home/user", ".bun", "bin", "gsd");
    assert.equal(isBunInstall(), true, "should detect bun install from ~/.bun/bin/ argv[1]");

    // Custom BUN_INSTALL location
    process.env.BUN_INSTALL = "/opt/bun";
    process.argv[1] = "/opt/bun/bin/gsd";
    assert.equal(isBunInstall(), true, "should detect bun install from $BUN_INSTALL/bin/ argv[1]");

    // Non-bun path must NOT match
    delete process.env.BUN_INSTALL;
    process.argv[1] = "/usr/local/lib/node_modules/gsd-pi/dist/loader.js";
    assert.equal(isBunInstall(), false, "npm global install path should not match");

    // Prefix false-positive guard: /.bun/bin-other should not match /.bun/bin
    process.argv[1] = join(process.env.HOME ?? "/home/user", ".bun", "bin-other", "gsd");
    assert.equal(isBunInstall(), false, "sibling dir with bin prefix should not match");
  } finally {
    if (orig === undefined) {
      delete (process.versions as Record<string, string | undefined>).bun;
    } else {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
    process.argv[1] = origArgv1;
    if (origBunInstall === undefined) {
      delete process.env.BUN_INSTALL;
    } else {
      process.env.BUN_INSTALL = origBunInstall;
    }
  }
});

test("isBunInstall returns true when running under Bun runtime (#4145)", async () => {
  const { isBunInstall } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  const origArgv1 = process.argv[1];
  try {
    (process.versions as Record<string, string | undefined>).bun = "1.0.0";
    // Even with a non-bun argv[1], runtime detection wins
    process.argv[1] = "/usr/local/lib/node_modules/gsd-pi/dist/loader.js";
    assert.equal(isBunInstall(), true);
  } finally {
    if (orig === undefined) {
      delete (process.versions as Record<string, string | undefined>).bun;
    } else {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
    process.argv[1] = origArgv1;
  }
});
