/**
 * Template structure tests.
 *
 * Encodes the canonical GSD template set and asserts required headings
 * for each template type. These tests prevent:
 * - Accidental deletion or introduction of templates
 * - Missing headings that parsers (files.ts) or prompt builders depend on
 * - Violation of the explicit-none convention for optional sections
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestContext } from "./test-helpers.ts";

const { assertTrue, assertEq, report } = createTestContext();

const __dir = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dir, "..", "templates");

/** Load a template by basename (without .md extension). */
function loadTemplate(name: string): string {
  return readFileSync(join(templatesDir, `${name}.md`), "utf-8");
}

/** Extract all headings at a given level from template content. */
function extractHeadings(content: string, level: number): string[] {
  const prefix = "#".repeat(level) + " ";
  const regex = new RegExp(`^${prefix}(.+)$`, "gm");
  return [...content.matchAll(regex)].map((m) => m[1].trim());
}

/** Check whether a section body (text after heading, before next heading) contains non-comment content. */
function sectionHasContent(content: string, heading: string, level: number = 2): boolean {
  const prefix = "#".repeat(level) + " ";
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${prefix}${escaped}\\s*$`, "m");
  const match = regex.exec(content);
  if (!match) return false;
  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.match(new RegExp(`^#{1,${level}} `, "m"));
  const end = nextHeading ? nextHeading.index! : rest.length;
  const body = rest
    .slice(0, end)
    .replace(/<!--[\s\S]*?-->/g, "") // strip comments
    .trim();
  return body.length > 0;
}

// ── Canonical Template Set ─────────────────────────────────────────────

const EXPECTED_TEMPLATES = [
  "context",
  "decisions",
  "knowledge",
  "milestone-summary",
  "plan",
  "preferences",
  "project",
  "requirements",
  "research",
  "roadmap",
  "secrets-manifest",
  "slice-context",
  "slice-summary",
  "state",
  "task-plan",
  "task-summary",
  "uat",
].sort();

// ── Template set integrity ─────────────────────────────────────────────

