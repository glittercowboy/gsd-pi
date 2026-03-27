import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSuggestedNextCommands, indexWorkspace, listDoctorScopeSuggestions } from "../workspace-index.ts";

test("workspace index: indexes active milestone/slice/task and suggests commands", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-workspace-index-test-"));
  const gsd = join(base, ".gsd");
  const mDir = join(gsd, "milestones", "M001");
  const sDir = join(mDir, "slices", "S01");
  mkdirSync(join(sDir, "tasks"), { recursive: true });

  writeFileSync(join(mDir, "M001-ROADMAP.md"), `# M001: Demo Milestone\n\n## Slices\n- [ ] **S01: Demo Slice** \`risk:low\` \`depends:[]\`\n  > After this: demo works\n`);
  writeFileSync(join(sDir, "S01-PLAN.md"), `# S01: Demo Slice\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Must-Haves\n- done\n\n## Tasks\n- [ ] **T01: Implement thing** \`est:10m\`\n  Task is in progress.\n`);
  writeFileSync(join(sDir, "tasks", "T01-PLAN.md"), `# T01: Implement thing\n\n## Steps\n- do it\n`);

  try {
    const index = await indexWorkspace(base);
    assert.equal(index.active.milestoneId, "M001");
    assert.equal(index.active.sliceId, "S01");
    assert.equal(index.active.taskId, "T01");
    assert.ok(index.scopes.some(s => s.scope === "M001/S01"));
    assert.ok(index.scopes.some(s => s.scope === "M001/S01/T01"));

    const suggestions = await listDoctorScopeSuggestions(base);
    assert.equal(suggestions[0].value, "M001/S01");
    assert.ok(suggestions.some(item => item.value === "M001/S01/T01"));

    const commands = await getSuggestedNextCommands(base);
    assert.ok(commands.includes("/gsd auto"));
    assert.ok(commands.includes("/gsd doctor M001/S01"));
    assert.ok(commands.includes("/gsd status"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("workspace index exposes authoritative milestone status and validation verdict", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-workspace-index-status-test-"));
  const gsd = join(base, ".gsd");
  const mDir = join(gsd, "milestones", "M001");
  const sDir = join(mDir, "slices", "S01");
  mkdirSync(join(sDir, "tasks"), { recursive: true });

  writeFileSync(join(mDir, "M001-ROADMAP.md"), `# M001: Demo Milestone\n\n## Slices\n- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`\n  > Demo works\n`);
  writeFileSync(join(sDir, "S01-PLAN.md"), `# S01: Done Slice\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Tasks\n- [x] **T01: Implement thing** \`est:10m\`\n  Done.\n`);
  writeFileSync(join(sDir, "tasks", "T01-PLAN.md"), `# T01: Implement thing\n\n## Steps\n- done\n`);
  writeFileSync(join(mDir, "M001-VALIDATION.md"), `---\nverdict: needs-attention\nremediation_round: 0\n---\n\n# Validation\nNeeds follow-up notes.\n`);
  writeFileSync(join(mDir, "M001-SUMMARY.md"), `# M001: Demo Milestone Summary\n\nDone.\n`);

  try {
    const index = await indexWorkspace(base);
    assert.equal(index.milestones[0]?.status, "complete");
    assert.equal(index.milestones[0]?.validationVerdict, "needs-attention");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
