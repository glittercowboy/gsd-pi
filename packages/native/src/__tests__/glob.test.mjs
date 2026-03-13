import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the native addon directly
const addonDir = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "native",
  "addon",
);
const platformTag = `${process.platform}-${process.arch}`;
const candidates = [
  path.join(addonDir, `gsd_engine.${platformTag}.node`),
  path.join(addonDir, "gsd_engine.dev.node"),
];

let native;
for (const candidate of candidates) {
  try {
    native = require(candidate);
    break;
  } catch {
    // try next
  }
}

if (!native) {
  console.error(
    "Native addon not found. Run `npm run build:native -w @gsd/native` first.",
  );
  process.exit(1);
}

describe("native glob: glob()", () => {
  test("finds files matching a pattern", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    fs.writeFileSync(path.join(tmpDir, "file1.ts"), "const a = 1;");
    fs.writeFileSync(path.join(tmpDir, "file2.ts"), "const b = 2;");
    fs.writeFileSync(path.join(tmpDir, "file3.js"), "const c = 3;");

    const result = await native.glob({ pattern: "*.ts", path: tmpDir });

    assert.equal(result.totalMatches, 2);
    assert.equal(result.matches.length, 2);
    const paths = result.matches.map((m) => m.path).sort();
    assert.deepEqual(paths, ["file1.ts", "file2.ts"]);
  });

  test("recursive matching into subdirectories", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.mkdirSync(path.join(tmpDir, "src", "nested"));
    fs.writeFileSync(path.join(tmpDir, "root.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "src", "nested", "b.ts"), "");

    const result = await native.glob({ pattern: "*.ts", path: tmpDir });

    assert.equal(result.totalMatches, 3);
    const paths = result.matches.map((m) => m.path).sort();
    assert.ok(paths.includes("root.ts"));
    assert.ok(paths.includes("src/a.ts"));
    assert.ok(paths.includes("src/nested/b.ts"));
  });

  test("respects maxResults limit", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), "");
    }

    const result = await native.glob({
      pattern: "*.txt",
      path: tmpDir,
      maxResults: 3,
    });

    assert.equal(result.matches.length, 3);
    assert.equal(result.totalMatches, 3);
  });

  test("filters by file type (directories only)", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    fs.mkdirSync(path.join(tmpDir, "dir1"));
    fs.mkdirSync(path.join(tmpDir, "dir2"));
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "");

    const result = await native.glob({
      pattern: "*",
      path: tmpDir,
      recursive: false,
      fileType: 2, // Dir
    });

    assert.equal(result.totalMatches, 2);
    const paths = result.matches.map((m) => m.path).sort();
    assert.deepEqual(paths, ["dir1", "dir2"]);
  });

  test("respects .gitignore", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    // Init a git repo so .gitignore is respected
    fs.mkdirSync(path.join(tmpDir, ".git"));
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(tmpDir, "kept.txt"), "");
    fs.writeFileSync(path.join(tmpDir, "ignored.txt"), "");

    const result = await native.glob({
      pattern: "*.txt",
      path: tmpDir,
      gitignore: true,
    });

    assert.equal(result.totalMatches, 1);
    assert.equal(result.matches[0].path, "kept.txt");
  });

  test("includes gitignored files when gitignore=false", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    fs.mkdirSync(path.join(tmpDir, ".git"));
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(tmpDir, "kept.txt"), "");
    fs.writeFileSync(path.join(tmpDir, "ignored.txt"), "");

    const result = await native.glob({
      pattern: "*.txt",
      path: tmpDir,
      gitignore: false,
    });

    assert.equal(result.totalMatches, 2);
  });

  test("skips node_modules by default", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    fs.mkdirSync(path.join(tmpDir, "node_modules"));
    fs.writeFileSync(path.join(tmpDir, "node_modules", "dep.js"), "");
    fs.writeFileSync(path.join(tmpDir, "app.js"), "");

    const result = await native.glob({
      pattern: "*.js",
      path: tmpDir,
      gitignore: false,
    });

    assert.equal(result.totalMatches, 1);
    assert.equal(result.matches[0].path, "app.js");
  });

  test("sortByMtime returns most recent first", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    fs.writeFileSync(path.join(tmpDir, "old.txt"), "old");
    // Ensure different mtime
    const now = new Date();
    fs.utimesSync(
      path.join(tmpDir, "old.txt"),
      new Date(now.getTime() - 5000),
      new Date(now.getTime() - 5000),
    );
    fs.writeFileSync(path.join(tmpDir, "new.txt"), "new");

    const result = await native.glob({
      pattern: "*.txt",
      path: tmpDir,
      sortByMtime: true,
    });

    assert.equal(result.totalMatches, 2);
    assert.equal(result.matches[0].path, "new.txt");
    assert.equal(result.matches[1].path, "old.txt");
  });

  test("errors on non-existent path", async () => {
    await assert.rejects(
      () =>
        native.glob({
          pattern: "*.txt",
          path: "/nonexistent/path/that/does/not/exist",
        }),
      /Path not found/,
    );
  });

  test("returns mtime for each entry", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    fs.writeFileSync(path.join(tmpDir, "test.txt"), "content");

    const result = await native.glob({ pattern: "*.txt", path: tmpDir });

    assert.equal(result.matches.length, 1);
    assert.ok(typeof result.matches[0].mtime === "number");
    // mtime should be within the last minute
    const oneMinuteAgo = Date.now() - 60_000;
    assert.ok(result.matches[0].mtime > oneMinuteAgo);
  });
});

describe("native glob: invalidateFsScanCache()", () => {
  test("can be called with a path", () => {
    // Should not throw
    native.invalidateFsScanCache("/tmp");
  });

  test("can be called without arguments", () => {
    // Should not throw
    native.invalidateFsScanCache();
  });
});
