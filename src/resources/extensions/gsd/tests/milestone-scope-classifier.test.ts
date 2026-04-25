// GSD-2 — #4781: classifier behavior matrix. Pure-function tests, no I/O.

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyMilestoneScope,
  type MilestoneScopeInput,
} from "../milestone-scope-classifier.ts";

// ─── Classification matrix ────────────────────────────────────────────────

test("#4781 classifier: single static HTML to-do app → trivial (b23 forensic case)", () => {
  const input: MilestoneScopeInput = {
    title: "To-Do App",
    vision: "A minimal, clean browser-based to-do app. Pure HTML/CSS/JS, no build step, no backend. Tasks persist in localStorage.",
    successCriteria: [
      "Open index.html in any browser without a server",
      "Add tasks by typing and pressing Enter or clicking Add",
      "Mark tasks complete (toggleable)",
      "Delete individual tasks",
      "Tasks survive a page reload via localStorage",
    ],
  };
  const r = classifyMilestoneScope(input);
  assert.strictEqual(r.variant, "trivial", `expected trivial, got ${r.variant} — reasons: ${r.reasons.join("; ")}`);
  assert.ok(r.reasons.some(s => s.includes("trivial keywords")), "should cite trivial keywords");
});

test("#4781 classifier: readme typo fix → trivial", () => {
  const r = classifyMilestoneScope({
    title: "Fix README typo",
    vision: "Correct spelling error in the installation section.",
    successCriteria: ["Typo fixed", "README renders correctly"],
  });
  assert.strictEqual(r.variant, "trivial");
});

test("#4781 classifier: auth flow single file → standard (override beats trivial)", () => {
  const r = classifyMilestoneScope({
    title: "Add login",
    vision: "Implement authentication flow in a single file with OAuth credentials.",
    successCriteria: ["User can log in"],
  });
  assert.strictEqual(r.variant, "standard", `override should beat single-file signal. reasons: ${r.reasons.join("; ")}`);
  assert.ok(r.signals.triggeredOverride, "override signals should be flagged");
  assert.ok(r.reasons.some(s => s.includes("override keywords")));
});

test("#4781 classifier: security review scope → standard (even if small)", () => {
  const r = classifyMilestoneScope({
    title: "Harden session tokens",
    vision: "Review and patch security vulnerability in one session token helper.",
    successCriteria: ["No XSS via token"],
  });
  assert.strictEqual(r.variant, "standard");
  assert.ok(r.signals.triggeredOverride);
});

test("#4781 classifier: schema migration mentioned → standard (override-level signal)", () => {
  const r = classifyMilestoneScope({
    title: "User profile v2",
    vision: "Perform schema migration to split user.name into first_name and last_name across the users table.",
    successCriteria: ["Migration lands", "Existing rows backfilled", "Rollback path validated"],
  });
  // "migration" / "migrate" / "backfill" are OVERRIDE_KEYWORDS, not
  // COMPLEX_KEYWORDS — migration is override-level (forces at least
  // `standard`), not complex-level. Safe behavior: migrations need the
  // full standard pipeline but not the extra ceremony of complex.
  assert.strictEqual(r.variant, "standard", `reasons: ${r.reasons.join("; ")}`);
});

test("#4781 classifier: architecture keyword → complex", () => {
  const r = classifyMilestoneScope({
    title: "Redesign plugin registry",
    vision: "Refactor core architecture of the plugin registry to support versioned contracts.",
  });
  assert.strictEqual(r.variant, "complex");
  assert.ok(r.reasons.some(s => s.includes("complex keywords")));
});

test("#4781 classifier: >=8 files hint → complex", () => {
  const r = classifyMilestoneScope({
    title: "Multi-file refactor",
    vision: "Touch 12 files to extract shared helpers.",
  });
  assert.strictEqual(r.variant, "complex");
  assert.strictEqual(r.signals.fileCountHint, 12);
});

test("#4781 classifier: backend API mention → standard (not trivial)", () => {
  const r = classifyMilestoneScope({
    title: "Health endpoint",
    vision: "Add a single-file API endpoint returning status.",
    successCriteria: ["/health returns 200"],
  });
  // Single file + no override + but backend mentioned → not trivial
  assert.strictEqual(r.variant, "standard");
});

test("#4781 classifier: tests mentioned → standard (not trivial)", () => {
  const r = classifyMilestoneScope({
    title: "Landing page",
    vision: "Ship a static one-page landing page with unit tests for the form validation.",
  });
  assert.strictEqual(r.variant, "standard", `reasons: ${r.reasons.join("; ")}`);
});

test("#4781 classifier: ambiguous prose → standard (safe default)", () => {
  const r = classifyMilestoneScope({
    title: "Generic improvements",
    vision: "Make the system better.",
    successCriteria: ["It's better"],
  });
  assert.strictEqual(r.variant, "standard");
  assert.ok(r.reasons.includes("no strong signals — default"));
});

test("#4781 classifier: empty input → standard (safe default)", () => {
  const r = classifyMilestoneScope({});
  assert.strictEqual(r.variant, "standard");
});

// ─── Override precedence over trivial ──────────────────────────────────────

test("#4781 classifier: override + trivial keyword → standard (override wins)", () => {
  const r = classifyMilestoneScope({
    title: "Token rotation",
    vision: "Single file change to rotate the oauth token expiry schedule.",
  });
  // "single file" is trivial signal; "oauth" is override signal. Override wins.
  assert.strictEqual(r.variant, "standard");
  assert.ok(r.signals.triggeredOverride);
});

test("#4781 classifier: complex + override → complex (complex wins, flagged)", () => {
  const r = classifyMilestoneScope({
    title: "Auth service refactor",
    vision: "Refactor core authentication architecture across services.",
  });
  // Complex (architecture, refactor core) wins over override (auth).
  assert.strictEqual(r.variant, "complex");
  // Override still recorded in signals for telemetry.
  assert.ok(r.signals.triggeredOverride, "override hits should still be tracked in signals");
});

// ─── File count hint extraction ───────────────────────────────────────────

test("#4781 classifier: 'a single file' hint parsed as 1", () => {
  const r = classifyMilestoneScope({
    title: "Tweak",
    vision: "Update a single file to flip the copy.",
  });
  assert.strictEqual(r.signals.fileCountHint, 1);
});

test("#4781 classifier: 'two files' hint parsed as 2", () => {
  const r = classifyMilestoneScope({
    title: "Minor",
    vision: "Touch two files.",
  });
  assert.strictEqual(r.signals.fileCountHint, 2);
});

test("#4781 classifier: '12 files' hint parsed as 12", () => {
  const r = classifyMilestoneScope({
    title: "Bulk",
    vision: "Update 12 files.",
  });
  assert.strictEqual(r.signals.fileCountHint, 12);
});

// ─── Reasons surface useful debugging info ─────────────────────────────────

test("#4781 classifier: reasons array populated for every branch", () => {
  const branches: Array<[string, MilestoneScopeInput]> = [
    ["trivial", { title: "Readme typo", vision: "Fix a single file typo." }],
    ["standard (override)", { title: "Auth", vision: "Touch auth helper." }],
    ["complex (keyword)", { title: "Arch", vision: "Refactor core system design." }],
    ["complex (file count)", { title: "Bulk", vision: "Update 9 files." }],
    ["standard (default)", { title: "Generic", vision: "General work." }],
  ];
  for (const [label, input] of branches) {
    const r = classifyMilestoneScope(input);
    assert.ok(r.reasons.length > 0, `${label}: reasons must not be empty`);
  }
});
