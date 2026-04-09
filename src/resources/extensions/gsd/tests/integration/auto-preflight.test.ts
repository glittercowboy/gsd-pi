import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runGSDDoctor, selectDoctorScope, filterDoctorIssues } from "../../doctor.js";

test("auto-preflight scopes to active milestone, ignoring historical", async (t) => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-auto-preflight-test-"));
  const gsd = join(tmpBase, ".gsd");

  mkdirSync(join(gsd, "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  mkdirSync(join(gsd, "milestones", "M009", "slices", "S01", "tasks"), { recursive: true });

  writeFileSync(join(gsd, "milestones", "M001", "M001-ROADMAP.md"), `# M001: Historical\n\n## Slices\n- [x] **S01: Old Slice** \`risk:low\` \`depends:[]\`\n  > After this: old done\n`);
  writeFileSync(join(gsd, "milestones", "M001", "slices", "S01", "S01-PLAN.md"), `# S01: Old Slice\n\n**Goal:** Old\n**Demo:** Old\n\n## Must-Haves\n- done\n\n## Tasks\n- [x] **T01: Old Task** \`est:5m\`\n  done\n`);
  writeFileSync(join(gsd, "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"), `---\nid: T01\nparent: S01\nmilestone: M001\nprovides: []\nrequires: []\naffects: []\nkey_files: []\nkey_decisions: []\npatterns_established: []\nobservability_surfaces: []\ndrill_down_paths: []\nduration: 5m\nverification_result: passed\ncompleted_at: 2026-03-09T00:00:00Z\n---\n\n# T01: Old Task\n\n**Done**\n\n## What Happened\nDone.\n\n## Diagnostics\n- log\n`);
  writeFileSync(join(gsd, "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"), `---\nid: S01\nparent: M001\nmilestone: M001\nprovides: []\nrequires: []\naffects: []\nkey_files: []\nkey_decisions: []\npatterns_established: []\nobservability_surfaces: []\ndrill_down_paths: []\nduration: 5m\nverification_result: passed\ncompleted_at: 2026-03-09T00:00:00Z\n---\n\n# S01: Old Slice\n\n**Done**\n\n## What Happened\nDone.\n\n## Verification\nDone.\n\n## Deviations\nNone\n\n## Known Limitations\nNone\n\n## Follow-ups\nNone\n\n## Files Created/Modified\n- \`x\` — x\n\n## Forward Intelligence\n\n### What the next slice should know\n- x\n\n### What's fragile\n- x\n\n### Authoritative diagnostics\n- x\n\n### What assumptions changed\n- x\n`);
  writeFileSync(join(gsd, "milestones", "M001", "M001-VALIDATION.md"), `---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.\n`);
  writeFileSync(join(gsd, "milestones", "M001", "M001-SUMMARY.md"), `---\nid: M001\nstatus: complete\ncompleted_at: 2026-03-09T00:00:00Z\n---\n\n# M001: Historical\n\nComplete.\n`);

  writeFileSync(join(gsd, "milestones", "M009", "M009-ROADMAP.md"), `# M009: Active\n\n## Slices\n- [ ] **S01: Active Slice** \`risk:low\` \`depends:[]\`\n  > After this: active works\n`);
  writeFileSync(join(gsd, "milestones", "M009", "slices", "S01", "S01-PLAN.md"), `# S01: Active Slice\n\n**Goal:** Active\n**Demo:** Active\n\n## Must-Haves\n- done\n\n## Tasks\n- [ ] **T01: Active Task** \`est:5m\`\n  todo\n`);

  t.after(() => rmSync(tmpBase, { recursive: true, force: true }));

  const scope = await selectDoctorScope(tmpBase);
  assert.equal(scope, "M009/S01", "active scope selected instead of historical milestone");

  const scopedReport = await runGSDDoctor(tmpBase, { fix: false, scope });
  const scopedBlocking = filterDoctorIssues(scopedReport.issues, { scope, includeWarnings: false });
  assert.equal(scopedBlocking.length, 0, "no blocking issues in active scope");

  const historicalReport = await runGSDDoctor(tmpBase, { fix: false });
  const historicalWarnings = historicalReport.issues.filter(issue => issue.unitId.startsWith("M001/S01") && issue.severity === "warning");
  assert.equal(historicalWarnings.length, 0, "completed historical milestone produces no checkbox/file-mismatch warnings");
});
