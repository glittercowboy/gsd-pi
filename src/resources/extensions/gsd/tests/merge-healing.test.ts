/**
 * merge-healing.test.ts — Tests for the three-tier merge conflict resolution pipeline.
 *
 * Covers:
 *   - readConflictContent: standard conflict markers, no markers, multiple regions
 *   - appendMergeLog: file creation with header, append behavior, markdown format
 *   - resolveDeterministic: tier-1 resolution of .gsd/ files in real git repos
 *
 * Unit tests need no git. Integration tests use temp repos with real
 * git operations (same pattern as parallel-merge.test.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  readConflictContent,
  appendMergeLog,
  resolveDeterministic,
  resolveMergeConflicts,
  buildMergeHealPrompt,
  parseMergeHealResponse,
  resolveLLM,
  DEFAULT_CONFIDENCE_THRESHOLD,
  type FileResolution,
  type HealingAttempt,
  type MergeHealResult,
  type MergeLogEntry,
} from "../merge-healing.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd: string, cwd: string): string {
  return execSync(cmd, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "merge-healing-test-")),
  );
  run("git init -b main", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\ninitial content\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  return dir;
}

function createMilestoneBranch(
  repo: string,
  mid: string,
  files: Array<{ name: string; content: string }>,
): void {
  run(`git checkout -b milestone/${mid}`, repo);
  for (const f of files) {
    const dirPath = join(repo, ...f.name.split("/").slice(0, -1));
    if (dirPath !== repo) mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(repo, f.name), f.content);
  }
  run("git add .", repo);
  run(`git commit -m "feat(${mid}): add files"`, repo);
  run("git checkout main", repo);
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT_CONFIDENCE_THRESHOLD — Constant validation
// ═══════════════════════════════════════════════════════════════════════════════

test("DEFAULT_CONFIDENCE_THRESHOLD is 0.8", () => {
  assert.equal(DEFAULT_CONFIDENCE_THRESHOLD, 0.8);
});

// ═══════════════════════════════════════════════════════════════════════════════
// readConflictContent — Unit tests (no git required)
// ═══════════════════════════════════════════════════════════════════════════════

test("readConflictContent — parses standard two-way conflict markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "conflict-parse-"));
  const file = join(dir, "test.ts");
  writeFileSync(
    file,
    [
      "line before",
      "<<<<<<< HEAD",
      "const x = 1;",
      "const y = 2;",
      "=======",
      "const x = 10;",
      "const y = 20;",
      ">>>>>>> milestone/M001",
      "line after",
    ].join("\n"),
  );

  const result = readConflictContent(file);
  assert.ok(result, "should return a result");
  assert.equal(result.ours, "const x = 1;\nconst y = 2;");
  assert.equal(result.theirs, "const x = 10;\nconst y = 20;");

  cleanup(dir);
});

test("readConflictContent — returns null when no conflict markers found", () => {
  const dir = mkdtempSync(join(tmpdir(), "conflict-nomarkers-"));
  const file = join(dir, "clean.ts");
  writeFileSync(file, "const x = 1;\nconst y = 2;\n");

  const result = readConflictContent(file);
  assert.equal(result, null);

  cleanup(dir);
});

test("readConflictContent — handles multiple conflict regions", () => {
  const dir = mkdtempSync(join(tmpdir(), "conflict-multi-"));
  const file = join(dir, "multi.ts");
  writeFileSync(
    file,
    [
      "// header",
      "<<<<<<< HEAD",
      "const a = 1;",
      "=======",
      "const a = 100;",
      ">>>>>>> branch",
      "// middle",
      "<<<<<<< HEAD",
      "const b = 2;",
      "=======",
      "const b = 200;",
      ">>>>>>> branch",
      "// footer",
    ].join("\n"),
  );

  const result = readConflictContent(file);
  assert.ok(result, "should return a result");
  assert.equal(result.ours, "const a = 1;\nconst b = 2;");
  assert.equal(result.theirs, "const a = 100;\nconst b = 200;");

  cleanup(dir);
});

test("readConflictContent — handles single-line conflict regions", () => {
  const dir = mkdtempSync(join(tmpdir(), "conflict-single-"));
  const file = join(dir, "single.ts");
  writeFileSync(
    file,
    [
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> branch",
    ].join("\n"),
  );

  const result = readConflictContent(file);
  assert.ok(result);
  assert.equal(result.ours, "ours");
  assert.equal(result.theirs, "theirs");

  cleanup(dir);
});

// ═══════════════════════════════════════════════════════════════════════════════
// appendMergeLog — Unit tests (no git required)
// ═══════════════════════════════════════════════════════════════════════════════

test("appendMergeLog — creates MERGE-LOG.md with header on first write", () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelog-create-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const entry: MergeLogEntry = {
    timestamp: "2025-01-15T10:00:00.000Z",
    milestoneId: "M001",
    tier: 1,
    filePath: ".gsd/STATE.md",
    resolution: "worktree version accepted",
    explanation: "Deterministic: accept worktree version for .gsd/ file",
    outcome: "applied",
  };

  appendMergeLog(dir, entry);

  const logPath = join(dir, ".gsd", "MERGE-LOG.md");
  assert.ok(existsSync(logPath), "MERGE-LOG.md should be created");

  const content = readFileSync(logPath, "utf-8");
  assert.ok(content.startsWith("# MERGE-LOG"), "should have header");
  assert.ok(content.includes("tier-1"), "should include tier");
  assert.ok(content.includes(".gsd/STATE.md"), "should include file path");
  assert.ok(content.includes("applied"), "should include outcome");

  cleanup(dir);
});

test("appendMergeLog — appends multiple entries sequentially", () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelog-append-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const entry1: MergeLogEntry = {
    timestamp: "2025-01-15T10:00:00.000Z",
    milestoneId: "M001",
    tier: 1,
    filePath: ".gsd/STATE.md",
    resolution: "worktree version",
    explanation: "Deterministic resolution",
    outcome: "applied",
  };

  const entry2: MergeLogEntry = {
    timestamp: "2025-01-15T10:01:00.000Z",
    milestoneId: "M001",
    tier: 2,
    filePath: "src/app.ts",
    resolution: "merged code",
    explanation: "LLM resolved conflict",
    confidence: 0.92,
    outcome: "applied",
  };

  appendMergeLog(dir, entry1);
  appendMergeLog(dir, entry2);

  const content = readFileSync(join(dir, ".gsd", "MERGE-LOG.md"), "utf-8");

  // Both entries should be present
  assert.ok(content.includes("tier-1: .gsd/STATE.md"), "entry 1");
  assert.ok(content.includes("tier-2: src/app.ts"), "entry 2");
  assert.ok(content.includes("Confidence:** 0.92"), "confidence for tier-2");
});

test("appendMergeLog — includes confidence only when provided", () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelog-noconf-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const entry: MergeLogEntry = {
    timestamp: "2025-01-15T10:00:00.000Z",
    milestoneId: "M001",
    tier: 1,
    filePath: ".gsd/STATE.md",
    resolution: "worktree version",
    explanation: "Deterministic resolution",
    outcome: "applied",
    // no confidence field
  };

  appendMergeLog(dir, entry);

  const content = readFileSync(join(dir, ".gsd", "MERGE-LOG.md"), "utf-8");
  assert.ok(!content.includes("Confidence:"), "should not include confidence line");

  cleanup(dir);
});

test("appendMergeLog — truncates resolution to 5 lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelog-truncate-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const longResolution = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

  const entry: MergeLogEntry = {
    timestamp: "2025-01-15T10:00:00.000Z",
    milestoneId: "M001",
    tier: 2,
    filePath: "src/app.ts",
    resolution: longResolution,
    explanation: "LLM resolved",
    confidence: 0.9,
    outcome: "applied",
  };

  appendMergeLog(dir, entry);

  const content = readFileSync(join(dir, ".gsd", "MERGE-LOG.md"), "utf-8");
  assert.ok(content.includes("line 1"), "first line present");
  assert.ok(content.includes("line 5"), "fifth line present");
  assert.ok(!content.includes("line 6"), "sixth line should be truncated");
  assert.ok(content.includes("..."), "should have truncation indicator");

  cleanup(dir);
});

test("appendMergeLog — produces valid markdown structure", () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelog-md-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const entry: MergeLogEntry = {
    timestamp: "2025-01-15T10:00:00.000Z",
    milestoneId: "M001",
    tier: 1,
    filePath: ".gsd/STATE.md",
    resolution: "content here",
    explanation: "Test explanation",
    outcome: "applied",
  };

  appendMergeLog(dir, entry);

  const content = readFileSync(join(dir, ".gsd", "MERGE-LOG.md"), "utf-8");

  // Verify markdown structure
  assert.ok(
    content.includes("## [2025-01-15T10:00:00.000Z] tier-1: .gsd/STATE.md"),
    "should have proper heading format",
  );
  assert.ok(content.includes("- **Milestone:** M001"), "milestone bullet");
  assert.ok(content.includes("- **Resolution:**"), "resolution bullet");
  assert.ok(content.includes("- **Explanation:** Test explanation"), "explanation bullet");
  assert.ok(content.includes("- **Outcome:** applied"), "outcome bullet");
  assert.ok(content.includes("```"), "should have code fence for resolution");

  cleanup(dir);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Type exports — verify types are importable
// ═══════════════════════════════════════════════════════════════════════════════

test("type exports — FileResolution, HealingAttempt, MergeHealResult are importable", () => {
  // TypeScript compile-time check — if these imports failed, the file wouldn't load
  const resolution: FileResolution = {
    filePath: "test.ts",
    tier: 1,
    resolution: "applied",
    explanation: "test",
  };
  assert.equal(resolution.tier, 1);

  const attempt: HealingAttempt = {
    tier: 1,
    filesAttempted: ["a.ts"],
    filesResolved: ["a.ts"],
    filesEscalated: [],
  };
  assert.equal(attempt.tier, 1);

  const result: MergeHealResult = {
    resolved: true,
    tier: 1,
    resolutions: [resolution],
    healingAttempts: [attempt],
    unresolvedFiles: [],
    log: "",
  };
  assert.equal(result.resolved, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// resolveDeterministic — Integration tests (real git)
// ═══════════════════════════════════════════════════════════════════════════════

test("resolveDeterministic — resolves .gsd/ conflict in real git repo", async () => {
  const repo = createTempRepo();

  try {
    // Create milestone branch that modifies .gsd/STATE.md
    run("git checkout -b milestone/M010", repo);
    writeFileSync(
      join(repo, ".gsd", "STATE.md"),
      "# State\nmilestone M010 version\n",
    );
    run("git add .", repo);
    run('git commit -m "M010 changes STATE.md"', repo);
    run("git checkout main", repo);

    // Modify .gsd/STATE.md on main to create conflict
    writeFileSync(
      join(repo, ".gsd", "STATE.md"),
      "# State\nmain diverged version\n",
    );
    run("git add .", repo);
    run('git commit -m "main changes STATE.md"', repo);

    // Attempt merge — this will fail with conflict
    try {
      run("git merge milestone/M010 --no-ff", repo);
      assert.fail("merge should have conflicted");
    } catch {
      // Expected — merge conflict
    }

    // Verify conflict exists
    const conflictFiles = run(
      "git diff --name-only --diff-filter=U",
      repo,
    ).split("\n").filter(Boolean);
    assert.ok(
      conflictFiles.includes(".gsd/STATE.md"),
      "STATE.md should be in conflict",
    );

    // Run tier-1 deterministic resolution
    const resolutions = resolveDeterministic(repo, conflictFiles, "M010");

    // Verify resolution
    assert.equal(resolutions.length, 1, "should resolve 1 file");
    assert.equal(resolutions[0]!.filePath, ".gsd/STATE.md");
    assert.equal(resolutions[0]!.tier, 1);
    assert.equal(resolutions[0]!.resolution, "applied");

    // Verify file is staged (no conflict markers)
    const stateContent = readFileSync(
      join(repo, ".gsd", "STATE.md"),
      "utf-8",
    );
    assert.ok(
      !stateContent.includes("<<<<<<<"),
      "should not have conflict markers",
    );
    assert.ok(
      stateContent.includes("milestone M010 version"),
      "should have milestone version (theirs)",
    );

    // Verify no more unmerged files for .gsd/STATE.md
    const remainingConflicts = run(
      "git diff --name-only --diff-filter=U",
      repo,
    );
    assert.ok(
      !remainingConflicts.includes(".gsd/STATE.md"),
      "STATE.md should no longer be in conflict",
    );

    // Verify MERGE-LOG.md was created with tier-1 entry
    const logPath = join(repo, ".gsd", "MERGE-LOG.md");
    assert.ok(existsSync(logPath), "MERGE-LOG.md should exist");

    const logContent = readFileSync(logPath, "utf-8");
    assert.ok(logContent.includes("tier-1"), "should have tier-1 entry");
    assert.ok(
      logContent.includes(".gsd/STATE.md"),
      "should reference the resolved file",
    );
    assert.ok(logContent.includes("M010"), "should reference milestone");
    assert.ok(logContent.includes("applied"), "should show applied outcome");
  } finally {
    try {
      run("git merge --abort", repo);
    } catch {
      /* may not be in merge state */
    }
    cleanup(repo);
  }
});

