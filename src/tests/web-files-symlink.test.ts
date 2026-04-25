import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveSecurePath } from "../../web/lib/secure-path.ts";

test("web file API resolves normal project files under the canonical root", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-web-root-"));
  try {
    writeFileSync(join(root, "inside.txt"), "inside");

    assert.equal(resolveSecurePath("inside.txt", root), join(realpathSync.native(root), "inside.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("web file API rejects symlinks that resolve outside the project root", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-web-root-"));
  const outside = mkdtempSync(join(tmpdir(), "gsd-web-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "linked-secret.txt"));

    assert.equal(resolveSecurePath("linked-secret.txt", root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("web file API rejects writes through symlinked parent directories outside root", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-web-root-"));
  const outside = mkdtempSync(join(tmpdir(), "gsd-web-outside-"));
  try {
    symlinkSync(outside, join(root, "linked-outside"), "dir");

    assert.equal(resolveSecurePath("linked-outside/new.txt", root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
