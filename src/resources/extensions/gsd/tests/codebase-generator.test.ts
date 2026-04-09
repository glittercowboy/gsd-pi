import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

import {
  parseCodebaseMap,
  parseCodebaseMapMetadata,
  generateCodebaseMap,
  updateCodebaseMap,
  writeCodebaseMap,
  readCodebaseMap,
  getCodebaseMapStats,
  ensureCodebaseMapFresh,
} from "../codebase-generator.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTmpRepo(): string {
  const base = join(tmpdir(), `gsd-codebase-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  execSync("git init", { cwd: base, stdio: "ignore" });
  return base;
}

function addFile(base: string, path: string, content = ""): void {
  const fullPath = join(base, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content || `// ${path}\n`, "utf-8");
  execSync(`git add "${path}"`, { cwd: base, stdio: "ignore" });
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

// ─── parseCodebaseMap ────────────────────────────────────────────────────

test("parseCodebaseMap: parses file with description", () => {
  const content = `# Codebase Map

### src/
- \`main.ts\` — Application entry point
- \`utils.ts\` — Shared utilities
`;

  const map = parseCodebaseMap(content);
  assert.equal(map.size, 2);
  assert.equal(map.get("main.ts"), "Application entry point");
  assert.equal(map.get("utils.ts"), "Shared utilities");
});

test("parseCodebaseMap: parses file without description", () => {
  const content = `- \`config.ts\`\n- \`index.ts\` — Entry\n`;
  const map = parseCodebaseMap(content);
  assert.equal(map.size, 2);
  assert.equal(map.get("config.ts"), "");
  assert.equal(map.get("index.ts"), "Entry");
});

test("parseCodebaseMap: empty content returns empty map", () => {
  const map = parseCodebaseMap("");
  assert.equal(map.size, 0);
});

test("parseCodebaseMap: ignores non-matching lines", () => {
  const content = `# Codebase Map\n\nGenerated: 2026-03-23\n\n### src/\n- \`file.ts\` — desc\n`;
  const map = parseCodebaseMap(content);
  assert.equal(map.size, 1);
});

test("parseCodebaseMap: recovers descriptions from collapsed-description comments", () => {
  const content = `# Codebase Map

### src/components/
- *(25 files: 25 .ts)*
<!-- gsd:collapsed-descriptions
- \`src/components/Foo.ts\` — The Foo component
- \`src/components/Bar.ts\` — The Bar component
-->
`;
  const map = parseCodebaseMap(content);
  assert.equal(map.get("src/components/Foo.ts"), "The Foo component");
  assert.equal(map.get("src/components/Bar.ts"), "The Bar component");
  // The collapsed summary line itself should not be parsed as a file
  assert.ok(!map.has("*(25 files: 25 .ts)*"));
});

test("parseCodebaseMap: handles corrupted/malformed input gracefully", () => {
  const content = [
    "- `unclosed backtick",
    "- `` — empty filename",
    "- `valid.ts` — ok",
    "random garbage line",
    "- `a.ts` — desc with other text",
  ].join("\n");
  const map = parseCodebaseMap(content);
  assert.ok(map.has("valid.ts"));
  assert.ok(map.has("a.ts"));
  // Malformed lines should be silently skipped
  assert.equal(map.size, 2);
});

// ─── generateCodebaseMap ─────────────────────────────────────────────────

test("generateCodebaseMap: generates from git ls-files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");
    addFile(base, "README.md");

    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("# Codebase Map"));
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(result.content.includes("`src/utils.ts`"));
    assert.ok(result.content.includes("README.md"));
    assert.equal(result.fileCount, 3);
    assert.equal(result.truncated, false);
    assert.equal(result.files.length, 3);
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: excludes .gsd/ files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, ".gsd/PROJECT.md");

    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(!result.content.includes("PROJECT.md"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: excludes .claude/ and other tool directories", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, ".claude/CLAUDE.md");
    addFile(base, ".claude/memory/user.md");
    addFile(base, ".plans/plan.md");
    addFile(base, ".cursor/settings.json");
    addFile(base, ".vscode/settings.json");

    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts`"), "should include src/main.ts");
    assert.ok(!result.content.includes("CLAUDE.md"), "should exclude .claude/ files");
    assert.ok(!result.content.includes("user.md"), "should exclude .claude/memory/ files");
    assert.ok(!result.content.includes(".plans"), "should exclude .plans/ files");
    assert.ok(!result.content.includes(".cursor"), "should exclude .cursor/ files");
    assert.ok(!result.content.includes(".vscode"), "should exclude .vscode/ files");
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: excludes binary and lock files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "package-lock.json"); // .json not excluded
    addFile(base, "yarn.lock");         // .lock excluded
    addFile(base, "assets/logo.png");   // .png excluded

    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(result.content.includes("package-lock.json"));
    assert.ok(!result.content.includes("yarn.lock"));
    assert.ok(!result.content.includes("logo.png"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: respects custom excludePatterns", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "docs/guide.md");
    addFile(base, "docs/api.md");

    const result = generateCodebaseMap(base, { excludePatterns: ["docs/"] });
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(!result.content.includes("guide.md"));
    assert.ok(!result.content.includes("api.md"));
    assert.equal(result.fileCount, 1);
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: preserves existing descriptions", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");

    const descriptions = new Map<string, string>();
    descriptions.set("src/main.ts", "App entry point");

    const result = generateCodebaseMap(base, undefined, descriptions);
    assert.ok(result.content.includes("`src/main.ts` — App entry point"));
    assert.ok(result.content.includes("`src/utils.ts`"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: writes freshness metadata comment", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");

    const result = generateCodebaseMap(base);
    const metadata = parseCodebaseMapMetadata(result.content);

    assert.ok(metadata, "metadata comment should be present");
    assert.equal(metadata?.fileCount, 1);
    assert.equal(metadata?.truncated, false);
    assert.equal(typeof metadata?.fingerprint, "string");
    assert.ok(metadata?.generatedAt?.endsWith("Z"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: collapses large directories", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 25; i++) {
      addFile(base, `src/components/comp${String(i).padStart(2, "0")}.ts`);
    }

    const result = generateCodebaseMap(base);
    // Collapsed summary should appear
    assert.ok(result.content.includes("*(25 files: 25 .ts)*"));
    // Individual file entries should NOT appear in main body
    assert.ok(!result.content.includes("`src/components/comp00.ts`\n"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: respects custom collapseThreshold", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 5; i++) addFile(base, `src/comp${i}.ts`);

    // Low threshold: 5 files should collapse
    const collapsed = generateCodebaseMap(base, { collapseThreshold: 3 });
    assert.ok(collapsed.content.includes("5 files"));

    // High threshold: 5 files should expand
    const expanded = generateCodebaseMap(base, { collapseThreshold: 10 });
    assert.ok(expanded.content.includes("`src/comp0.ts`"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: truncated=false when file count is below maxFiles", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 4; i++) addFile(base, `file${i}.ts`);
    const result = generateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.fileCount, 4);
    assert.equal(result.truncated, false);
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: truncated=false when file count equals maxFiles exactly", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 5; i++) addFile(base, `file${i}.ts`);
    const result = generateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.fileCount, 5);
    assert.equal(result.truncated, false); // exactly at limit — nothing was truncated
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: truncated=true when file count exceeds maxFiles", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 10; i++) addFile(base, `file${i}.ts`);
    const result = generateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.fileCount, 5);
    assert.equal(result.truncated, true);
    assert.ok(result.content.includes("Truncated"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: returns empty map for non-git directory", () => {
  const base = join(tmpdir(), `gsd-codebase-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  // No git init
  try {
    const result = generateCodebaseMap(base);
    assert.equal(result.fileCount, 0);
    assert.equal(result.truncated, false);
    assert.ok(result.content.includes("# Codebase Map"));
    assert.equal(result.files.length, 0);
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: handles empty repository (no committed files)", () => {
  const base = makeTmpRepo();
  try {
    const result = generateCodebaseMap(base);
    assert.equal(result.fileCount, 0);
    assert.equal(result.truncated, false);
    assert.ok(result.content.includes("Files: 0"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: collapsed directories preserve descriptions in hidden comment", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 25; i++) {
      addFile(base, `src/components/comp${String(i).padStart(2, "0")}.ts`);
    }

    // Generate with a description for one file in the collapsed dir
    const descriptions = new Map([["src/components/comp00.ts", "The first component"]]);
    const result = generateCodebaseMap(base, undefined, descriptions);

    // The description should be in the hidden comment block
    assert.ok(result.content.includes("<!-- gsd:collapsed-descriptions"));
    assert.ok(result.content.includes("`src/components/comp00.ts` — The first component"));

    // Re-parsing should recover the description
    const recovered = parseCodebaseMap(result.content);
    assert.equal(recovered.get("src/components/comp00.ts"), "The first component");
  } finally {
    cleanup(base);
  }
});

// ─── updateCodebaseMap ───────────────────────────────────────────────────

test("updateCodebaseMap: preserves descriptions on update", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");

    const initial = generateCodebaseMap(base, undefined, new Map([["src/main.ts", "Entry point"]]));
    writeCodebaseMap(base, initial.content);

    addFile(base, "src/new.ts");

    const result = updateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts` — Entry point"));
    assert.equal(result.added, 1);
    assert.equal(result.fileCount, 3);
  } finally {
    cleanup(base);
  }
});

test("updateCodebaseMap: tracks removed files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/keep.ts");
    addFile(base, "src/remove.ts");
    // Commit so git rm can operate
    execSync("git -c user.email=t@t.com -c user.name=T commit -m init", { cwd: base, stdio: "ignore" });

    const initial = generateCodebaseMap(base);
    writeCodebaseMap(base, initial.content);

    execSync("git rm src/remove.ts", { cwd: base, stdio: "ignore" });

    const result = updateCodebaseMap(base);
    assert.equal(result.removed, 1);
    assert.equal(result.unchanged, 1);
    assert.equal(result.fileCount, 1);
    assert.ok(!result.content.includes("remove.ts"));
  } finally {
    cleanup(base);
  }
});

test("updateCodebaseMap: propagates truncated flag", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 10; i++) addFile(base, `file${i}.ts`);

    const initial = generateCodebaseMap(base, { maxFiles: 5 });
    writeCodebaseMap(base, initial.content);

    const result = updateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.truncated, true);
  } finally {
    cleanup(base);
  }
});

test("updateCodebaseMap: preserves descriptions from collapsed directories", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 25; i++) {
      addFile(base, `src/components/comp${String(i).padStart(2, "0")}.ts`);
    }

    // Generate with a description in the (collapsed) components dir
    const descriptions = new Map([["src/components/comp00.ts", "The first component"]]);
    const initial = generateCodebaseMap(base, undefined, descriptions);
    writeCodebaseMap(base, initial.content);

    // Update should recover description from the hidden comment
    const result = updateCodebaseMap(base);
    const recovered = parseCodebaseMap(result.content);
    assert.equal(recovered.get("src/components/comp00.ts"), "The first component");
  } finally {
    cleanup(base);
  }
});

// ─── writeCodebaseMap / readCodebaseMap ──────────────────────────────────

test("writeCodebaseMap + readCodebaseMap roundtrip", () => {
  const base = makeTmpRepo();
  try {
    const content = "# Codebase Map\n\n- `test.ts` — A test file\n";
    const outPath = writeCodebaseMap(base, content);
    assert.ok(existsSync(outPath));

    const read = readCodebaseMap(base);
    assert.equal(read, content);
  } finally {
    cleanup(base);
  }
});

test("readCodebaseMap: returns null when file missing", () => {
  const base = makeTmpRepo();
  try {
    const result = readCodebaseMap(base);
    assert.equal(result, null);
  } finally {
    cleanup(base);
  }
});

test("writeCodebaseMap: creates .gsd/ directory if missing", () => {
  const base = join(tmpdir(), `gsd-codebase-test-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  // Intentionally do NOT pre-create .gsd/
  try {
    const outPath = writeCodebaseMap(base, "# Codebase Map\n");
    assert.ok(existsSync(outPath));
  } finally {
    cleanup(base);
  }
});

// ─── getCodebaseMapStats ─────────────────────────────────────────────────

test("getCodebaseMapStats: no map returns exists=false", () => {
  const base = makeTmpRepo();
  try {
    const stats = getCodebaseMapStats(base);
    assert.equal(stats.exists, false);
    assert.equal(stats.fileCount, 0);
  } finally {
    cleanup(base);
  }
});

test("getCodebaseMapStats: reports coverage", () => {
  const base = makeTmpRepo();
  try {
    const content = `# Codebase Map\n\nGenerated: 2026-03-23T14:00:00Z | Files: 3 | Described: 2/3\n\n- \`a.ts\` — Has desc\n- \`b.ts\`\n- \`c.ts\` — Also has\n`;
    writeCodebaseMap(base, content);

    const stats = getCodebaseMapStats(base);
    assert.equal(stats.exists, true);
    assert.equal(stats.fileCount, 3); // from header, not parse count
    assert.equal(stats.describedCount, 2);
    assert.equal(stats.undescribedCount, 1);
    assert.equal(stats.generatedAt, "2026-03-23T14:00:00Z");
  } finally {
    cleanup(base);
  }
});

test("getCodebaseMapStats: reads total file count from header for accuracy with collapsed dirs", () => {
  const base = makeTmpRepo();
  try {
    // Simulate a map with a collapsed dir: header says 30 files but parser only sees 2
    const content = [
      "# Codebase Map",
      "",
      "Generated: 2026-03-23T14:00:00Z | Files: 30 | Described: 2/30",
      "",
      "### src/components/",
      "- *(28 files: 28 .ts)*",
      "",
      "### src/",
      "- `main.ts` — Entry point",
      "- `utils.ts` — Utilities",
    ].join("\n");
    writeCodebaseMap(base, content);

    const stats = getCodebaseMapStats(base);
    assert.equal(stats.fileCount, 30); // from header, not from parseCodebaseMap
    assert.equal(stats.describedCount, 2);
    assert.equal(stats.undescribedCount, 28);
  } finally {
    cleanup(base);
  }
});

// ─── excludePatterns from options ────────────────────────────────────────

test("generateCodebaseMap: custom excludePatterns filters additional directories", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");
    addFile(base, ".cache-data/data/index.lance");
    addFile(base, "docs/guide.md");

    const result = generateCodebaseMap(base, {
      excludePatterns: [".cache-data/", "docs/"],
    });
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(result.content.includes("`src/utils.ts`"));
    assert.ok(!result.content.includes(".cache-data"));
    assert.ok(!result.content.includes("guide.md"));
    assert.equal(result.fileCount, 2);
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: collapseThreshold option overrides default", () => {
  const base = makeTmpRepo();
  try {
    // Create 10 files in one directory — below default threshold (20)
    // but above a custom threshold of 5
    for (let i = 0; i < 10; i++) {
      addFile(base, `src/comp${i}.ts`);
    }

    // With default threshold (20), files should NOT collapse
    const expanded = generateCodebaseMap(base);
    assert.ok(expanded.content.includes("`src/comp0.ts`"));

    // With custom threshold (5), files SHOULD collapse
    const collapsed = generateCodebaseMap(base, { collapseThreshold: 5 });
    assert.ok(collapsed.content.includes("10 files"));
    assert.ok(!collapsed.content.includes("`src/comp0.ts`\n"));
  } finally {
    cleanup(base);
  }
});

