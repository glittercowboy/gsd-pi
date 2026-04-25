/**
 * Cross-platform filesystem safety — static analysis guard.
 *
 * Scans ALL production .ts files and flags patterns that break on
 * Windows, Linux, or macOS. Modelled after the git-locale static
 * check in src/resources/extensions/gsd/tests/git-locale.test.ts.
 *
 * Patterns 1, 3, 4 → hard fail (clear bugs).
 * Patterns 2, 5, 6 → warn only (logged, no assertion failure).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// ─── File collection ────────────────────────────────────────────────────────

const SRC_ROOT = join(import.meta.dirname, "..");

interface SourceFile {
  /** Absolute path */
  abs: string;
  /** Path relative to src/ for display */
  rel: string;
  content: string;
  lines: string[];
}

function collectProductionFiles(dir: string): SourceFile[] {
  const results: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "tests"].includes(entry.name)) continue;
      results.push(...collectProductionFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) continue;
    const content = readFileSync(full, "utf-8");
    results.push({
      abs: full,
      rel: relative(SRC_ROOT, full).replaceAll("\\", "/"),
      content,
      lines: content.split("\n"),
    });
  }
  return results;
}

// ─── Violation helpers ──────────────────────────────────────────────────────

interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  ${v.file}:${v.line}  ${v.reason}\n    > ${v.text.trim()}`)
    .join("\n\n");
}

// ─── Allowlists ─────────────────────────────────────────────────────────────
// Each entry: [relative path from src/, line substring that makes it safe].
// Every entry must have a comment explaining why it is safe.

/** Pattern 1 — hardcoded /tmp */
const ALLOW_HARDCODED_TMP: Array<[string, string]> = [
  // cmux DEFAULT_SOCKET_PATH is a Unix-domain socket convention; cmux is
  // macOS/Linux only and the path is overridden by $CMUX_SOCKET at runtime.
  ["resources/extensions/cmux/index.ts", 'DEFAULT_SOCKET_PATH = "/tmp/cmux.sock"'],
];

/** Pattern 4 — shell commands with interpolated variables */
const ALLOW_SHELL_INTERPOLATION: Array<[string, string]> = [
  // update-cmd.ts, update-check.ts, and commands-handlers.ts all pass a
  // pre-built variable (installCmd) to execSync — no template literal inside
  // the execSync call, so no entries are needed here.
];

function isAllowlisted(
  allowlist: Array<[string, string]>,
  rel: string,
  lineText: string,
): boolean {
  return allowlist.some(
    ([path, substr]) => rel === path && lineText.includes(substr),
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Cross-platform filesystem safety (static analysis)", () => {
  const files = collectProductionFiles(SRC_ROOT);

  test("scanned a reasonable number of production files", () => {
    // Sanity check: we should find hundreds of .ts files.
    assert.ok(
      files.length > 50,
      `Expected >50 production .ts files, found ${files.length}`,
    );
  });

  // ── Pattern 1: Hardcoded /tmp ───────────────────────────────────────────
  test("no hardcoded /tmp paths (use os.tmpdir())", () => {
    const violations: Violation[] = [];
    const tmpPattern = /["'`]\/tmp\//;

    for (const f of files) {
      for (let i = 0; i < f.lines.length; i++) {
        const line = f.lines[i];
        // Skip comments
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        if (!tmpPattern.test(line)) continue;
        if (isAllowlisted(ALLOW_HARDCODED_TMP, f.rel, line)) continue;
        violations.push({
          file: f.rel,
          line: i + 1,
          text: line,
          reason: 'Hardcoded "/tmp/" — use os.tmpdir() or tmpdir() for cross-platform safety',
        });
      }
    }

    assert.equal(
      violations.length,
      0,
      `Found ${violations.length} hardcoded /tmp path(s):\n\n${formatViolations(violations)}`,
    );
  });

  // ── Pattern 2: Hardcoded path separators (WARN) ─────────────────────────
  test("warn on string concatenation with hardcoded path separators", () => {
    const violations: Violation[] = [];
    // Match: someVar + "/" + otherVar  or  someVar + '/' + otherVar
    const concatPattern = /\+\s*["']\/["']\s*\+/;

    for (const f of files) {
      for (let i = 0; i < f.lines.length; i++) {
        const line = f.lines[i];
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        if (!concatPattern.test(line)) continue;
        violations.push({
          file: f.rel,
          line: i + 1,
          text: line,
          reason: "String concatenation with \"/\" — consider path.join()",
        });
      }
    }

    if (violations.length > 0) {
      console.log(
        `[WARN] ${violations.length} hardcoded path separator(s) found (non-blocking):\n\n${formatViolations(violations)}`,
      );
    }
    // Warn only — do not fail
  });

  // ── Pattern 3: rmSync/rmdir without force: true ─────────────────────────
  test("rmSync calls include force: true (Windows read-only files)", () => {
    const violations: Violation[] = [];
    const rmSyncCall = /\brmSync\s*\(/;

    for (const f of files) {
      for (let i = 0; i < f.lines.length; i++) {
        const line = f.lines[i];
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        if (!rmSyncCall.test(line)) continue;

        // Gather a window of lines to check for force: true
        const window = f.lines.slice(i, Math.min(i + 6, f.lines.length)).join(" ");
        if (/force\s*:\s*true/.test(window)) continue;

        violations.push({
          file: f.rel,
          line: i + 1,
          text: line,
          reason: "rmSync() without force: true — fails on Windows read-only files (.git)",
        });
      }
    }

    assert.equal(
      violations.length,
      0,
      `Found ${violations.length} rmSync call(s) missing force: true:\n\n${formatViolations(violations)}`,
    );
  });

  // ── Pattern 4: Shell commands with unescaped path interpolation ─────────
  test("no unescaped path interpolation in shell commands", () => {
    const violations: Violation[] = [];
    // Match execSync(` ... ${ — template literal with interpolation
    const shellInterp = /\b(execSync|spawnSync)\s*\(\s*`[^`]*\$\{/;

    for (const f of files) {
      for (let i = 0; i < f.lines.length; i++) {
        const line = f.lines[i];
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        if (!shellInterp.test(line)) continue;
        if (isAllowlisted(ALLOW_SHELL_INTERPOLATION, f.rel, line)) continue;
        violations.push({
          file: f.rel,
          line: i + 1,
          text: line,
          reason: "Template literal interpolation inside execSync/spawnSync — paths may contain spaces or special chars",
        });
      }
    }

    assert.equal(
      violations.length,
      0,
      `Found ${violations.length} unescaped shell interpolation(s):\n\n${formatViolations(violations)}`,
    );
  });

  // ── Pattern 5: TOCTOU existsSync + unlinkSync/rmSync (WARN) ────────────
  test("warn on existsSync + delete TOCTOU patterns", () => {
    const violations: Violation[] = [];

    for (const f of files) {
      for (let i = 0; i < f.lines.length; i++) {
        const line = f.lines[i];
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        if (!/existsSync\s*\(/.test(line)) continue;

        // Look ahead up to 5 lines for a matching unlinkSync or rmSync
        const ahead = f.lines.slice(i + 1, Math.min(i + 6, f.lines.length));
        const hasDelete = ahead.some(
          (l) => /\b(unlinkSync|rmSync)\s*\(/.test(l),
        );
        if (!hasDelete) continue;

        violations.push({
          file: f.rel,
          line: i + 1,
          text: line,
          reason: "TOCTOU: existsSync() followed by delete — file may vanish between check and action",
        });
      }
    }

    if (violations.length > 0) {
      console.log(
        `[WARN] ${violations.length} potential TOCTOU pattern(s) found (non-blocking):\n\n${formatViolations(violations)}`,
      );
    }
    // Warn only — do not fail
  });

  // ── Pattern 6: recursive rmSync without containment check (WARN) ───────
  test("warn on recursive rmSync without nearby containment validation", () => {
    const violations: Violation[] = [];
    // Only flag lines that actually contain an rmSync call with recursive: true
    const rmSyncLine = /\brmSync\s*\(/;
    const recursiveInWindow = /recursive\s*:\s*true/;

    for (const f of files) {
      for (let i = 0; i < f.lines.length; i++) {
        const line = f.lines[i];
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        if (!rmSyncLine.test(line)) continue;

        // Check that recursive: true appears in the same statement (within 5 lines)
        const stmtWindow = f.lines.slice(i, Math.min(i + 6, f.lines.length)).join(" ");
        if (!recursiveInWindow.test(stmtWindow)) continue;

        // Look within 20 lines before and after for a containment check
        const contextStart = Math.max(0, i - 20);
        const contextEnd = Math.min(f.lines.length, i + 20);
        const context = f.lines.slice(contextStart, contextEnd).join("\n");

        // Common containment patterns: isInside, startsWith, includes("worktree"),
        // path comparison, or the word "containment" / "safety" in a comment
        const hasContainment =
          /isInside|startsWith\s*\(|\.includes\s*\(|normalize\s*\(|resolve\s*\(.*===|containment|safety check/i.test(
            context,
          );

        if (hasContainment) continue;

        violations.push({
          file: f.rel,
          line: i + 1,
          text: line,
          reason: "recursive rmSync without nearby containment validation (see isInsideWorktreesDir pattern)",
        });
      }
    }

    if (violations.length > 0) {
      console.log(
        `[WARN] ${violations.length} recursive rmSync without containment check (non-blocking):\n\n${formatViolations(violations)}`,
      );
    }
    // Warn only — do not fail
  });
});
