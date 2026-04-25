// GSD-2 — #4780: slice-summary excerpts replace full inlining in
// buildCompleteMilestonePrompt. Verify (a) the excerpt helper emits
// frontmatter fields + section heads + on-demand path, (b) the closer
// prompt lists all slice SUMMARY paths under "On-demand Slice Summaries",
// (c) regression on prompt size.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSliceSummaryExcerpt, buildCompleteMilestonePrompt } from "../auto-prompts.ts";
import { invalidateAllCaches } from "../cache.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────

function createBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-cm-excerpt-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function writeRoadmap(base: string, content: string): void {
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), content);
}

function writeSummary(base: string, sid: string, content: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", sid, `${sid}-SUMMARY.md`),
    content,
  );
}

// A summary with enough body narrative that full inlining would balloon the
// prompt. The excerpt should keep frontmatter + sections but drop the
// "What Happened" narrative.
function makeFatSummary(sid: string): string {
  const narrativePara =
    "The team discovered several subtle integration issues, traced them to the cache layer, and produced a patch set that threads the cache key through every call site. ".repeat(20);
  return [
    "---",
    `id: ${sid}`,
    "parent: M001",
    "milestone: M001",
    "provides:",
    "  - compact slice-summary excerpts",
    "  - on-demand read path registry",
    "affects:",
    "  - complete-milestone prompt builder",
    "key_decisions:",
    "  - use parseSummary for frontmatter extraction",
    "  - fall back to full inline when frontmatter fails",
    "patterns_established:",
    "  - excerpt-first inlining for closer units",
    "key_files:",
    "  - src/resources/extensions/gsd/auto-prompts.ts",
    "duration: 1h",
    "verification_result: passed",
    "completed_at: 2026-04-24",
    "blocker_discovered: false",
    "---",
    "",
    `# ${sid}: Slice summary`,
    "**Short one-liner for the slice**",
    "",
    "## What Happened",
    "",
    narrativePara,
    "",
    "## Deviations",
    "",
    "Extended the excerpt helper scope at review time.",
    "",
    "## Known Limitations",
    "",
    "Does not yet cover validate-milestone — follow-up.",
    "",
    "## Follow-ups",
    "",
    "- Wire the same excerpt into buildValidateMilestonePrompt",
  ].join("\n");
}

function makeRoadmap(): string {
  return [
    "# M001 Roadmap",
    "## Slices",
    "- [x] **S01: Excerpt helper** `risk:medium` `depends:[]`",
    "- [x] **S02: Closer wiring** `risk:low` `depends:[S01]`",
  ].join("\n");
}

// ─── buildSliceSummaryExcerpt unit tests ──────────────────────────────────

test("#4780 excerpt: emits compact block with frontmatter fields + section heads", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  const absPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  const relPath = ".gsd/milestones/M001/slices/S01/S01-SUMMARY.md";
  writeSummary(base, "S01", makeFatSummary("S01"));

  const out = await buildSliceSummaryExcerpt(absPath, relPath, "S01");

  // Compact header with source path for on-demand Read
  assert.match(out, /### S01 Summary \(excerpt\)/);
  assert.match(out, /Source: `\.gsd\/milestones\/M001\/slices\/S01\/S01-SUMMARY\.md`/);

  // Frontmatter fields surfaced
  assert.match(out, /\*\*Title:\*\* S01: Slice summary/);
  assert.match(out, /\*\*One-liner:\*\*/);
  assert.match(out, /\*\*Verification:\*\* `passed`/);
  assert.match(out, /\*\*Blockers:\*\* none/);
  assert.match(out, /\*\*Provides:\*\* compact slice-summary excerpts;/);
  assert.match(out, /\*\*Key decisions:\*\* use parseSummary/);
  assert.match(out, /\*\*Patterns established:\*\* excerpt-first inlining/);

  // Section heads included (body-section markdown), not whole sections inlined
  assert.match(out, /#### Deviations/);
  assert.match(out, /#### Known limitations/);
  assert.match(out, /#### Follow-ups/);

  // On-demand instruction present
  assert.match(out, /On-demand.*read.*for the full "What Happened"/);

  // Bulk narrative is NOT inlined — excerpt is meaningfully shorter than full
  // A 20x-repeated paragraph produces ~2.5KB; excerpt should come in well under.
  const fullSize = makeFatSummary("S01").length;
  assert.ok(
    out.length < fullSize * 0.6,
    `excerpt length ${out.length} should be < 60% of full summary length ${fullSize}`,
  );
});

test("#4780 excerpt: blocker_discovered=true surfaces prominent marker", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  const content = [
    "---",
    "id: S01",
    "parent: M001",
    "milestone: M001",
    "blocker_discovered: true",
    "---",
    "# S01",
    "**One-liner**",
    "",
    "## What Happened",
    "content",
  ].join("\n");
  const absPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  writeSummary(base, "S01", content);

  const out = await buildSliceSummaryExcerpt(absPath, "rel", "S01");
  assert.match(out, /Blockers:\*\* ⚠️ blocker recorded/);
});

test("#4780 excerpt: fall back to full inline when frontmatter is unrecognizable", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  // No frontmatter, no id — parser returns empty id, triggering fallback
  const garbage = "# S99\n\nJust a wall of text with no frontmatter at all.\n";
  const absPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S99-SUMMARY.md");
  writeFileSync(absPath, garbage);

  const out = await buildSliceSummaryExcerpt(absPath, "rel/path.md", "S99");
  // Full content preserved (no excerpt wrapper), no data-loss
  assert.match(out, /Just a wall of text/);
  assert.match(out, /### S99 Summary/);
});

test("#4780 excerpt: missing file reports not-found fallback", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));

  const out = await buildSliceSummaryExcerpt(null, "rel/missing.md", "S42");
  assert.match(out, /### S42 Summary \(excerpt\)/);
  assert.match(out, /not found — file does not exist yet/);
});

