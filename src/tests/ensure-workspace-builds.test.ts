import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { newestSrcMtime, detectStalePackages } = require("../../scripts/ensure-workspace-builds.cjs");

describe("newestSrcMtime", () => {
  let tmp: string;

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gsd-mtime-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("returns 0 for a non-existent directory", () => {
    assert.equal(newestSrcMtime(join(tmp, "does-not-exist")), 0);
  });

  it("returns 0 when directory has no .ts files", () => {
    writeFileSync(join(tmp, "index.js"), "");
    writeFileSync(join(tmp, "config.json"), "");
    assert.equal(newestSrcMtime(tmp), 0);
  });

  it("returns the mtime of a single .ts file", () => {
    const file = join(tmp, "index.ts");
    writeFileSync(file, "");
    const mtime = new Date("2024-01-15T10:00:00Z");
    utimesSync(file, mtime, mtime);
    assert.equal(newestSrcMtime(tmp), mtime.getTime());
  });

  it("returns the max mtime across multiple .ts files", () => {
    const older = join(tmp, "a.ts");
    const newer = join(tmp, "b.ts");
    writeFileSync(older, "");
    writeFileSync(newer, "");
    utimesSync(older, new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"));
    utimesSync(newer, new Date("2024-06-01T00:00:00Z"), new Date("2024-06-01T00:00:00Z"));
    assert.equal(newestSrcMtime(tmp), new Date("2024-06-01T00:00:00Z").getTime());
  });

  it("recurses into subdirectories", () => {
    const subdir = join(tmp, "nested", "deep");
    mkdirSync(subdir, { recursive: true });
    const file = join(subdir, "util.ts");
    writeFileSync(file, "");
    const mtime = new Date("2024-03-01T00:00:00Z");
    utimesSync(file, mtime, mtime);
    assert.equal(newestSrcMtime(tmp), mtime.getTime());
  });

  it("skips node_modules entirely", () => {
    const nm = join(tmp, "node_modules", "some-pkg");
    mkdirSync(nm, { recursive: true });
    const nmFile = join(nm, "index.ts");
    writeFileSync(nmFile, "");
    const future = new Date("2099-01-01T00:00:00Z");
    utimesSync(nmFile, future, future);
    assert.equal(newestSrcMtime(tmp), 0);
  });
});

describe("detectStalePackages", () => {
  let tmp: string;

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gsd-stale-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  /**
   * Helper to create a fake workspace package with src/ and dist/ directories.
   * Sets timestamps to simulate npm tarball extraction where src/ files can be
   * 1 second newer than dist/ files.
   */
  function createFakePackage(
    packagesDir: string,
    pkgName: string,
    opts: { srcNewerThanDist?: boolean; missingDist?: boolean } = {},
  ): void {
    const pkgDir = join(packagesDir, pkgName);
    const srcDir = join(pkgDir, "src");
    const distDir = join(pkgDir, "dist");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "index.ts"), "export const x = 1;");

    if (!opts.missingDist) {
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, "index.js"), "export const x = 1;");
    }

    if (opts.srcNewerThanDist && !opts.missingDist) {
      // Simulate npm tarball extraction: src/ is 1 second newer than dist/
      const distTime = new Date("2024-06-01T00:00:00Z");
      const srcTime = new Date("2024-06-01T00:00:01Z");
      utimesSync(join(distDir, "index.js"), distTime, distTime);
      utimesSync(join(srcDir, "index.ts"), srcTime, srcTime);
    }
  }

  it("detects missing dist/ as stale regardless of .git presence", () => {
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { missingDist: true });

    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, ["test-pkg"]);
  });

  it("detects stale src > dist timestamps in a git repo (dev clone)", () => {
    // Simulate a git repo by creating .git directory
    mkdirSync(join(tmp, ".git"), { recursive: true });
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { srcNewerThanDist: true });

    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, ["test-pkg"]);
  });

  it("skips staleness check when not in a git repo (npm tarball install)", () => {
    // No .git directory — simulates npm install from tarball
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { srcNewerThanDist: true });

    // Even though src/ is newer than dist/, the script should NOT detect it
    // as stale because we're in an npm tarball (no .git directory).
    // The timestamp difference is an artifact of npm tarball extraction.
    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, [], "should not detect staleness in npm tarball installs (no .git)");
  });

  it("still detects missing dist/ in npm tarball installs", () => {
    // No .git directory — simulates npm install from tarball
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { missingDist: true });

    // Missing dist/ should always be detected, even in npm installs
    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, ["test-pkg"]);
  });

  it("returns empty array when dist/ is up to date", () => {
    mkdirSync(join(tmp, ".git"), { recursive: true });
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg");
    // Default: timestamps are equal (both set by writeFileSync at ~same time)

    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, []);
  });
});
