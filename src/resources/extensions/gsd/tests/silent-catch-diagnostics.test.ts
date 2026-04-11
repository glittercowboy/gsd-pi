/**
 * Verify that catch blocks across GSD source files use the centralized
 * workflow-logger (logWarning/logError) instead of raw process.stderr.write,
 * console.error, or being completely empty (#3348, #3345).
 *
 * Two tests:
 * 1. Auto-mode files must have zero empty catch blocks (fully migrated).
 * 2. All GSD files must not use raw stderr/console in catch blocks.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Patterns that indicate a catch block already uses workflow-logger */
const LOGGER_PATTERNS = [
  /logWarning\s*\(/,
  /logError\s*\(/,
];

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

/**
 * Scan a file for empty catch blocks — catches whose body contains
 * only whitespace and/or comments but no executable statements.
 */
function findEmptyCatches(filePath: string): Array<{ line: number; text: string }> {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const results: Array<{ line: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match catch block opening
    if (!/\}\s*catch\s*(\([^)]*\))?\s*\{/.test(line)) continue;

    // Inline single-line catch: } catch { ... }
    const inlineMatch = line.match(/\}\s*catch\s*(\([^)]*\))?\s*\{(.*)\}\s*;?\s*$/);
    if (inlineMatch) {
      const body = inlineMatch[2].trim();
      const stripped = body.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*/g, "").trim();
      if (!stripped) {
        results.push({ line: i + 1, text: line.trim() });
      }
      continue;
    }

    // Multi-line catch — scan until matching }
    let j = i + 1;
    let depth = 1;
    const bodyLines: string[] = [];
    while (j < lines.length && depth > 0) {
      for (const ch of lines[j]) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      bodyLines.push(lines[j].trim());
      j++;
    }

    const meaningful = bodyLines.slice(0, -1).filter(
      (l) => l && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*") && l !== "}",
    );

    if (meaningful.length === 0) {
      results.push({ line: i + 1, text: line.trim() });
    }
  }

  return results;
}

/**
 * Scan a file for catch blocks that use raw process.stderr.write or
 * console.error/warn instead of workflow-logger.
 */
function findRawStderrCatches(filePath: string): Array<{ line: number; text: string }> {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const results: Array<{ line: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\}\s*catch\s*(\([^)]*\))?\s*\{/.test(line)) continue;

    // Inline single-line catch
    const inlineMatch = line.match(/\}\s*catch\s*(\([^)]*\))?\s*\{(.*)\}\s*;?\s*$/);
    if (inlineMatch) {
      const body = inlineMatch[2];
      if (!LOGGER_PATTERNS.some((p) => p.test(body))) {
        if (/process\.stderr\.write/.test(body) || /console\.(error|warn)/.test(body)) {
          results.push({ line: i + 1, text: line.trim() });
        }
      }
      continue;
    }

    // Multi-line catch
    let j = i + 1;
    let depth = 1;
    const bodyLines: string[] = [];
    while (j < lines.length && depth > 0) {
      for (const ch of lines[j]) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      bodyLines.push(lines[j]);
      j++;
    }

    const bodyText = bodyLines.slice(0, -1).join("\n");
    if (!LOGGER_PATTERNS.some((p) => p.test(bodyText))) {
      if (/process\.stderr\.write/.test(bodyText) || /console\.(error|warn)/.test(bodyText)) {
        results.push({ line: i + 1, text: line.trim() });
      }
    }
  }

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
        violations.push(`${rel}:${empty.line} — ${empty.text}`);
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
        violations.push(`${rel}:${issue.line} — ${issue.text}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `Found ${violations.length} catch block(s) using raw stderr/console instead of workflow-logger:\n${violations.join("\n")}`,
    );
  });
});
