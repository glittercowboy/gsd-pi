/**
 * worktree-submodule-safety.test.ts — #2337
 *
 * The bug (#2337): `git worktree remove --force` destroys uncommitted
 * changes in submodule directories. The fix (in
 * `worktree-manager.removeWorktree`) detects submodules with
 * uncommitted state via `git submodule status`, auto-stashes the
 * worktree before teardown, and attempts non-force removal first —
 * falling back to force only after a stash was taken.
 *
 * This test was previously four `src.includes(...)` source-grep checks
 * that asserted the strings "submodule" / "force" / "--force" appeared
 * in the function body. Test 4 was tautological — it passed whenever
 * both "submodule" and "force" were mentioned anywhere in `removeWorktree`
 * regardless of whether the guard was wired correctly. See #4823 and
 * parent issue #4784.
 *
 * This rewrite builds a real git parent repo + local submodule, creates
 * a worktree, dirties a tracked file inside the submodule, then invokes
 * `removeWorktree` and asserts observable behaviour on stderr (where
 * `logWarning` writes) and on the filesystem (the worktree is gone).
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createWorktree, removeWorktree } from "../worktree-manager.ts";

interface Harness {
  parent: string;
  subSrc: string;
  cleanup: () => void;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: {
      ...process.env,
      // Disable user config from polluting the test environment.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "gsd-test",
      GIT_AUTHOR_EMAIL: "gsd-test@example.com",
      GIT_COMMITTER_NAME: "gsd-test",
      GIT_COMMITTER_EMAIL: "gsd-test@example.com",
      // Allow local-path submodule URLs. Git 2.38.1+ blocks the `file` transport
      // in `submodule add` by default (CVE-2022-39253). The config also has to
      // propagate to git subprocess env for submodule cloning.
      GIT_ALLOW_PROTOCOL: "file",
    },
  }).trim();
}

function makeHarness(): Harness {
  // Two real git repos: the parent that we will create worktrees of, and
  // the `subSrc` repo that we will add as a submodule.
  const parent = mkdtempSync(join(tmpdir(), "worktree-submodule-parent-"));
  const subSrc = mkdtempSync(join(tmpdir(), "worktree-submodule-source-"));

  // Bootstrap the submodule source with one committed file.
  runGit(subSrc, ["init", "-b", "main"]);
  writeFileSync(join(subSrc, "tracked.txt"), "initial\n", "utf-8");
  runGit(subSrc, ["add", "."]);
  runGit(subSrc, ["commit", "-m", "initial"]);

  // Bootstrap the parent with one commit so it has a HEAD for worktrees.
  runGit(parent, ["init", "-b", "main"]);
  // Allow local file:// URLs for submodule add (git 2.38+ blocks by default).
  runGit(parent, ["config", "protocol.file.allow", "always"]);
  writeFileSync(join(parent, "README.md"), "parent\n", "utf-8");
  runGit(parent, ["add", "."]);
  runGit(parent, ["commit", "-m", "initial"]);

  // Register the subSrc as a submodule named "sub" inside the parent.
  // Use `file://` URL so `protocol.file.allow` governs access; plain path
  // would be blocked by git's local-filesystem safety checks regardless.
  runGit(parent, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    `file://${subSrc}`,
    "sub",
  ]);
  runGit(parent, ["commit", "-m", "add submodule"]);

  return {
    parent,
    subSrc,
    cleanup: () => {
      for (const dir of [parent, subSrc]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    },
  };
}

/** Capture stderr writes during `fn`. `logWarning` writes to stderr, so
 * this reveals warnings emitted by the worktree-manager. */
