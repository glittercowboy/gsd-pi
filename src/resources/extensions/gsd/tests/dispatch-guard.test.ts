import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";

let passed = 0;
let failed = 0;

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function run(command: string, cwd: string): void {
  execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

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

  run("git init -b main", repo);
  run("git config user.email test@example.com", repo);
  run("git config user.name Test", repo);
  run("git add .", repo);
  run("git commit -m init", repo);

  assertEq(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M003/S01"),
    "Cannot dispatch plan-slice M003/S01: earlier slice M002/S02 is not complete on main.",
    "blocks first slice of next milestone when prior milestone is incomplete on main",
  );

  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), [
    "# M002: Previous",
    "",
    "## Slices",
    "- [x] **S01: Done** `risk:low` `depends:[]`",
    "- [x] **S02: Done** `risk:low` `depends:[S01]`",
    "",
  ].join("\n"));
  run("git add .", repo);
  run("git commit -m complete-m002", repo);

  assertEq(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M003/S02/T01"),
    "Cannot dispatch execute-task M003/S02/T01: earlier slice M003/S01 is not complete on main.",
    "blocks later slice in same milestone when an earlier slice is incomplete on main",
  );

  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), [
    "# M003: Current",
    "",
    "## Slices",
    "- [x] **S01: First** `risk:low` `depends:[]`",
    "- [ ] **S02: Second** `risk:low` `depends:[S01]`",
    "",
  ].join("\n"));
  run("git add .", repo);
  run("git commit -m complete-m003-s01", repo);

  assertEq(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M003/S02/T01"),
    null,
    "allows dispatch when all earlier slices are complete on main",
  );

  assertEq(
    getPriorSliceCompletionBlocker(repo, "main", "plan-milestone", "M003"),
    null,
    "does not affect non-slice dispatch types",
  );
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