test("resolveDeterministic — skips non-.gsd/ files", () => {
  const dir = mkdtempSync(join(tmpdir(), "resolve-skip-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  // Call with non-.gsd/ files — should return empty
  const conflictFiles = ["src/app.ts", "README.md", "package.json"];
  const resolutions = resolveDeterministic(dir, conflictFiles, "M001");

  assert.equal(resolutions.length, 0, "should not resolve non-.gsd/ files");

  // MERGE-LOG.md should not be created (no resolutions)
  assert.ok(
    !existsSync(join(dir, ".gsd", "MERGE-LOG.md")),
    "MERGE-LOG.md should not be created when nothing resolved",
  );

  cleanup(dir);
});

test("resolveDeterministic — resolves multiple .gsd/ files, ignores non-.gsd/", async () => {
  const repo = createTempRepo();

  try {
    // Add another .gsd/ file
    mkdirSync(join(repo, ".gsd", "milestones"), { recursive: true });
    writeFileSync(
      join(repo, ".gsd", "milestones", "M010-ROADMAP.md"),
      "# Roadmap\ninitial\n",
    );
    run("git add .", repo);
    run('git commit -m "add roadmap"', repo);

    // Create milestone branch that modifies both .gsd/ files
    run("git checkout -b milestone/M010", repo);
    writeFileSync(
      join(repo, ".gsd", "STATE.md"),
      "# State\nM010 version\n",
    );
    writeFileSync(
      join(repo, ".gsd", "milestones", "M010-ROADMAP.md"),
      "# Roadmap\nM010 version\n",
    );
    writeFileSync(join(repo, "src-app.ts"), "// M010 code\n");
    run("git add .", repo);
    run('git commit -m "M010 changes"', repo);
    run("git checkout main", repo);

    // Create diverging changes on main
    writeFileSync(
      join(repo, ".gsd", "STATE.md"),
      "# State\nmain diverged\n",
    );
    writeFileSync(
      join(repo, ".gsd", "milestones", "M010-ROADMAP.md"),
      "# Roadmap\nmain diverged\n",
    );
    writeFileSync(join(repo, "src-app.ts"), "// main code\n");
    run("git add .", repo);
    run('git commit -m "main diverges"', repo);

    // Attempt merge
    try {
      run("git merge milestone/M010 --no-ff", repo);
      assert.fail("merge should have conflicted");
    } catch {
      // Expected
    }

    // Get actual conflict files
    const conflictFiles = run(
      "git diff --name-only --diff-filter=U",
      repo,
    ).split("\n").filter(Boolean);

    // Add a non-.gsd/ file to the list to verify filtering
    const allFiles = [...conflictFiles, "src/extra.ts"];

    const resolutions = resolveDeterministic(repo, allFiles, "M010");

    // Should only resolve .gsd/ files
    const gsdResolutions = resolutions.filter((r) =>
      r.filePath.startsWith(".gsd/"),
    );
    assert.equal(
      gsdResolutions.length,
      resolutions.length,
      "all resolutions should be .gsd/ files",
    );
    assert.ok(
      resolutions.length >= 2,
      `should resolve at least 2 .gsd/ files, got ${resolutions.length}`,
    );
    assert.ok(
      !resolutions.some((r) => r.filePath === "src/extra.ts"),
      "should not resolve non-.gsd/ files",
    );

    // Verify MERGE-LOG.md has entries for each resolved file
    const logContent = readFileSync(
      join(repo, ".gsd", "MERGE-LOG.md"),
      "utf-8",
    );
    for (const r of resolutions) {
      assert.ok(
        logContent.includes(r.filePath),
        `log should contain entry for ${r.filePath}`,
      );
    }
  } finally {
    try {
      run("git merge --abort", repo);
    } catch {
      /* may not be in merge state */
    }
    cleanup(repo);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseMergeHealResponse — Unit tests
// ═══════════════════════════════════════════════════════════════════════════════

test("parseMergeHealResponse — extracts content, confidence, and explanation from well-formed response", () => {
  const response = [
    "I analyzed both sides of the conflict.",
    "",
    "~~~resolved",
    "const x = 10;",
    "const y = 2;",
    "~~~",
    "",
    "Confidence: 0.9",
    "",
    "I merged the value of x from theirs and kept y from ours.",
  ].join("\n");

  const result = parseMergeHealResponse(response);
  assert.equal(result.content, "const x = 10;\nconst y = 2;");
  assert.equal(result.confidence, 0.9);
  assert.ok(result.explanation.includes("merged the value of x"));
});

test("parseMergeHealResponse — normalizes percentage confidence to decimal", () => {
  const response = [
    "~~~resolved",
    "resolved code",
    "~~~",
    "",
    "Confidence: 90%",
    "",
    "High confidence merge.",
  ].join("\n");

  const result = parseMergeHealResponse(response);
  assert.equal(result.content, "resolved code");
  assert.equal(result.confidence, 0.9);
});

test("parseMergeHealResponse — returns null content and 0.0 confidence when fence markers missing", () => {
  const response = "I tried to resolve the conflict but here is my attempt:\nconst x = 42;\nConfidence: 0.85";

  const result = parseMergeHealResponse(response);
  assert.equal(result.content, null);
  assert.equal(result.confidence, 0.0, "confidence should be forced to 0.0 when content is null");
  assert.ok(result.explanation.includes("tried to resolve"));
});

test("parseMergeHealResponse — defaults confidence to 0.0 when line missing", () => {
  const response = [
    "~~~resolved",
    "const x = 1;",
    "~~~",
    "",
    "I resolved the conflict.",
  ].join("\n");

  const result = parseMergeHealResponse(response);
  assert.equal(result.content, "const x = 1;");
  assert.equal(result.confidence, 0.0, "should default to 0.0 when confidence line missing");
  assert.ok(result.explanation.includes("resolved the conflict"));
});

test("parseMergeHealResponse — handles empty response", () => {
  const result = parseMergeHealResponse("");
  assert.equal(result.content, null);
  assert.equal(result.confidence, 0.0);
  assert.equal(result.explanation, "");
});

test("parseMergeHealResponse — handles whitespace-only response", () => {
  const result = parseMergeHealResponse("   \n\n   ");
  assert.equal(result.content, null);
  assert.equal(result.confidence, 0.0);
  assert.equal(result.explanation, "");
});

test("parseMergeHealResponse — clamps confidence > 1.0 from raw decimal", () => {
  const response = [
    "~~~resolved",
    "code",
    "~~~",
    "",
    "Confidence: 1.5",
  ].join("\n");

  const result = parseMergeHealResponse(response);
  assert.equal(result.confidence, 1.0, "should clamp to 1.0");
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildMergeHealPrompt — Unit tests
// ═══════════════════════════════════════════════════════════════════════════════

test("buildMergeHealPrompt — includes filePath and both sides of conflict", () => {
  const prompt = buildMergeHealPrompt(
    { ours: "const x = 1;", theirs: "const x = 10;" },
    "src/utils.ts",
  );

  assert.ok(prompt.includes("src/utils.ts"), "should contain file path");
  assert.ok(prompt.includes("const x = 1;"), "should contain ours content");
  assert.ok(prompt.includes("const x = 10;"), "should contain theirs content");
  assert.ok(prompt.includes("~~~resolved"), "should include output format instructions");
  assert.ok(prompt.includes("Confidence:"), "should include confidence instructions");
});

test("buildMergeHealPrompt — works with empty optional params", () => {
  // Should not throw when sliceSummaries and domainContext are undefined
  const prompt = buildMergeHealPrompt(
    { ours: "a", theirs: "b" },
    "test.ts",
  );
  assert.ok(prompt.length > 0, "should produce a non-empty prompt");
  assert.ok(prompt.includes("test.ts"));
});

test("buildMergeHealPrompt — includes slice summaries and domain context when provided", () => {
  const prompt = buildMergeHealPrompt(
    { ours: "a", theirs: "b" },
    "test.ts",
    "S01 adds a login page, S02 adds auth middleware",
    "This is a Next.js app with app router",
  );

  assert.ok(prompt.includes("login page"), "should include slice summaries");
  assert.ok(prompt.includes("Next.js app"), "should include domain context");
});

// ═══════════════════════════════════════════════════════════════════════════════
// resolveLLM — Integration tests (real git + mock LLM)
// ═══════════════════════════════════════════════════════════════════════════════

test("resolveLLM — applies high-confidence resolution from mock LLM", async () => {
  const repo = createTempRepo();

  try {
    // Create src directory and initial file
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "const x = 1;\n");
    run("git add .", repo);
    run('git commit -m "add app.ts"', repo);

    // Create milestone branch with different change
    run("git checkout -b milestone/M010", repo);
    writeFileSync(join(repo, "src", "app.ts"), "const x = 10;\nconst y = 20;\n");
    run("git add .", repo);
    run('git commit -m "M010 changes app.ts"', repo);
    run("git checkout main", repo);

    // Diverge on main
    writeFileSync(join(repo, "src", "app.ts"), "const x = 100;\nconst z = 30;\n");
    run("git add .", repo);
    run('git commit -m "main changes app.ts"', repo);

    // Merge → conflict
    try {
      run("git merge milestone/M010 --no-ff", repo);
      assert.fail("merge should have conflicted");
    } catch {
      // Expected
    }

    const conflictFiles = run(
      "git diff --name-only --diff-filter=U",
      repo,
    ).split("\n").filter(Boolean);
    assert.ok(conflictFiles.includes("src/app.ts"), "src/app.ts should be conflicted");

    // Mock LLM returns well-formed high-confidence resolution
    const mockResolveFn = async (_prompt: string): Promise<string> => {
      return [
        "I analyzed the conflict between the two branches.",
        "",
        "~~~resolved",
        "const x = 10;",
        "const y = 20;",
        "const z = 30;",
        "~~~",
        "",
        "Confidence: 0.9",
        "",
        "Merged both changes: x=10 and y from theirs, z from ours.",
      ].join("\n");
    };

    const result = await resolveLLM(repo, conflictFiles, mockResolveFn, {
      milestoneId: "M010",
    });

    // Should have resolved the file
    assert.equal(result.resolved.length, 1, "should resolve 1 file");
    assert.equal(result.escalated.length, 0, "should not escalate any files");
    assert.equal(result.resolved[0]!.filePath, "src/app.ts");
    assert.equal(result.resolved[0]!.tier, 2);
    assert.equal(result.resolved[0]!.resolution, "applied");
    assert.equal(result.resolved[0]!.confidence, 0.9);

    // Verify file content — no conflict markers
    const content = readFileSync(join(repo, "src", "app.ts"), "utf-8");
    assert.ok(!content.includes("<<<<<<<"), "should not have conflict markers");
    assert.ok(content.includes("const x = 10;"), "should have resolved content");
    assert.ok(content.includes("const z = 30;"), "should have merged content");

    // Verify file is staged
    const staged = run("git diff --cached --name-only", repo);
    assert.ok(staged.includes("src/app.ts"), "file should be staged");

    // Verify MERGE-LOG.md has tier-2 entry
    const logContent = readFileSync(join(repo, ".gsd", "MERGE-LOG.md"), "utf-8");
    assert.ok(logContent.includes("tier-2"), "should have tier-2 entry");
    assert.ok(logContent.includes("src/app.ts"), "should reference resolved file");
    assert.ok(logContent.includes("applied"), "should show applied outcome");
    assert.ok(logContent.includes("0.9"), "should include confidence");
  } finally {
    try {
      run("git merge --abort", repo);
    } catch { /* may not be in merge state */ }
    cleanup(repo);
  }
});

test("resolveLLM — escalates low-confidence resolution", async () => {
  const repo = createTempRepo();

  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "const x = 1;\n");
    run("git add .", repo);
    run('git commit -m "add app.ts"', repo);

    run("git checkout -b milestone/M010", repo);
    writeFileSync(join(repo, "src", "app.ts"), "const x = 10;\n");
    run("git add .", repo);
    run('git commit -m "M010 changes"', repo);
    run("git checkout main", repo);

    writeFileSync(join(repo, "src", "app.ts"), "const x = 100;\n");
    run("git add .", repo);
    run('git commit -m "main changes"', repo);

    try {
      run("git merge milestone/M010 --no-ff", repo);
      assert.fail("merge should have conflicted");
    } catch { /* Expected */ }

    const conflictFiles = run(
      "git diff --name-only --diff-filter=U",
      repo,
    ).split("\n").filter(Boolean);

    // Mock LLM returns low confidence
    const mockResolveFn = async (_prompt: string): Promise<string> => {
      return [
        "~~~resolved",
        "const x = 10;",
        "~~~",
        "",
        "Confidence: 0.5",
        "",
        "I'm not sure which value is correct.",
      ].join("\n");
    };

    const result = await resolveLLM(repo, conflictFiles, mockResolveFn, {
      milestoneId: "M010",
    });

    // Should escalate (0.5 < 0.8 threshold)
    assert.equal(result.resolved.length, 0, "should not resolve any files");
    assert.equal(result.escalated.length, 1, "should escalate 1 file");
    assert.equal(result.escalated[0]!.filePath, "src/app.ts");
    assert.equal(result.escalated[0]!.resolution, "escalated");
    assert.equal(result.escalated[0]!.confidence, 0.5);

    // File should still have conflict markers
    const content = readFileSync(join(repo, "src", "app.ts"), "utf-8");
    assert.ok(content.includes("<<<<<<<"), "should still have conflict markers");

    // MERGE-LOG.md should show escalation
    const logContent = readFileSync(join(repo, ".gsd", "MERGE-LOG.md"), "utf-8");
    assert.ok(logContent.includes("escalated"), "should show escalated outcome");
    assert.ok(logContent.includes("0.5"), "should include low confidence");
  } finally {
    try { run("git merge --abort", repo); } catch { /* */ }
    cleanup(repo);
  }
});

test("resolveLLM — escalates malformed LLM response (no fenced content)", async () => {
  const repo = createTempRepo();

  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "const x = 1;\n");
    run("git add .", repo);
    run('git commit -m "add app.ts"', repo);

    run("git checkout -b milestone/M010", repo);
    writeFileSync(join(repo, "src", "app.ts"), "const x = 10;\n");
    run("git add .", repo);
    run('git commit -m "M010 changes"', repo);
    run("git checkout main", repo);

    writeFileSync(join(repo, "src", "app.ts"), "const x = 100;\n");
    run("git add .", repo);
    run('git commit -m "main changes"', repo);

    try {
      run("git merge milestone/M010 --no-ff", repo);
      assert.fail("merge should have conflicted");
    } catch { /* Expected */ }

    const conflictFiles = run(
      "git diff --name-only --diff-filter=U",
      repo,
    ).split("\n").filter(Boolean);

    // Mock LLM returns garbage — no fence markers, no confidence
    const mockResolveFn = async (_prompt: string): Promise<string> => {
      return "I don't understand the conflict. Please resolve manually.";
    };

    const result = await resolveLLM(repo, conflictFiles, mockResolveFn, {
      milestoneId: "M010",
    });

    assert.equal(result.resolved.length, 0, "should not resolve any files");
    assert.equal(result.escalated.length, 1, "should escalate 1 file");
    assert.equal(result.escalated[0]!.confidence, 0.0, "confidence should be 0.0 for unparseable");

    // File should still have conflict markers
    const content = readFileSync(join(repo, "src", "app.ts"), "utf-8");
    assert.ok(content.includes("<<<<<<<"), "should still have conflict markers");

    // MERGE-LOG.md should log the escalation
    const logContent = readFileSync(join(repo, ".gsd", "MERGE-LOG.md"), "utf-8");
    assert.ok(logContent.includes("escalated"), "should show escalated outcome");
    assert.ok(logContent.includes("tier-2"), "should be tier-2 entry");
  } finally {
    try { run("git merge --abort", repo); } catch { /* */ }
    cleanup(repo);
  }
});

test("resolveLLM — catches resolveFn errors and escalates", async () => {
  const repo = createTempRepo();

  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "const x = 1;\n");
    run("git add .", repo);
    run('git commit -m "add app.ts"', repo);

    run("git checkout -b milestone/M010", repo);
    writeFileSync(join(repo, "src", "app.ts"), "const x = 10;\n");
    run("git add .", repo);
    run('git commit -m "M010 changes"', repo);
    run("git checkout main", repo);

    writeFileSync(join(repo, "src", "app.ts"), "const x = 100;\n");
    run("git add .", repo);
    run('git commit -m "main changes"', repo);

    try {
      run("git merge milestone/M010 --no-ff", repo);
      assert.fail("merge should have conflicted");
    } catch { /* Expected */ }

    const conflictFiles = run(
      "git diff --name-only --diff-filter=U",
      repo,
    ).split("\n").filter(Boolean);

    // Mock LLM that throws
    const mockResolveFn = async (_prompt: string): Promise<string> => {
      throw new Error("LLM API timeout");
    };

    const result = await resolveLLM(repo, conflictFiles, mockResolveFn, {
      milestoneId: "M010",
    });

    assert.equal(result.resolved.length, 0, "should not resolve any files");
    assert.equal(result.escalated.length, 1, "should escalate 1 file");
    assert.ok(
      result.escalated[0]!.explanation!.includes("LLM API timeout"),
      "should include error message in explanation",
    );

    // MERGE-LOG.md should log the error
    const logContent = readFileSync(join(repo, ".gsd", "MERGE-LOG.md"), "utf-8");
    assert.ok(logContent.includes("escalated"), "should show escalated outcome");
    assert.ok(logContent.includes("LLM API timeout"), "should include error in log");
  } finally {
    try { run("git merge --abort", repo); } catch { /* */ }
    cleanup(repo);
  }
});

