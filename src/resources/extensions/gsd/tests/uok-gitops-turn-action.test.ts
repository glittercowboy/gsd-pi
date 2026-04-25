import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runTurnGitAction } from "../git-service.ts";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gsd-uok-gitops-"));
  run("git init", repo);
  run('git config user.email "test@example.com"', repo);
  run('git config user.name "Test User"', repo);
  writeFileSync(join(repo, "README.md"), "# Test\n", "utf-8");
  run("git add README.md", repo);
  run('git commit -m "chore: init"', repo);
  return repo;
}

test("uok gitops turn action status-only reports working tree dirtiness", () => {
  const repo = makeRepo();
  try {
    const clean = runTurnGitAction({
      basePath: repo,
      action: "status-only",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
    });
    assert.equal(clean.status, "ok");
    assert.equal(clean.dirty, false);

    writeFileSync(join(repo, "README.md"), "# Dirty\n", "utf-8");
    const dirty = runTurnGitAction({
      basePath: repo,
      action: "status-only",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
    });
    assert.equal(dirty.status, "ok");
    assert.equal(dirty.dirty, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("uok gitops turn action snapshot writes snapshot refs", () => {
  const repo = makeRepo();
  try {
    const result = runTurnGitAction({
      basePath: repo,
      action: "snapshot",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
    });
    assert.equal(result.status, "ok");
    assert.ok(result.snapshotLabel?.includes("execute-task/M001/S01/T01"));
    const refs = run("git for-each-ref refs/gsd/snapshots/ --format='%(refname)'", repo);
    assert.ok(refs.includes("refs/gsd/snapshots/execute-task/M001/S01/T01/"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("uok gitops turn action commit creates commit with unit trailer", () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n", "utf-8");
    const result = runTurnGitAction({
      basePath: repo,
      action: "commit",
      unitType: "execute-task",
      unitId: "M001/S01/T02",
    });
    assert.equal(result.status, "ok");
    assert.ok(result.commitMessage?.includes("chore: auto-commit after execute-task"));
    const body = run("git log -1 --pretty=%B", repo);
    assert.ok(body.includes("GSD-Unit: M001/S01/T02"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
