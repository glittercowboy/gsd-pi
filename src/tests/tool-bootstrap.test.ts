import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureManagedTools, resolveToolFromPath } from "../tool-bootstrap.js";

function makeExecutable(dir: string, name: string, content = "#!/bin/sh\nexit 0\n"): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  chmodSync(file, 0o755);
  return file;
}

test("resolveToolFromPath finds fd via fdfind fallback", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-tool-bootstrap-resolve-"));
  try {
    makeExecutable(tmp, "fdfind");
    const resolved = resolveToolFromPath("fd", tmp);
    assert.equal(resolved, join(tmp, "fdfind"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureManagedTools provisions fd and rg into managed bin dir", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-tool-bootstrap-provision-"));
  const sourceBin = join(tmp, "source-bin");
  const targetBin = join(tmp, "target-bin");

  mkdirSync(sourceBin, { recursive: true });
  mkdirSync(targetBin, { recursive: true });

  try {
    makeExecutable(sourceBin, "fdfind");
    makeExecutable(sourceBin, "rg");

    const provisioned = ensureManagedTools(targetBin, sourceBin);

    assert.equal(provisioned.length, 2);
    assert.ok(existsSync(join(targetBin, "fd")));
    assert.ok(existsSync(join(targetBin, "rg")));
    assert.ok(lstatSync(join(targetBin, "fd")).isSymbolicLink() || lstatSync(join(targetBin, "fd")).isFile());
    assert.ok(lstatSync(join(targetBin, "rg")).isSymbolicLink() || lstatSync(join(targetBin, "rg")).isFile());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureManagedTools copies executable when symlink target already exists as a broken link", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-tool-bootstrap-copy-"));
  const sourceBin = join(tmp, "source-bin");
  const targetBin = join(tmp, "target-bin");
  const targetFd = join(targetBin, "fd");

  mkdirSync(sourceBin, { recursive: true });
  mkdirSync(targetBin, { recursive: true });

  try {
    makeExecutable(sourceBin, "fdfind", "#!/bin/sh\necho fd\n");
    makeExecutable(sourceBin, "rg", "#!/bin/sh\necho rg\n");
    symlinkSync(join(tmp, "missing-target"), targetFd);

    const provisioned = ensureManagedTools(targetBin, sourceBin);

    assert.equal(provisioned.length, 2);
    assert.ok(lstatSync(targetFd).isFile(), "fd fallback should replace broken symlink with a copied file");
    assert.match(readFileSync(targetFd, "utf8"), /echo fd/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
