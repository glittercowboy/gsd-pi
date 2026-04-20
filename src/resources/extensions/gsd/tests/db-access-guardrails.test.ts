// GSD2 — Regression tests: DB anti-pattern guardrails in prompt templates

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const promptsDir = join(process.cwd(), "src/resources/extensions/gsd/prompts");

function readPrompt(name: string): string {
  return readFileSync(join(promptsDir, `${name}.md`), "utf-8");
}

// ─── Layer 1: system.md global guardrail ──────────────────────────────────────

test("system.md anti-patterns section prohibits direct .gsd/gsd.db access", () => {
  const prompt = readPrompt("system");
  assert.match(
    prompt,
    /Never query.*\.gsd\/gsd\.db.*directly/i,
    "system.md must prohibit direct .gsd/gsd.db access in the anti-patterns section",
  );
  assert.match(prompt, /sqlite3/, "system.md DB guardrail must name the sqlite3 CLI");
  assert.match(prompt, /better-sqlite3/, "system.md DB guardrail must name better-sqlite3");
  assert.match(prompt, /gsd_\*/, "system.md DB guardrail must redirect to gsd_* tools");
});

test("system.md DB guardrail explains single-writer WAL risk", () => {
  const prompt = readPrompt("system");
  assert.match(prompt, /single-writer WAL/i, "system.md must explain the WAL architecture risk");
});

// ─── Layer 2: high-risk prompt guardrails ─────────────────────────────────────

test("validate-milestone.md contains DB access safety guardrail with tool redirect", () => {
  const prompt = readPrompt("validate-milestone");
  assert.match(prompt, /DB access safety/i, "validate-milestone.md must have DB access safety section");
  assert.match(prompt, /gsd_milestone_status/, "validate-milestone.md must name gsd_milestone_status as alternative");
  assert.match(prompt, /Do NOT query.*\.gsd\/gsd\.db/i, "validate-milestone.md must prohibit direct DB queries");
});

test("complete-milestone.md contains DB access safety guardrail with tool redirect", () => {
  const prompt = readPrompt("complete-milestone");
  assert.match(prompt, /DB access safety/i, "complete-milestone.md must have DB access safety section");
  assert.match(prompt, /gsd_milestone_status/, "complete-milestone.md must name gsd_milestone_status as alternative");
  assert.match(prompt, /Do NOT query.*\.gsd\/gsd\.db/i, "complete-milestone.md must prohibit direct DB queries");
});

test("doctor-heal.md contains DB access guardrail naming gsd_milestone_status", () => {
  const prompt = readPrompt("doctor-heal");
  assert.match(prompt, /gsd_milestone_status/, "doctor-heal.md must name gsd_milestone_status as the DB inspection tool");
  assert.match(prompt, /Do NOT query.*\.gsd\/gsd\.db/i, "doctor-heal.md must prohibit direct DB queries");
});

test("forensics.md contains DB inspection guardrail", () => {
  const prompt = readPrompt("forensics");
  assert.match(prompt, /gsd_milestone_status/, "forensics.md must name gsd_milestone_status as the DB inspection tool");
  assert.match(prompt, /sqlite3.*\.gsd\/gsd\.db/i, "forensics.md must prohibit sqlite3 against .gsd/gsd.db");
});

test("reassess-roadmap.md contains DB access safety guardrail", () => {
  const prompt = readPrompt("reassess-roadmap");
  assert.match(prompt, /DB access safety/i, "reassess-roadmap.md must have DB access safety section");
  assert.match(prompt, /gsd_milestone_status/, "reassess-roadmap.md must name gsd_milestone_status as alternative");
});

// ─── Negative assertion: no prompt instructs running sqlite3 as a command ─────

test("no prompt file contains an unguarded sqlite3 command invocation", () => {
  const files = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 35, `Expected at least 35 prompt files, found ${files.length}`);

  const violations: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(promptsDir, file), "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Match lines containing sqlite3 targeting gsd.db in any common form:
      //   sqlite3 .gsd/gsd.db, sqlite3 ./.gsd/gsd.db, sqlite3 "/path/.gsd/gsd.db",
      //   sqlite3 -header .gsd/gsd.db, etc.
      // Guardrail text that says "Never run" or "Do NOT query" is fine — only flag
      // lines where these appear without a surrounding prohibition keyword.
      if (/sqlite3\b.*gsd\.db/.test(trimmed)) {
        const context = lines.slice(Math.max(0, i - 3), i + 1).join(" ");
        if (!/Never|Do NOT|do not|don't|prohibited|forbidden|never run/i.test(context)) {
          violations.push(`${file}:${i + 1} — unguarded sqlite3 command: ${trimmed}`);
        }
      }
      // Match node -e with better-sqlite3 require in any quoting style
      if (/node\s+-e\s+.*(?:require|import).*better-sqlite3/.test(trimmed)) {
        const context = lines.slice(Math.max(0, i - 3), i + 1).join(" ");
        if (!/Never|Do NOT|do not|don't|prohibited|forbidden|never run/i.test(context)) {
          violations.push(`${file}:${i + 1} — unguarded node -e require command: ${trimmed}`);
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Found prompts with unguarded sqlite3/better-sqlite3 invocations:\n${violations.join("\n")}`,
  );
});