console.log("\n=== Template set integrity ===");
{
  const onDisk = readdirSync(templatesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  assertEq(onDisk, EXPECTED_TEMPLATES, "on-disk templates match canonical set exactly");
}

console.log("\n=== loadTemplate succeeds for every expected template ===");
for (const name of EXPECTED_TEMPLATES) {
  const content = loadTemplate(name);
  assertTrue(content.length > 0, `loadTemplate("${name}") returns non-empty content`);
}

console.log("\n=== loadTemplate throws for deleted/unknown templates ===");
for (const name of ["milestone-validation", "reassessment", "nonexistent-xyz"]) {
  let threw = false;
  try {
    loadTemplate(name);
  } catch {
    threw = true;
  }
  assertTrue(threw, `loadTemplate("${name}") throws`);
}

// ── plan.md structure ──────────────────────────────────────────────────

console.log("\n=== plan.md structure ===");
{
  const content = loadTemplate("plan");
  const h2 = extractHeadings(content, 2);
  assertTrue(h2.includes("Must-Haves"), 'plan has "Must-Haves" heading');
  assertTrue(h2.includes("Tasks"), 'plan has "Tasks" heading');
  assertTrue(h2.includes("Files Likely Touched"), 'plan has "Files Likely Touched" heading');
  assertTrue(h2.includes("Verification"), 'plan has "Verification" heading');
  assertTrue(h2.includes("Why This Slice"), 'plan has "Why This Slice" heading');
  assertTrue(h2.includes("Integration Points"), 'plan has "Integration Points" heading');
  assertTrue(h2.includes("Research Findings"), 'plan has "Research Findings" heading');
  assertTrue(/^\*\*Goal:\*\*/m.test(content), "plan has Goal bold field");
  assertTrue(/^\*\*Demo:\*\*/m.test(content), "plan has Demo bold field");

  // h3 sub-headings under Integration Points
  const h3 = extractHeadings(content, 3);
  assertTrue(h3.includes("Consumes"), 'plan has "Consumes" h3 sub-heading');
  assertTrue(h3.includes("Produces"), 'plan has "Produces" h3 sub-heading');
}

// ── task-plan.md structure ─────────────────────────────────────────────

console.log("\n=== task-plan.md structure ===");
{
  const content = loadTemplate("task-plan");
  const h2 = extractHeadings(content, 2);
  for (const heading of ["Description", "Steps", "Must-Haves", "Verification", "Inputs", "Expected Output", "Observability Impact"]) {
    assertTrue(h2.includes(heading), `task-plan has "${heading}" heading`);
  }
}

// ── task-summary.md structure ──────────────────────────────────────────

console.log("\n=== task-summary.md structure ===");
{
  const content = loadTemplate("task-summary");
  const h2 = extractHeadings(content, 2);
  for (const heading of ["What Happened", "Deviations", "Files Created/Modified", "Verification Evidence", "Diagnostics", "Known Issues"]) {
    assertTrue(h2.includes(heading), `task-summary has "${heading}" heading`);
  }

  // Frontmatter fields
  for (const field of ["id:", "parent:", "milestone:", "verification_result:", "blocker_discovered:"]) {
    assertTrue(content.includes(field), `task-summary frontmatter includes ${field}`);
  }

  // Explicit-none markers for optional sections
  assertTrue(sectionHasContent(content, "Deviations"), 'task-summary "Deviations" has explicit-none content');
  assertTrue(sectionHasContent(content, "Known Issues"), 'task-summary "Known Issues" has explicit-none content');
}

// ── slice-summary.md structure ─────────────────────────────────────────

console.log("\n=== slice-summary.md structure ===");
{
  const content = loadTemplate("slice-summary");
  const h2 = extractHeadings(content, 2);
  for (const heading of [
    "What Happened", "Verification", "Deviations", "Known Limitations",
    "Follow-ups", "Files Created/Modified", "Forward Intelligence",
    "Requirements Advanced", "Requirements Validated",
    "New Requirements Surfaced", "Requirements Invalidated or Re-scoped",
  ]) {
    assertTrue(h2.includes(heading), `slice-summary has "${heading}" heading`);
  }

  // Frontmatter fields
  for (const field of ["id:", "parent:", "milestone:", "verification_result:"]) {
    assertTrue(content.includes(field), `slice-summary frontmatter includes ${field}`);
  }

  // Explicit-none markers
  for (const heading of ["Deviations", "Known Limitations", "Follow-ups", "New Requirements Surfaced", "Requirements Invalidated or Re-scoped"]) {
    assertTrue(sectionHasContent(content, heading), `slice-summary "${heading}" has explicit-none content`);
  }
}

// ── milestone-summary.md structure ─────────────────────────────────────

console.log("\n=== milestone-summary.md structure ===");
{
  const content = loadTemplate("milestone-summary");
  const h2 = extractHeadings(content, 2);
  for (const heading of ["What Happened", "Cross-Slice Verification", "Requirement Changes", "Forward Intelligence", "Files Created/Modified"]) {
    assertTrue(h2.includes(heading), `milestone-summary has "${heading}" heading`);
  }

  assertTrue(sectionHasContent(content, "Requirement Changes"), 'milestone-summary "Requirement Changes" has explicit-none content');
  assertTrue(content.includes("id:"), "milestone-summary frontmatter includes id:");
  assertTrue(content.includes("verification_result:"), "milestone-summary frontmatter includes verification_result:");
}

// ── state.md structure ─────────────────────────────────────────────────

console.log("\n=== state.md structure ===");
{
  const content = loadTemplate("state");
  for (const field of ["Active Milestone:", "Active Slice:", "Active Task:", "Phase:", "Next Action:", "Last Updated:"]) {
    assertTrue(content.includes(`**${field}**`), `state has "${field}" bold field`);
  }

  const h2 = extractHeadings(content, 2);
  assertTrue(h2.includes("Recent Decisions"), 'state has "Recent Decisions" heading');
  assertTrue(h2.includes("Blockers"), 'state has "Blockers" heading');
  assertTrue(sectionHasContent(content, "Blockers"), 'state "Blockers" has explicit-none content');
}

// ── uat.md structure ───────────────────────────────────────────────────

console.log("\n=== uat.md structure ===");
{
  const content = loadTemplate("uat");
  const h2 = extractHeadings(content, 2);
  for (const heading of [
    "UAT Type", "Preconditions", "Smoke Test", "Test Cases",
    "Edge Cases", "Failure Signals", "Requirements Proved By This UAT",
    "Not Proven By This UAT", "Notes for Tester",
  ]) {
    assertTrue(h2.includes(heading), `uat has "${heading}" heading`);
  }

  assertTrue(sectionHasContent(content, "Requirements Proved By This UAT"), 'uat "Requirements Proved By This UAT" has explicit-none content');
  assertTrue(sectionHasContent(content, "Not Proven By This UAT"), 'uat "Not Proven By This UAT" has explicit-none content');
}

// ── research.md structure ──────────────────────────────────────────────

console.log("\n=== research.md structure ===");
{
  const content = loadTemplate("research");
  const h2 = extractHeadings(content, 2);
  for (const heading of ["Summary", "Recommendation", "Implementation Landscape"]) {
    assertTrue(h2.includes(heading), `research has "${heading}" heading`);
  }

  const h3 = extractHeadings(content, 3);
  for (const heading of ["Key Files", "Build Order", "Verification Approach"]) {
    assertTrue(h3.includes(heading), `research has "${heading}" h3 sub-heading`);
  }
}

// ── roadmap.md structure ───────────────────────────────────────────────

console.log("\n=== roadmap.md structure ===");
{
  const content = loadTemplate("roadmap");
  const h2 = extractHeadings(content, 2);
  for (const heading of ["Success Criteria", "Slices", "Boundary Map"]) {
    assertTrue(h2.includes(heading), `roadmap has "${heading}" heading`);
  }
  assertTrue(/^\*\*Vision:\*\*/m.test(content), "roadmap has Vision bold field");
  assertTrue(sectionHasContent(content, "Key Risks / Unknowns"), 'roadmap "Key Risks / Unknowns" has explicit-none content');
  assertTrue(sectionHasContent(content, "Proof Strategy"), 'roadmap "Proof Strategy" has explicit-none content');
}

// ── requirements.md structure ──────────────────────────────────────────

console.log("\n=== requirements.md structure ===");
{
  const content = loadTemplate("requirements");
  const h2 = extractHeadings(content, 2);
  for (const heading of ["Active", "Validated", "Deferred", "Out of Scope", "Traceability"]) {
    assertTrue(h2.includes(heading), `requirements has "${heading}" heading`);
  }
}

// ── context.md structure ───────────────────────────────────────────────

console.log("\n=== context.md structure ===");
{
  const content = loadTemplate("context");
  const h2 = extractHeadings(content, 2);
  for (const heading of [
    "Project Description", "Why This Milestone", "User-Visible Outcome",
    "Completion Class", "Final Integrated Acceptance", "Risks and Unknowns",
    "Scope", "Open Questions",
  ]) {
    assertTrue(h2.includes(heading), `context has "${heading}" heading`);
  }

  assertTrue(sectionHasContent(content, "Risks and Unknowns"), 'context "Risks and Unknowns" has explicit-none content');
  assertTrue(sectionHasContent(content, "Open Questions"), 'context "Open Questions" has explicit-none content');
}

// ── slice-context.md structure ─────────────────────────────────────────

console.log("\n=== slice-context.md structure ===");
{
  const content = loadTemplate("slice-context");
  const h2 = extractHeadings(content, 2);
  for (const heading of ["Goal", "Why this Slice", "Scope", "Constraints", "Integration Points", "Open Questions"]) {
    assertTrue(h2.includes(heading), `slice-context has "${heading}" heading`);
  }

  assertTrue(sectionHasContent(content, "Constraints"), 'slice-context "Constraints" has explicit-none content');
  assertTrue(sectionHasContent(content, "Open Questions"), 'slice-context "Open Questions" has explicit-none content');
}

// ── secrets-manifest.md structure ──────────────────────────────────────

console.log("\n=== secrets-manifest.md structure ===");
{
  const content = loadTemplate("secrets-manifest");
  assertTrue(/^\*\*Milestone:\*\*/m.test(content), "secrets-manifest has Milestone bold field");
  assertTrue(/^\*\*Generated:\*\*/m.test(content), "secrets-manifest has Generated bold field");
  const h3 = extractHeadings(content, 3);
  assertTrue(h3.length > 0, "secrets-manifest has at least one H3 entry section");
}

// ── decisions.md structure ─────────────────────────────────────────────

console.log("\n=== decisions.md structure ===");
{
  const content = loadTemplate("decisions");
  assertTrue(
    content.includes("| # | When | Scope | Decision | Choice | Rationale | Revisable? |"),
    "decisions has table header"
  );
}

// ── knowledge.md structure ─────────────────────────────────────────────

console.log("\n=== knowledge.md structure ===");
{
  const content = loadTemplate("knowledge");
  const h2 = extractHeadings(content, 2);
  for (const heading of ["Rules", "Patterns", "Lessons Learned"]) {
    assertTrue(h2.includes(heading), `knowledge has "${heading}" heading`);
  }
}

// ── project.md structure ───────────────────────────────────────────────

console.log("\n=== project.md structure ===");
{
  const content = loadTemplate("project");
  const h2 = extractHeadings(content, 2);
  for (const heading of ["What This Is", "Core Value", "Current State", "Architecture / Key Patterns", "Milestone Sequence"]) {
    assertTrue(h2.includes(heading), `project has "${heading}" heading`);
  }
}

// ── Report ─────────────────────────────────────────────────────────────

report();