test("resolveLLM — skips .gsd/ files (tier-1 territory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-skip-gsd-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  // Create conflicted .gsd/ file and a code file
  writeFileSync(
    join(dir, ".gsd", "STATE.md"),
    "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n",
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "app.ts"),
    "<<<<<<< HEAD\nours code\n=======\ntheirs code\n>>>>>>> branch\n",
  );

  let callCount = 0;
  const mockResolveFn = async (_prompt: string): Promise<string> => {
    callCount++;
    return "~~~resolved\nresolved\n~~~\n\nConfidence: 0.9\n\nMerged.";
  };

  // Note: nativeAddPaths will fail without a real git repo, but the point
  // is to verify .gsd/ files are skipped — so we catch errors on the code file
  try {
    await resolveLLM(dir, [".gsd/STATE.md", "src/app.ts"], mockResolveFn, {
      milestoneId: "M010",
    });
  } catch {
    // nativeAddPaths may throw without real git — that's ok
  }

  // resolveFn should only be called for src/app.ts, not .gsd/STATE.md
  assert.equal(callCount, 1, "should only call resolveFn for non-.gsd/ file");

  cleanup(dir);
});

// ═══════════════════════════════════════════════════════════════════════════════
// resolveMergeConflicts — Three-tier orchestrator tests
// ═══════════════════════════════════════════════════════════════════════════════

