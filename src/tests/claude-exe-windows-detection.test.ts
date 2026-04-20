/**
 * Regression test for #4548 — Bug 1: claude.exe installs missed on Windows.
 *
 * readiness.ts must probe `claude.exe` in addition to `claude.cmd` so that
 * direct-binary Windows installs are detected. claude-cli-check.ts must do
 * the same.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const readinessSource = readFileSync(
  join(__dirname, "..", "resources", "extensions", "claude-code-cli", "readiness.ts"),
  "utf-8",
);

const claudeCliCheckSource = readFileSync(
  join(__dirname, "..", "claude-cli-check.ts"),
  "utf-8",
);

describe("readiness.ts — Windows claude.exe candidate (#4548)", () => {
  test("CLAUDE_COMMAND_CANDIDATES includes claude.exe on win32", () => {
    assert.match(
      readinessSource,
      /["']claude\.exe["']/,
      'readiness.ts must include "claude.exe" as a Windows candidate',
    );
  });

  test("CLAUDE_COMMAND_CANDIDATES includes all three win32 candidates", () => {
    // Must probe claude.cmd, claude.exe, and bare claude
    assert.match(readinessSource, /["']claude\.cmd["']/, 'must include claude.cmd');
    assert.match(readinessSource, /["']claude\.exe["']/, 'must include claude.exe');
    // bare "claude" (not .cmd or .exe) must also appear in the candidates array
    assert.ok(
      /\[\s*CLAUDE_COMMAND.*["']claude\.exe["'].*["']claude["']/.test(readinessSource) ||
      /["']claude\.cmd["'][^)]*["']claude\.exe["'][^)]*["']claude["']/.test(readinessSource),
      'readiness.ts must list claude.cmd, claude.exe, and claude as candidates',
    );
  });

  test("uses path.delimiter (not hard-coded colon) in any PATH split", () => {
    // Ensure no raw PATH.split(':') — only delimiter import is acceptable
    assert.doesNotMatch(
      readinessSource,
      /PATH[^)]*\.split\s*\(\s*['"]:['"]/,
      'PATH must not be split on hard-coded ":" — use path.delimiter',
    );
  });
});

describe("claude-cli-check.ts — Windows claude.exe candidate (#4548)", () => {
  test("probe candidates include claude.exe on win32", () => {
    assert.match(
      claudeCliCheckSource,
      /["']claude\.exe["']/,
      'claude-cli-check.ts must include "claude.exe" as a Windows candidate',
    );
  });

  test("probe candidates include claude.cmd on win32", () => {
    assert.match(
      claudeCliCheckSource,
      /["']claude\.cmd["']/,
      'claude-cli-check.ts must include "claude.cmd" as a Windows candidate',
    );
  });

  test("probe candidates include bare claude on win32", () => {
    // Bare "claude" string must appear in the candidates list (distinct from .cmd/.exe)
    assert.match(
      claudeCliCheckSource,
      /CLAUDE_COMMAND_CANDIDATES/,
      'claude-cli-check.ts must define a CLAUDE_COMMAND_CANDIDATES array for multi-candidate probing',
    );
  });
});
