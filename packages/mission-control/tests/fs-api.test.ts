import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { listDirectory, detectProject, validatePath } from "../src/server/fs-api";

const TEST_DIR = join(tmpdir(), `gsd-fs-test-${Date.now()}`);

beforeAll(async () => {
  // Create test directory structure:
  // test-dir/
  //   regular-dir/
  //   gsd-project/
  //     .gsd/
  //   .hidden-dir/
  //   node_modules/
  //   file.txt
  await mkdir(join(TEST_DIR, "regular-dir"), { recursive: true });
  await mkdir(join(TEST_DIR, "gsd-project", ".gsd"), { recursive: true });
  await mkdir(join(TEST_DIR, ".hidden-dir"), { recursive: true });
  await mkdir(join(TEST_DIR, "node_modules"), { recursive: true });
  await writeFile(join(TEST_DIR, "file.txt"), "hello");
  await writeFile(join(TEST_DIR, "another.txt"), "world");
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("listDirectory", () => {
  it("returns FileSystemEntry[] with correct fields", async () => {
    const entries = await listDirectory(TEST_DIR);
    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.path).toBe("string");
      expect(typeof entry.isDirectory).toBe("boolean");
      expect(typeof entry.isGsdProject).toBe("boolean");
      // Paths use forward slashes
      expect(entry.path).not.toContain("\\");
    }
  });

  it("sorts directories first, then alphabetical", async () => {
    const entries = await listDirectory(TEST_DIR);
    const dirs = entries.filter((e) => e.isDirectory);
    const files = entries.filter((e) => !e.isDirectory);
    // Directories come before files
    const lastDirIdx = entries.findIndex((e) => !e.isDirectory);
    if (lastDirIdx > 0) {
      for (let i = 0; i < lastDirIdx; i++) {
        expect(entries[i].isDirectory).toBe(true);
      }
    }
    // Within each group, alphabetical
    for (let i = 1; i < dirs.length; i++) {
      expect(dirs[i].name.localeCompare(dirs[i - 1].name)).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < files.length; i++) {
      expect(files[i].name.localeCompare(files[i - 1].name)).toBeGreaterThanOrEqual(0);
    }
  });

  it("excludes hidden files (starting with .)", async () => {
    const entries = await listDirectory(TEST_DIR);
    const hidden = entries.filter((e) => e.name.startsWith("."));
    expect(hidden.length).toBe(0);
  });

  it("excludes node_modules and other noise directories", async () => {
    const entries = await listDirectory(TEST_DIR);
    const noise = entries.filter((e) => e.name === "node_modules" || e.name === ".git");
    expect(noise.length).toBe(0);
  });

  it("detects GSD projects (directories with .gsd/)", async () => {
    const entries = await listDirectory(TEST_DIR);
    const gsdEntry = entries.find((e) => e.name === "gsd-project");
    expect(gsdEntry).toBeDefined();
    expect(gsdEntry!.isGsdProject).toBe(true);
  });

  it("marks non-GSD directories as isGsdProject: false", async () => {
    const entries = await listDirectory(TEST_DIR);
    const regularDir = entries.find((e) => e.name === "regular-dir");
    expect(regularDir).toBeDefined();
    expect(regularDir!.isGsdProject).toBe(false);
  });

  it("rejects path traversal attempts (..)", async () => {
    // Use raw string to avoid join() resolving the ..
    expect(() => validatePath(TEST_DIR + "/../etc")).toThrow();
  });

  it("returns error for non-existent path", async () => {
    const result = await listDirectory(join(TEST_DIR, "nonexistent"));
    // Should return an error or empty - implementation decides
    // The function should not throw but return gracefully
    expect(result).toBeDefined();
  });
});

describe("detectProject", () => {
  it("returns isGsdProject: true for directories with .gsd/", async () => {
    const result = await detectProject(join(TEST_DIR, "gsd-project"));
    expect(result.isGsdProject).toBe(true);
    expect(result.path).not.toContain("\\");
  });

  it("returns isGsdProject: false for regular directories", async () => {
    const result = await detectProject(join(TEST_DIR, "regular-dir"));
    expect(result.isGsdProject).toBe(false);
  });
});

describe("validatePath", () => {
  it("accepts absolute paths without traversal", () => {
    expect(() => validatePath(TEST_DIR)).not.toThrow();
  });

  it("rejects paths with .. segments", () => {
    expect(() => validatePath("/some/path/../etc")).toThrow();
  });

  it("rejects paths that resolve outside allowed root", () => {
    expect(() => validatePath("/some/../../../etc", "/some")).toThrow();
  });
});