test("resolveMergeConflicts — orchestrates tier-1 + tier-2, resolves all conflicts", async () => {
  const repo = createTempRepo();

  try {
    // Set up milestone branch with conflicting .gsd/ and code files
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "const x = 1;\n");
    run("git add .", repo);
    run('git commit -m "add app.ts"', repo);

    run("git checkout -b milestone/M010", repo);
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State\nM010 version\n");
    writeFileSync(join(repo, "src", "app.ts"), "const x = 10;\nconst y = 20;\n");
    run("git add .", repo);
    run('git commit -m "M010 changes"', repo);
    run("git checkout main", repo);

    // Diverge on main to create conflicts in both files
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State\nmain diverged\n");
    writeFileSync(join(repo, "src", "app.ts"), "const x = 100;\nconst z = 30;\n");
    run("git add .", repo);
    run('git commit -m "main diverges"', repo);

    // Merge → conflict
    try {
      run("git merge milestone/M010 --no-ff", repo);
      assert.fail("merge should have conflicted");
    } catch { /* Expected */ }

    const conflictFiles = run(
      "git diff --name-only --diff-filter=U",
      repo,
    ).split("\n").filter(Boolean);

    // Mock LLM returns high-confidence resolution for code file
    const mockResolveFn = async (_prompt: string): Promise<string> => {
      return [
        "I merged both branches' changes.",
        "",
        "~~~resolved",
        "const x = 10;",
        "const y = 20;",
        "const z = 30;",
        "~~~",
        "",
        "Confidence: 0.9",
        "",
        "Combined both sets of changes.",
      ].join("\n");
    };

    const result = await resolveMergeConflicts(repo, "M010", conflictFiles, mockResolveFn);

    // All conflicts should be resolved
    assert.equal(result.resolved, true, "all conflicts should be resolved");
    assert.equal(result.unresolvedFiles.length, 0, "no unresolved files");

    // Should have healing attempts for both tiers
    assert.ok(result.healingAttempts.length >= 1, "should have at least 1 healing attempt");
    const tier1Attempt = result.healingAttempts.find(a => a.tier === 1);
    const tier2Attempt = result.healingAttempts.find(a => a.tier === 2);
    assert.ok(tier1Attempt, "should have tier-1 attempt");
    assert.ok(tier2Attempt, "should have tier-2 attempt");
    assert.ok(tier1Attempt!.filesResolved.length > 0, "tier-1 should resolve .gsd/ file");
    assert.ok(tier2Attempt!.filesResolved.length > 0, "tier-2 should resolve code file");

    // Verify resolutions include entries from both tiers
    const tier1Res = result.resolutions.filter(r => r.tier === 1);
    const tier2Res = result.resolutions.filter(r => r.tier === 2);
    assert.ok(tier1Res.length > 0, "should have tier-1 resolutions");
    assert.ok(tier2Res.length > 0, "should have tier-2 resolutions");

    // Verify MERGE-LOG.md has entries for both tiers
    const logContent = readFileSync(join(repo, ".gsd", "MERGE-LOG.md"), "utf-8");
    assert.ok(logContent.includes("tier-1"), "log should have tier-1 entry");
    assert.ok(logContent.includes("tier-2"), "log should have tier-2 entry");

    // Verify files no longer have conflict markers
    const stateContent = readFileSync(join(repo, ".gsd", "STATE.md"), "utf-8");
    assert.ok(!stateContent.includes("<<<<<<<"), ".gsd/STATE.md should not have conflict markers");

    const appContent = readFileSync(join(repo, "src", "app.ts"), "utf-8");
    assert.ok(!appContent.includes("<<<<<<<"), "src/app.ts should not have conflict markers");
    assert.ok(appContent.includes("const x = 10;"), "should have resolved code content");
  } finally {
    try { run("git merge --abort", repo); } catch { /* */ }
    cleanup(repo);
  }
});

