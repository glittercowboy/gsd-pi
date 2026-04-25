/**
 * Verify that catch blocks across GSD source files use the centralized
 * workflow-logger (logWarning/logError) instead of raw process.stderr.write,
 * console.error, or being completely empty (#3348, #3345).
 *
 * Two tests:
 * 1. Auto-mode files must have zero empty catch blocks (fully migrated).
 * 2. All GSD files must not use raw stderr/console in catch blocks.
 *
 * Implementation note (#4836): the previous implementation walked every
 * `{` / `}` character in the source to infer catch-block boundaries. That
 * ignored string literals, template interpolations, regexes, and comments,
 * producing both false positives and false negatives. The current
 * implementation uses the TypeScript compiler API to walk real
 * `CatchClause` nodes, so lexical accidents cannot flip the verdict.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

/** Files exempt from the raw-stderr/console check */
const EXEMPT_FILES = new Set([
  "workflow-logger.ts",       // The logger itself
  "debug-logger.ts",          // Separate opt-in debug system
]);

/**
 * Files that have been fully migrated to workflow-logger and must not
 * regress to empty catch blocks. Covers auto-mode, tools, bootstrap,
 * and core infrastructure files.
 */
const MIGRATED_FILES = new Set([
  // auto-mode (detected dynamically below)
  // tools/
  "tools/complete-task.ts",
  "tools/complete-slice.ts",
  "tools/complete-milestone.ts",
  "tools/plan-milestone.ts",
  "tools/plan-slice.ts",
  "tools/plan-task.ts",
  "tools/reassess-roadmap.ts",
  "tools/reopen-task.ts",
  "tools/reopen-slice.ts",
  "tools/replan-slice.ts",
  "tools/validate-milestone.ts",
  // bootstrap/
  "bootstrap/agent-end-recovery.ts",
  "bootstrap/system-context.ts",
  "bootstrap/db-tools.ts",
  "bootstrap/dynamic-tools.ts",
  "bootstrap/journal-tools.ts",
  // core infrastructure
  "gsd-db.ts",
  "workflow-logger.ts",
  "workflow-reconcile.ts",
  "workflow-migration.ts",
  "workflow-projections.ts",
  "workflow-events.ts",
  "worktree-manager.ts",
  "parallel-orchestrator.ts",
  "parallel-merge.ts",
  "guided-flow.ts",
  "preferences.ts",
  "commands-maintenance.ts",
  "commands-inspect.ts",
  "safe-fs.ts",
  "markdown-renderer.ts",
  "md-importer.ts",
  "milestone-actions.ts",
  "milestone-ids.ts",
  "rule-registry.ts",
  "custom-verification.ts",
  "prompt-loader.ts",
  "auto-verification.ts",
]);

function getAutoModeFiles(): string[] {
  const files: string[] = [];

  // Top-level auto*.ts files
  for (const f of readdirSync(gsdDir)) {
    if (f.startsWith("auto") && f.endsWith(".ts") && !f.endsWith(".test.ts")) {
      files.push(join(gsdDir, f));
    }
  }

  // auto/ subdirectory
  const autoSubDir = join(gsdDir, "auto");
  for (const f of readdirSync(autoSubDir)) {
    if (f.endsWith(".ts") && !f.endsWith(".test.ts")) {
      files.push(join(autoSubDir, f));
    }
  }

  return files;
}

function getGsdSourceFiles(): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (entry === "tests" || entry === "node_modules") continue;
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
          files.push(full);
        }
      } catch {
        continue;
      }
    }
  }

  walk(gsdDir);
  return files;
}

function parseSourceFile(filePath: string): ts.SourceFile {
  const content = readFileSync(filePath, "utf-8");
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
}

function forEachCatchClause(sf: ts.SourceFile, visit: (cc: ts.CatchClause) => void): void {
  const walk = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) visit(node);
    ts.forEachChild(node, walk);
  };
  walk(sf);
}

/**
 * A catch block is "empty" if its Block has zero statements. Comments
 * inside the block are trivia and are not Statement nodes, so a
 * comment-only body still counts as empty — matching the intent of the
 * old regex check but without its lexical blind spots.
 */
function findEmptyCatches(filePath: string): Array<{ line: number }> {
  const sf = parseSourceFile(filePath);
  const results: Array<{ line: number }> = [];
  forEachCatchClause(sf, (cc) => {
    if (cc.block.statements.length === 0) {
      const { line } = sf.getLineAndCharacterOfPosition(cc.getStart(sf));
      results.push({ line: line + 1 });
    }
  });
  return results;
}

/**
 * A catch block uses "raw stderr/console" if its body text calls
 * process.stderr.write or console.error/warn *and* does NOT also call
 * logWarning / logError.
 *
 * We test against the block's statement subtree text — derived from the
 * AST node range, not a naive substring of the whole file — so string
 * literals outside the block can never leak into the decision.
 */
function findRawStderrCatches(filePath: string): Array<{ line: number }> {
  const sf = parseSourceFile(filePath);
  const results: Array<{ line: number }> = [];
  forEachCatchClause(sf, (cc) => {
    const bodyText = cc.block.getText(sf);
    const usesLogger = /\blogWarning\s*\(|\blogError\s*\(/.test(bodyText);
    if (usesLogger) return;
    if (
      /\bprocess\.stderr\.write\b/.test(bodyText) ||
      /\bconsole\.(?:error|warn)\b/.test(bodyText)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(cc.getStart(sf));
      results.push({ line: line + 1 });
    }
  });
  return results;
}

describe("workflow-logger coverage (#3348)", () => {
  test("no empty catch blocks remain in migrated files", () => {
    // Combine auto-mode files + explicitly migrated files
    const autoFiles = getAutoModeFiles();
    const allFiles = getGsdSourceFiles();
    const migratedPaths = new Set(autoFiles);
    for (const file of allFiles) {
      const rel = relative(gsdDir, file);
      if (MIGRATED_FILES.has(rel)) {
        migratedPaths.add(file);
      }
    }

    assert.ok(migratedPaths.size > 0, "should find migrated source files");

    const violations: string[] = [];
    for (const file of migratedPaths) {
      const rel = relative(gsdDir, file);
      const basename = rel.split("/").pop()!;
      // gsd-db.ts has intentionally silent provider probes
      if (basename === "gsd-db.ts" || basename === "session-lock.ts") continue;

      const empties = findEmptyCatches(file);
      for (const empty of empties) {
        violations.push(`${rel}:${empty.line}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `Found ${violations.length} empty catch block(s) in migrated files:\n${violations.join("\n")}`,
    );
  });

  test("catch blocks use workflow-logger instead of raw stderr/console", () => {
    const files = getGsdSourceFiles();
    assert.ok(files.length > 0, "should find GSD source files");

    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(gsdDir, file);
      const basename = rel.split("/").pop()!;
      if (EXEMPT_FILES.has(basename)) continue;

      const issues = findRawStderrCatches(file);
      for (const issue of issues) {
        violations.push(`${rel}:${issue.line}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `Found ${violations.length} catch block(s) using raw stderr/console instead of workflow-logger:\n${violations.join("\n")}`,
    );
  });
});