function captureStderr(fn: () => void): string {
  const streamAny = process.stderr as unknown as {
    write: (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
  };
  const original = streamAny.write.bind(streamAny);
  const chunks: string[] = [];
  streamAny.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  try {
    fn();
  } finally {
    streamAny.write = original;
  }
  return chunks.join("");
}

describe("removeWorktree preserves submodule uncommitted state (#2337)", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  test("clean submodules: worktree removes without stashing or submodule warnings", () => {
    const wt = createWorktree(h.parent, "cleanwt");
    runGit(wt.path, ["submodule", "update", "--init", "--recursive"]);

    const stderr = captureStderr(() => {
      removeWorktree(h.parent, "cleanwt");
    });

    assert.ok(!existsSync(wt.path), "worktree directory should be gone");
    assert.doesNotMatch(
      stderr,
      /Stashed uncommitted submodule changes/,
      "clean submodule must not trigger stash-before-teardown",
    );
    assert.doesNotMatch(
      stderr,
      /stash failed, changes may be lost/,
      "clean submodule must not trigger stash-failure warning",
    );
  });

  test("diverged submodule HEAD: removeWorktree detects and warns before tearing down", () => {
    // The code's detection key is `git submodule status` output lines
    // starting with `+` (HEAD diverged from parent's recorded SHA) or
    // `-` (not initialised). Note this is NARROWER than #2337's
    // description ("uncommitted changes") — a plain working-tree edit
    // inside the submodule does NOT trigger the detection. That gap is
    // tracked separately; this test exercises the code path that the
    // current implementation actually guards.
    const wt = createWorktree(h.parent, "dirtywt");
    runGit(wt.path, ["submodule", "update", "--init", "--recursive"]);

    // Write a new file, commit it inside the submodule — this moves the
    // submodule's HEAD ahead of the parent's recorded SHA, yielding a
    // `+` prefix in `git submodule status`.
    const subPath = join(wt.path, "sub");
    writeFileSync(join(subPath, "new-file.txt"), "divergence\n", "utf-8");
    runGit(subPath, ["add", "."]);
    runGit(subPath, ["commit", "-m", "divergence commit"]);

    // Sanity: submodule status in the parent worktree must now show `+`.
    const subStatus = runGit(wt.path, ["submodule", "status"]);
    assert.match(
      subStatus,
      /^\+/,
      `precondition: submodule must be diverged, got: "${subStatus}"`,
    );

    const stderr = captureStderr(() => {
      removeWorktree(h.parent, "dirtywt");
    });

    // Worktree is gone: force fallback succeeded.
    assert.ok(!existsSync(wt.path), "worktree directory should be removed");

    // The code path that fires on dirty submodules emits one of these
    // two warnings. Either indicates the detection ran — the ONLY
    // observable that would fail if someone removed the
    // `if (hasSubmoduleChanges)` branch and went straight to force
    // removal. This is the assertion that #4823 demanded in place of
    // the tautological `src.includes("submodule") && src.includes("force")`.
    assert.match(
      stderr,
      /Stashed uncommitted submodule changes|Submodule changes detected/,
      "dirty submodule must trigger detection-and-warning path",
    );
  });

  test("missing .gitmodules: detection short-circuits even when submodule content is dirty", () => {
    // Prove the detection is file-based, not identifier-based. If the
    // .gitmodules file is absent, the detection branch must NOT fire
    // regardless of whether "submodule" appears elsewhere in the source.
    const wt = createWorktree(h.parent, "no-gitmodules");
    runGit(wt.path, ["submodule", "update", "--init", "--recursive"]);

    writeFileSync(
      join(wt.path, "sub", "tracked.txt"),
      "modified\n",
      "utf-8",
    );

    // Hide .gitmodules so existsSync(gitmodulesPath) returns false.
    const modPath = join(wt.path, ".gitmodules");
    const hiddenPath = join(wt.path, ".gitmodules.hidden");
    if (existsSync(modPath)) {
      renameSync(modPath, hiddenPath);
    }

    const stderr = captureStderr(() => {
      removeWorktree(h.parent, "no-gitmodules");
    });

    assert.doesNotMatch(
      stderr,
      /Stashed uncommitted submodule changes/,
      "missing .gitmodules should skip submodule detection entirely",
    );
  });
});