test("resolveMergeConflicts — without resolveFn, only tier-1 runs, code files escalate to tier-3", async () => {
  const repo = createTempRepo();

  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "const x = 1;\n");
    run("git add .", repo);
    run('git commit -m "add app.ts"', repo);

    run("git checkout -b milestone/M010", repo);
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State\nM010 version\n");
    writeFileSync(join(repo, "src", "app.ts"), "const x = 10;\n");
    run("git add .", repo);
    run('git commit -m "M010 changes"', repo);
    run("git checkout main", repo);

    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State\nmain diverged\n");
    writeFileSync(join(repo, "src", "app.ts"), "const x = 100;\n");
    run("git add .", repo);
    run('git commit -m "main diverges"', repo);

    try {
      run("git merge milestone/M010 --no-ff", repo);
      assert.fail("merge should have conflicted");
    } catch { /* Expected */ }

    const conflictFiles = run(
      "git diff --name-only --diff-filter=U",
      repo,
    ).split("\n").filter(Boolean);

    // Call WITHOUT resolveFn — only tier-1 should run
    const result = await resolveMergeConflicts(repo, "M010", conflictFiles);

    // Should NOT be fully resolved (code conflict remains)
    assert.equal(result.resolved, false, "should not be fully resolved without LLM");
    assert.ok(result.unresolvedFiles.length > 0, "should have unresolved files");
    assert.ok(
      result.unresolvedFiles.some(f => f === "src/app.ts"),
      "src/app.ts should be unresolved",
    );

    // Tier-1 should have resolved .gsd/ file
    const tier1Attempt = result.healingAttempts.find(a => a.tier === 1);
    assert.ok(tier1Attempt, "should have tier-1 attempt");
    assert.ok(
      tier1Attempt!.filesResolved.some(f => f.includes("STATE.md")),
      "tier-1 should resolve STATE.md",
    );

    // Should NOT have tier-2 attempt (no resolveFn)
    const tier2Attempt = result.healingAttempts.find(a => a.tier === 2);
    assert.ok(!tier2Attempt, "should NOT have tier-2 attempt without resolveFn");

    // Code file should have tier-3 escalation in resolutions
    const tier3Res = result.resolutions.filter(r => r.tier === 3);
    assert.ok(tier3Res.length > 0, "should have tier-3 escalation for code files");
    assert.ok(
      tier3Res.some(r => r.filePath === "src/app.ts"),
      "src/app.ts should be escalated to tier-3",
    );
  } finally {
    try { run("git merge --abort", repo); } catch { /* */ }
    cleanup(repo);
  }
});

