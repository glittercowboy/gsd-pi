// GSD Dispatch Guard Tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();

const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-"));
try {
  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), [
    "# M002: Previous",
    "",
    "## Slices",
    "- [x] **S01: Done** `risk:low` `depends:[]`",
    "- [ ] **S02: Pending** `risk:low` `depends:[S01]`",
    "",
  ].join("\n"));

  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), [
    "# M003: Current",
    "",
    "## Slices",
    "- [ ] **S01: First** `risk:low` `depends:[]`",
    "- [ ] **S02: Second** `risk:low` `depends:[S01]`",
    "",
  ].join("\n"));

  // dispatch-guard now reads from disk, not git — no need for git init/commit
  assertEq(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M003/S01"),
    "Cannot dispatch plan-slice M003/S01: earlier slice M002/S02 is not complete.",
    "blocks first slice of next milestone when prior milestone is incomplete",
  );

  // Complete M002 on disk
  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), [
    "# M002: Previous",
    "",
    "## Slices",
    "- [x] **S01: Done** `risk:low` `depends:[]`",
    "- [x] **S02: Done** `risk:low` `depends:[S01]`",
    "",
  ].join("\n"));

  assertEq(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M003/S02/T01"),
    "Cannot dispatch execute-task M003/S02/T01: earlier slice M003/S01 is not complete.",
    "blocks later slice in same milestone when an earlier slice is incomplete",
  );

  // Complete M003/S01 on disk
  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), [
    "# M003: Current",
    "",
    "## Slices",
    "- [x] **S01: First** `risk:low` `depends:[]`",
    "- [ ] **S02: Second** `risk:low` `depends:[S01]`",
    "",
  ].join("\n"));

  assertEq(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M003/S02/T01"),
    null,
    "allows dispatch when all earlier slices are complete on disk",
  );

  assertEq(
    getPriorSliceCompletionBlocker(repo, "main", "plan-milestone", "M003"),
    null,
    "does not affect non-slice dispatch types",
  );

  // Verify disk-based reads work without any git repo (#530)
  const noGitRepo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-nogit-"));
  try {
    mkdirSync(join(noGitRepo, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(noGitRepo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), [
      "# M001: Test",
      "",
      "## Slices",
      "- [x] **S01: Done** `risk:low` `depends:[]`",
      "- [ ] **S02: Pending** `risk:low` `depends:[S01]`",
      "",
    ].join("\n"));

    assertEq(
      getPriorSliceCompletionBlocker(noGitRepo, "main", "plan-slice", "M001/S02"),
      null,
      "allows dispatch for S02 when S01 is complete (no git repo needed)",
    );
  } finally {
    rmSync(noGitRepo, { recursive: true, force: true });
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}

report();
