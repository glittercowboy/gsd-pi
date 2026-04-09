/**
 * cold-resume-db-reopen.test.ts — Regression test for #2940.
 *
 * Validates that the paused-session resume path in auto.ts opens the project
 * database before calling rebuildState() / deriveState(), matching the fresh
 * bootstrap path in auto-start.ts.
 *
 * Without this, cold resume falls back to markdown parsing which misreads
 * done cells and redispatches wrong slices.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createTestContext } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const autoSrc = readFileSync(join(import.meta.dirname, "..", "auto.ts"), "utf-8");

console.log("\n=== #2940: resume path opens DB before rebuildState/deriveState ===");

// The resume block is the `if (s.paused) { ... }` section that calls rebuildState/deriveState.
// Locate the resume section by finding `s.paused = false;` followed by `rebuildState`.
const resumeSectionStart = autoSrc.indexOf("if (s.paused) {", autoSrc.indexOf("// If resuming from paused state"));
assertTrue(resumeSectionStart > 0, "auto.ts has the paused-session resume block");

const resumeSection = autoSrc.slice(resumeSectionStart, resumeSectionStart + 3000);

// The resume path must open the DB before rebuildState/deriveState
const rebuildIdx = resumeSection.indexOf("rebuildState(");
assertTrue(rebuildIdx > 0, "resume block calls rebuildState");

const deriveIdx = resumeSection.indexOf("deriveState(");
assertTrue(deriveIdx > 0, "resume block calls deriveState");

// There must be a DB open call before the first rebuildState call
const dbOpenPatterns = [
  "openProjectDbIfPresent(",
  "openDatabase(",
  "ensureDbOpen(",
];

const preDeriveSection = resumeSection.slice(0, rebuildIdx);
const hasDbOpen = dbOpenPatterns.some(pat => preDeriveSection.includes(pat));
assertTrue(
  hasDbOpen,
  "resume path must open DB before rebuildState/deriveState (#2940)",
);

report();