test("resolveMergeConflicts — full pipeline: all resolved → merge commit succeeds", async () => {
  const repo = createTempRepo();

  try {
    // Set up repo with both .gsd/ and code files
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "const x = 1;\n");
    run("git add .", repo);
    run('git commit -m "add app.ts"', repo);

    run("git checkout -b milestone/M010", repo);
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State\nM010 done\n");
    writeFileSync(join(repo, "src", "app.ts"), "const x = 10;\nconst y = 20;\n");
    run("git add .", repo);
    run('git commit -m "M010 complete"', repo);
    run("git checkout main", repo);

    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State\nmain version\n");
    writeFileSync(join(repo, "src", "app.ts"), "const x = 100;\nconst z = 30;\n");
    run("git add .", repo);
    run('git commit -m "main work"', repo);

    // Merge → conflict
    try {
      run("git merge milestone/M010 --no-ff", repo);
      assert.fail("merge should have conflicted");
    } catch { /* Expected */ }

    const conflictFiles = run(
      "git diff --name-only --diff-filter=U",
      repo,
    ).split("\n").filter(Boolean);

    // Mock LLM with high confidence
    const mockResolveFn = async (_prompt: string): Promise<string> => {
      return [
        "~~~resolved",
        "const x = 10;",
        "const y = 20;",
        "const z = 30;",
        "~~~",
        "",
        "Confidence: 0.95",
        "",
        "Merged all changes from both branches.",
      ].join("\n");
    };

    const result = await resolveMergeConflicts(repo, "M010", conflictFiles, mockResolveFn);
    assert.equal(result.resolved, true, "all conflicts should be resolved");

    // Since all conflicts are resolved, we can commit the merge
    // (simulating what mergeCompletedMilestone would do)
    const commitResult = run('git commit -m "feat(M010): merge with automated conflict resolution"', repo);
    assert.ok(commitResult, "commit should succeed");

    // Verify no conflict markers remain in any file
    const stateContent = readFileSync(join(repo, ".gsd", "STATE.md"), "utf-8");
    assert.ok(!stateContent.includes("<<<<<<<"), "STATE.md clean");

    const appContent = readFileSync(join(repo, "src", "app.ts"), "utf-8");
    assert.ok(!appContent.includes("<<<<<<<"), "app.ts clean");
    assert.ok(appContent.includes("const y = 20;"), "has resolved content");

    // Verify merge commit exists in git log
    const gitLog = run("git log --oneline -1", repo);
    assert.ok(gitLog.includes("automated conflict resolution"), "merge commit message present");

    // Verify MERGE-LOG.md has complete audit trail
    const logContent = readFileSync(join(repo, ".gsd", "MERGE-LOG.md"), "utf-8");
    assert.ok(logContent.includes("tier-1"), "log has tier-1");
    assert.ok(logContent.includes("tier-2"), "log has tier-2");
    assert.ok(logContent.includes("M010"), "log references milestone");
    assert.ok(logContent.includes("applied"), "log shows applied outcomes");

    // Verify result metadata
    assert.ok(result.healingAttempts.length >= 2, "should have attempts for both tiers");
    const allResolved = result.resolutions.filter(r => r.resolution === "applied");
    assert.ok(allResolved.length >= 2, "should have at least 2 applied resolutions");
  } finally {
    try { run("git merge --abort", repo); } catch { /* */ }
    cleanup(repo);
  }
});

