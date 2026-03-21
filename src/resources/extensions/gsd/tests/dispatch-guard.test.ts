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
      "Cannot dispatch execute-task M003/S02/T01: dependency slice M003/S01 is not complete.",
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

test("dispatch guard unblocks slice when positionally-earlier slice depends on it (#1638)", () => {
  // S05 depends on S06, but S05 appears first positionally.
  // Old behavior: S06 blocked because S05 (positionally earlier) is incomplete.
  // Fixed behavior: S06 has no unmet dependencies, so it can dispatch.
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-"));
  try {
    mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "# M001: Test\n\n## Slices\n" +
      "- [x] **S01: Setup** `risk:low` `depends:[]`\n" +
      "- [x] **S02: Core** `risk:low` `depends:[S01]`\n" +
      "- [x] **S03: API** `risk:low` `depends:[S02]`\n" +
      "- [x] **S04: Auth** `risk:low` `depends:[S03]`\n" +
      "- [ ] **S05: Integration** `risk:high` `depends:[S04,S06]`\n" +
      "- [ ] **S06: Data Layer** `risk:medium` `depends:[S04]`\n");

    // S06 depends only on S04 (complete) — should be unblocked
    assert.equal(
      getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S06"),
      null,
    );

    // S05 depends on S04 (complete) and S06 (incomplete) — should be blocked
    assert.equal(
      getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S05"),
      "Cannot dispatch plan-slice M001/S05: dependency slice M001/S06 is not complete.",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dispatch guard falls back to positional ordering when no dependencies declared", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-"));
  try {
    mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "# M001: Test\n\n## Slices\n" +
      "- [x] **S01: First** `risk:low` `depends:[]`\n" +
      "- [ ] **S02: Second** `risk:low` `depends:[]`\n" +
      "- [ ] **S03: Third** `risk:low` `depends:[]`\n");

    // S03 has no dependencies — positional fallback blocks on S02
    assert.equal(
      getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S03"),
      "Cannot dispatch plan-slice M001/S03: earlier slice M001/S02 is not complete.",
    );

    // S02 has no dependencies — positional fallback: S01 is done, so unblocked
    assert.equal(
      getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S02"),
      null,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dispatch guard allows slice with all declared dependencies complete", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-"));
  try {
    mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "# M001: Test\n\n## Slices\n" +
      "- [x] **S01: Setup** `risk:low` `depends:[]`\n" +
      "- [x] **S02: Core** `risk:low` `depends:[S01]`\n" +
      "- [ ] **S03: Feature A** `risk:low` `depends:[S01,S02]`\n" +
      "- [ ] **S04: Feature B** `risk:low` `depends:[S01]`\n");

    // S03 depends on S01 (done) and S02 (done) — unblocked
    assert.equal(
      getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S03"),
      null,
    );

    // S04 depends only on S01 (done) — unblocked even though S03 is incomplete
    assert.equal(
      getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S04"),
      null,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dispatch guard skips completed milestone with SUMMARY even if it has unchecked remediation slices (#1716)", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-"));
  try {
    mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
    mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });

    // M001 is complete (has SUMMARY) but has unchecked remediation slices
    writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "# M001: Previous\n\n## Slices\n" +
      "- [x] **S01: Core** `risk:low` `depends:[]`\n" +
      "- [x] **S02: Tests** `risk:low` `depends:[S01]`\n" +
      "- [ ] **S03-R: Remediation** `risk:low` `depends:[S02]`\n" +
      "- [ ] **S04-R: Remediation 2** `risk:low` `depends:[S02]`\n");
    writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
      "---\nstatus: complete\n---\n# M001 Summary\nDone.\n");

    writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"),
      "# M002: Current\n\n## Slices\n- [ ] **S01: Start** `risk:low` `depends:[]`\n");

    // M001 has SUMMARY — should be skipped, not block M002/S01
    assert.equal(
      getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M002/S01"),
      null,
    );
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