test("#4780 excerpt: section bodies are capped (coderabbit review)", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  // Long Follow-ups section (~4.8KB) would balloon the excerpt without
  // the cap — regression coverage for the coderabbit finding on #4908.
  const longFollowUps = "A verbose follow-up bullet that keeps restating the same point. ".repeat(60);
  const content = [
    "---",
    "id: S01",
    "parent: M001",
    "milestone: M001",
    "---",
    "# S01: Test",
    "**One-liner**",
    "",
    "## Follow-ups",
    longFollowUps,
  ].join("\n");
  const absPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  writeSummary(base, "S01", content);

  const out = await buildSliceSummaryExcerpt(absPath, "rel/path.md", "S01");

  assert.match(out, /\(truncated — see full `rel\/path\.md`\)/);
  assert.ok(
    out.length < 2000,
    `excerpt length ${out.length} should be well under 2KB when one section hits the cap`,
  );
});

// ─── buildCompleteMilestonePrompt integration test ─────────────────────────

test("#4780 closer prompt: uses excerpts + lists on-demand slice SUMMARY paths", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  writeRoadmap(base, makeRoadmap());
  writeSummary(base, "S01", makeFatSummary("S01"));
  writeSummary(base, "S02", makeFatSummary("S02"));

  const prompt = await buildCompleteMilestonePrompt("M001", "Test Milestone", base);

  // Excerpt markers present for each slice
  assert.match(prompt, /### S01 Summary \(excerpt\)/);
  assert.match(prompt, /### S02 Summary \(excerpt\)/);

  // On-demand path section exists with both slice paths
  assert.match(prompt, /### On-demand Slice Summaries/);
  assert.match(prompt, /S01-SUMMARY\.md/);
  assert.match(prompt, /S02-SUMMARY\.md/);

  // Fat narrative (the 20x-repeated paragraph) is NOT inlined
  assert.ok(
    !prompt.includes("threads the cache key through every call site."),
    "closer prompt must not inline full 'What Happened' narrative after #4780",
  );

  // Prompt size is bounded — the two fat summaries' narratives alone would
  // have exceeded ~4KB each. Post-fix closer prompt should be meaningfully
  // smaller than their combined raw size.
  const rawSize = makeFatSummary("S01").length + makeFatSummary("S02").length;
  // Prompt includes roadmap, templates, and other inlines, so it may still
  // be sizable — the guard is specifically that the fat narrative is gone.
  // Use a soft bound: prompt - overhead should be less than 2x one summary.
  assert.ok(
    prompt.length < rawSize + 20_000,
    `closer prompt length ${prompt.length} should be < raw summary size ${rawSize} + 20KB headroom`,
  );
});