test("resolveMergeConflicts — partial resolution: tier-2 escalates low confidence, unresolved files returned", async () => {
  const repo = createTempRepo();

  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "const x = 1;\n");
    run("git add .", repo);
    run('git commit -m "add app.ts"', repo);

    run("git checkout -b milestone/M010", repo);
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State\nM010\n");
    writeFileSync(join(repo, "src", "app.ts"), "const x = 10;\n");
    run("git add .", repo);
    run('git commit -m "M010"', repo);
    run("git checkout main", repo);

    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State\nmain\n");
    writeFileSync(join(repo, "src", "app.ts"), "const x = 100;\n");
    run("git add .", repo);
    run('git commit -m "main"', repo);

    try {
      run("git merge milestone/M010 --no-ff", repo);
      assert.fail("merge should have conflicted");
    } catch { /* Expected */ }

    const conflictFiles = run(
      "git diff --name-only --diff-filter=U",
      repo,
    ).split("\n").filter(Boolean);

    // Mock LLM with LOW confidence → escalation
    const mockResolveFn = async (_prompt: string): Promise<string> => {
      return [
        "~~~resolved",
        "const x = 10;",
        "~~~",
        "",
        "Confidence: 0.4",
        "",
        "Not confident about this merge.",
      ].join("\n");
    };

    const result = await resolveMergeConflicts(repo, "M010", conflictFiles, mockResolveFn);

    // Tier-1 resolves .gsd/ but tier-2 escalates code file
    assert.equal(result.resolved, false, "should NOT be fully resolved");
    assert.ok(
      result.unresolvedFiles.includes("src/app.ts"),
      "src/app.ts should be unresolved",
    );

    // Tier-2 attempt should show escalation
    const tier2Attempt = result.healingAttempts.find(a => a.tier === 2);
    assert.ok(tier2Attempt, "should have tier-2 attempt");
    assert.equal(tier2Attempt!.filesEscalated.length, 1, "tier-2 should escalate 1 file");
    assert.equal(tier2Attempt!.filesResolved.length, 0, "tier-2 should not resolve any files");
  } finally {
    try { run("git merge --abort", repo); } catch { /* */ }
    cleanup(repo);
  }
});