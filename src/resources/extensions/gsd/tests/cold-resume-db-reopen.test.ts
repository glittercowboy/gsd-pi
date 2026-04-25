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

console.log("\n=== resume path refreshes resources and opens DB before rebuildState/deriveState ===");

// The resume block is the `if (s.paused) { ... }` section that calls rebuildState/deriveState.
// Locate the resume section by finding `s.paused = false;` followed by `rebuildState`.
const resumeSectionStart = autoSrc.indexOf("if (s.paused) {", autoSrc.indexOf("// If resuming from paused state"));
assertTrue(resumeSectionStart > 0, "auto.ts has the paused-session resume block");

const resumeSectionEndCandidates = [
  autoSrc.indexOf("await runAutoLoopWithUok(", resumeSectionStart),
  autoSrc.indexOf("await autoLoop(", resumeSectionStart),
].filter((idx) => idx > resumeSectionStart);
const resumeSectionEnd = resumeSectionEndCandidates.length > 0 ? Math.min(...resumeSectionEndCandidates) : -1;
assertTrue(resumeSectionEnd > resumeSectionStart, "resume block reaches the dispatch loop");

const resumeSection = autoSrc.slice(resumeSectionStart, resumeSectionEnd);

// The resume path must refresh managed resources and open the DB before
// rebuildState/deriveState so resumed auto-mode uses current extension code.
const rebuildIdx = resumeSection.indexOf("rebuildState(");
assertTrue(rebuildIdx > 0, "resume block calls rebuildState");

const deriveIdx = resumeSection.indexOf("deriveState(");
assertTrue(deriveIdx > 0, "resume block calls deriveState");

const preDeriveSection = resumeSection.slice(0, rebuildIdx);

assertTrue(
  preDeriveSection.includes("initResources("),
  "resume path must refresh managed resources before rebuildState/deriveState (#3761)",
);

// There must be a DB open call before the first rebuildState call
const dbOpenPatterns = [
  "openProjectDbIfPresent(",
  "openDatabase(",
  "ensureDbOpen(",
];

const hasDbOpen = dbOpenPatterns.some(pat => preDeriveSection.includes(pat));
assertTrue(
  hasDbOpen,
  "resume path must open DB before rebuildState/deriveState (#2940)",
);

report();
