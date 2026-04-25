/**
 * GSD Command — /gsd pr-branch
 *
 * Creates a clean PR branch by cherry-picking commits while stripping
 * any changes to .gsd/, .planning/, and PLAN.md paths. Useful for
 * upstream PRs where planning artifacts should not be included.
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { execFileSync } from "node:child_process";

import {
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeBranchExists,
} from "./native-git-bridge.js";

const EXCLUDED_PATHS = [".gsd", ".planning", "PLAN.md"] as const;

function git(basePath: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: basePath, encoding: "utf-8" }).trim();
}

function gitAllowFail(basePath: string, args: readonly string[]): void {
  try {
    execFileSync("git", args, { cwd: basePath, encoding: "utf-8", stdio: "pipe" });
  } catch {
    // ignored — caller opts into non-fatal behavior
  }
}

function hasStagedChanges(basePath: string): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: basePath,
      stdio: "pipe",
    });
    return false;
  } catch {
    return true;
  }
}

function isValidBranchName(name: string): boolean {
  try {
    execFileSync("git", ["check-ref-format", "--branch", name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getCodeOnlyCommits(basePath: string, base: string, head: string): string[] {
  try {
    const allCommits = git(basePath, ["log", "--format=%H", `${base}..${head}`])
      .split("\n")
      .filter(Boolean);
    const codeCommits: string[] = [];

    for (const sha of allCommits) {
      const files = git(basePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
        .split("\n")
        .filter(Boolean);
      const hasCodeChanges = files.some(
        (f) => !f.startsWith(".gsd/") && !f.startsWith(".planning/") && f !== "PLAN.md",
      );
      if (hasCodeChanges) {
        codeCommits.push(sha);
      }
    }

    return codeCommits.reverse(); // chronological for cherry-picking
  } catch {
    return [];
  }
}

/**
 * Cherry-pick a commit while stripping excluded paths from the resulting
 * commit. Returns true if a commit was produced, false if nothing remained
 * after filtering.
 */
function cherryPickFiltered(basePath: string, sha: string): boolean {
  git(basePath, ["cherry-pick", "--no-commit", "--allow-empty", sha]);

  // Unstage any excluded paths introduced by the cherry-pick.
  gitAllowFail(basePath, ["reset", "HEAD", "--", ...EXCLUDED_PATHS]);

  // Restore worktree state for excluded paths from HEAD (if tracked),
  // then remove any newly introduced untracked files under those paths.
  gitAllowFail(basePath, ["checkout", "HEAD", "--", ...EXCLUDED_PATHS]);
  gitAllowFail(basePath, ["clean", "-fdq", "--", ...EXCLUDED_PATHS]);

  if (!hasStagedChanges(basePath)) {
    // Nothing remained after filtering — discard worktree residue and skip.
    git(basePath, ["reset", "--hard", "HEAD"]);
    return false;
  }

  git(basePath, ["commit", "-C", sha]);
  return true;
}

function assertNoExcludedPaths(basePath: string, base: string): void {
  const files = git(basePath, [
    "diff",
    "--name-only",
    `${base}..HEAD`,
  ])
    .split("\n")
    .filter(Boolean);
  const leaked = files.filter(
    (f) => f.startsWith(".gsd/") || f.startsWith(".planning/") || f === "PLAN.md",
  );
  if (leaked.length > 0) {
    throw new Error(
      `PR branch still contains excluded paths: ${leaked.slice(0, 5).join(", ")}${
        leaked.length > 5 ? ` (+${leaked.length - 5} more)` : ""
      }`,
    );
  }
}

export async function handlePrBranch(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const basePath = process.cwd();
  const dryRun = args.includes("--dry-run");
  const nameMatch = args.match(/--name\s+(\S+)/);

  const currentBranch = nativeGetCurrentBranch(basePath);
  const mainBranch = nativeDetectMainBranch(basePath);

  // Determine base ref (prefer upstream/main if available)
  let baseRef: string;
  try {
    git(basePath, ["rev-parse", "--verify", "upstream/main"]);
    baseRef = "upstream/main";
  } catch {
    baseRef = mainBranch;
  }

  // Find commits with code changes
  const commits = getCodeOnlyCommits(basePath, baseRef, "HEAD");

  if (commits.length === 0) {
    ctx.ui.notify("No code-only commits found (all commits only touch .gsd/ files).", "info");
    return;
  }

  if (dryRun) {
    const lines = [`Would create PR branch with ${commits.length} commits (filtering .gsd/ paths):\n`];
    for (const sha of commits) {
      const msg = git(basePath, ["log", "--format=%s", "-1", sha]);
      lines.push(`  ${sha.slice(0, 8)} ${msg}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  const requestedName = nameMatch?.[1];
  if (requestedName && !isValidBranchName(requestedName)) {
    ctx.ui.notify(
      `Invalid branch name: ${requestedName}. Must satisfy git check-ref-format.`,
      "error",
    );
    return;
  }

  const defaultName = `pr/${currentBranch}`;
  const prBranch = requestedName ?? defaultName;

  if (!isValidBranchName(prBranch)) {
    ctx.ui.notify(
      `Derived branch name is invalid: ${prBranch}. Use --name to override.`,
      "error",
    );
    return;
  }

  if (nativeBranchExists(basePath, prBranch)) {
    ctx.ui.notify(
      `Branch ${prBranch} already exists. Use --name to specify a different name, or delete it first.`,
      "warning",
    );
    return;
  }

  try {
    // Create clean branch from base
    git(basePath, ["checkout", "-b", prBranch, baseRef]);

    // Cherry-pick with path filter
    let picked = 0;
    let skipped = 0;
    for (const sha of commits) {
      try {
        if (cherryPickFiltered(basePath, sha)) {
          picked++;
        } else {
          skipped++;
        }
      } catch (pickErr) {
        gitAllowFail(basePath, ["cherry-pick", "--abort"]);
        gitAllowFail(basePath, ["reset", "--hard", "HEAD"]);
        const detail = pickErr instanceof Error ? pickErr.message : String(pickErr);
        ctx.ui.notify(
          `Cherry-pick conflict at ${sha.slice(0, 8)}. Picked ${picked}/${commits.length} commits. Resolve manually.\n${detail}`,
          "warning",
        );
        git(basePath, ["checkout", currentBranch]);
        return;
      }
    }

    // Post-condition: no excluded paths should appear in the PR branch diff.
    assertNoExcludedPaths(basePath, baseRef);

    const skippedMsg = skipped > 0 ? ` (${skipped} skipped — contained only planning artifacts)` : "";
    ctx.ui.notify(
      `Created ${prBranch} with ${picked} commits${skippedMsg} (no .gsd/ artifacts).\nSwitch back: git checkout ${currentBranch}`,
      "success",
    );
  } catch (err) {
    // Restore original branch on failure
    gitAllowFail(basePath, ["cherry-pick", "--abort"]);
    gitAllowFail(basePath, ["reset", "--hard", "HEAD"]);
    gitAllowFail(basePath, ["checkout", currentBranch]);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to create PR branch: ${msg}`, "error");
  }
}