test("updateCodebaseMap: respects excludePatterns option", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "vendor-extra/lib.js");

    const initial = generateCodebaseMap(base);
    writeCodebaseMap(base, initial.content);

    // Update with exclusion should remove vendor-extra files
    const result = updateCodebaseMap(base, { excludePatterns: ["vendor-extra/"] });
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(!result.content.includes("vendor-extra"));
  } finally {
    cleanup(base);
  }
});

test("ensureCodebaseMapFresh: generates CODEBASE.md when missing", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");

    const result = ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });
    const written = readCodebaseMap(base);

    assert.equal(result.status, "generated");
    assert.ok(written?.includes("`src/main.ts`"));
  } finally {
    cleanup(base);
  }
});

test("ensureCodebaseMapFresh: updates CODEBASE.md when tracked files change", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    const initial = ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });
    assert.equal(initial.status, "generated");

    addFile(base, "src/new.ts");
    const refreshed = ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });
    const written = readCodebaseMap(base);

    assert.equal(refreshed.status, "updated");
    assert.equal(refreshed.reason, "files-changed");
    assert.ok(written?.includes("`src/new.ts`"));
  } finally {
    cleanup(base);
  }
});

test("ensureCodebaseMapFresh: returns fresh when metadata matches repository state", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });

    const refreshed = ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });
    assert.equal(refreshed.status, "fresh");
    assert.equal(refreshed.fileCount, 1);
  } finally {
    cleanup(base);
  }
});
