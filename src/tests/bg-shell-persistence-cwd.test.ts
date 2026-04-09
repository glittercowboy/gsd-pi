import test from "node:test";
import assert from "node:assert/strict";

import {
  getBgShellLiveCwd,
  resolveBgShellPersistenceCwd,
} from "../resources/extensions/bg-shell/utilities.ts";

test("keeps non-worktree cwd unchanged", () => {
  const cached = "/repo";
  const live = "/repo";
  assert.equal(resolveBgShellPersistenceCwd(cached, live, () => true), cached);
});

test("rewrites stale auto-worktree cwd to live cwd after exit", () => {
  const cached = "/repo/.gsd/worktrees/M001";
  const live = "/repo";
  assert.equal(
    resolveBgShellPersistenceCwd(cached, live, (path) => path === live),
    live,
  );
});

test("rewrites mismatched auto-worktree cwd to live cwd even if old path still exists", () => {
  const cached = "/repo/.gsd/worktrees/M001";
  const live = "/repo";
  assert.equal(
    resolveBgShellPersistenceCwd(cached, live, () => true),
    live,
  );
});

test("rewrites Windows-style auto-worktree cwd to live cwd", () => {
  const cached = "C:\\repo\\.gsd\\worktrees\\M001";
  const live = "C:\\repo";
  assert.equal(
    resolveBgShellPersistenceCwd(cached, live, () => true),
    live,
  );
});

test("keeps current auto-worktree cwd when it still matches process cwd", () => {
  const cached = "/repo/.gsd/worktrees/M001";
  assert.equal(
    resolveBgShellPersistenceCwd(cached, cached, () => true),
    cached,
  );
});

test("falls back to project root when process.cwd throws inside a stale auto-worktree", () => {
  const cached = "/repo/.gsd/worktrees/M001";
  const live = getBgShellLiveCwd(
    cached,
    (path) => path === "/repo",
    () => {
      throw Object.assign(new Error("uv_cwd"), { code: "ENOENT", syscall: "uv_cwd" });
    },
    () => {},
  );

  assert.equal(live, "/repo");
  assert.equal(resolveBgShellPersistenceCwd(cached, live, (path) => path === "/repo"), "/repo");
});
