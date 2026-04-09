import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateFileChanges } from "../safety/file-change-validator.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

test("validateFileChanges ignores inline descriptions in expected output paths", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-file-change-validator-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  mkdirSync(join(base, "definitions"), { recursive: true });
  git(base, "init");
  git(base, "config", "user.email", "test@example.com");
  git(base, "config", "user.name", "Test User");

  const target = join(base, "definitions", "ac-audit.md");
  writeFileSync(target, "initial\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "initial");

  writeFileSync(target, "updated\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "update");

  const audit = validateFileChanges(
    base,
    ["definitions/ac-audit.md — current state of AC CRM, tags, pipelines, automations"],
    [],
  );

  assert.ok(audit, "audit should be produced when expected output exists");
  assert.deepEqual(audit.unexpectedFiles, []);
  assert.deepEqual(audit.missingFiles, []);
  assert.equal(
    audit.violations.some((v) => v.severity === "warning"),
    false,
    "described expected output should not trigger unexpected-file warnings",
  );
});
