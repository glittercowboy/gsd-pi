import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";

test("dispatch guard blocks when prior milestone has incomplete slices", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-"));
  try {
    mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });
    mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

    writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"),
      "# M002: Previous\n\n## Slices\n- [x] **S01: Done** `risk:low` `depends:[]`\n- [ ] **S02: Pending** `risk:low` `depends:[S01]`\n");
    writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"),
      "# M003: Current\n\n## Slices\n- [ ] **S01: First** `risk:low` `depends:[]`\n- [ ] **S02: Second** `risk:low` `depends:[S01]`\n");

    assert.equal(
      getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M003/S01"),
      "Cannot dispatch plan-slice M003/S01: earlier slice M002/S02 is not complete.",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dispatch guard blocks later slice in same milestone when earlier incomplete", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-"));
  try {
    mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });
    mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

    writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"),
      "# M002: Previous\n\n## Slices\n- [x] **S01: Done** `risk:low` `depends:[]`\n- [x] **S02: Done** `risk:low` `depends:[S01]`\n");
    writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"),
      "# M003: Current\n\n## Slices\n- [ ] **S01: First** `risk:low` `depends:[]`\n- [ ] **S02: Second** `risk:low` `depends:[S01]`\n");

    assert.equal(
      getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M003/S02/T01"),
      "Cannot dispatch execute-task M003/S02/T01: earlier slice M003/S01 is not complete.",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dispatch guard allows dispatch when all earlier slices complete", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-"));
  try {
    mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"),
      "# M003: Current\n\n## Slices\n- [x] **S01: First** `risk:low` `depends:[]`\n- [ ] **S02: Second** `risk:low` `depends:[S01]`\n");

    assert.equal(getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M003/S02/T01"), null);
    assert.equal(getPriorSliceCompletionBlocker(repo, "main", "plan-milestone", "M003"), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dispatch guard works without git repo", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-nogit-"));
  try {
    mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "# M001: Test\n\n## Slices\n- [x] **S01: Done** `risk:low` `depends:[]`\n- [ ] **S02: Pending** `risk:low` `depends:[S01]`\n");

    assert.equal(getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S02"), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dispatch guard skips parked milestones — they do not block later milestones", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-parked-"));
  try {
    // M004 is parked with incomplete slices
    mkdirSync(join(repo, ".gsd", "milestones", "M004"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M004", "M004-ROADMAP.md"),
      "# M004: Parked Milestone\n\n## Slices\n- [ ] **S01: Unfinished** `risk:high` `depends:[]`\n");
    writeFileSync(join(repo, ".gsd", "milestones", "M004", "M004-PARKED.md"),
      "---\nparked_at: 2026-03-18T09:00:00.000Z\nreason: \"Parked via /gsd park\"\n---\n\n# M004 — Parked\n");

    // M010 is the target milestone
    mkdirSync(join(repo, ".gsd", "milestones", "M010"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M010", "M010-ROADMAP.md"),
      "# M010: Active Milestone\n\n## Slices\n- [ ] **S01: First** `risk:high` `depends:[]`\n");

    // M004's incomplete S01 should NOT block M010/S01 because M004 is parked
    assert.equal(
      getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M010/S01"),
      null,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dispatch guard still blocks on non-parked incomplete milestones", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-mixed-"));
  try {
    // M003 is parked — should be skipped
    mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"),
      "# M003: Parked\n\n## Slices\n- [ ] **S01: Unfinished** `risk:high` `depends:[]`\n");
    writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-PARKED.md"),
      "---\nparked_at: 2026-03-18T09:00:00.000Z\nreason: \"Parked\"\n---\n");

    // M005 is NOT parked and has incomplete slices — should block
    mkdirSync(join(repo, ".gsd", "milestones", "M005"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M005", "M005-ROADMAP.md"),
      "# M005: Active Incomplete\n\n## Slices\n- [ ] **S01: Pending** `risk:low` `depends:[]`\n");

    // M010 is the target
    mkdirSync(join(repo, ".gsd", "milestones", "M010"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M010", "M010-ROADMAP.md"),
      "# M010: Target\n\n## Slices\n- [ ] **S01: First** `risk:low` `depends:[]`\n");

    // M005/S01 should block M010/S01 (M003 is parked, so skipped)
    assert.equal(
      getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M010/S01"),
      "Cannot dispatch plan-slice M010/S01: earlier slice M005/S01 is not complete.",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
