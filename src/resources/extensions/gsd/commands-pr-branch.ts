/**
 * GSD Command — /gsd pr-branch
 *
 * Creates a clean PR branch by cherry-picking only commits that
 * touch non-.gsd/ files. Useful for upstream PRs where .gsd/
 * planning artifacts should not be included.
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { execSync } from "node:child_process";

import {
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeBranchExists,
} from "./native-git-bridge.js";

function git(basePath: string, args: string): string {
  return execSync(`git ${args}`, { cwd: basePath, encoding: "utf-8" }).trim();
}

function getCodeOnlyCommits(basePath: string, base: string, head: string): string[] {
  // Get commits that have changes outside .gsd/ and .planning/
  try {
    const allCommits = git(basePath, `log --format=%H ${base}..${head}`).split("\n").filter(Boolean);
    const codeCommits: string[] = [];

    for (const sha of allCommits) {
      // Get files changed in this commit
      const files = git(basePath, `diff-tree --no-commit-id --name-only -r ${sha}`).split("\n").filter(Boolean);
      // Check if any files are outside .gsd/ and .planning/
      const hasCodeChanges = files.some(
        (f) => !f.startsWith(".gsd/") && !f.startsWith(".planning/") && f !== "PLAN.md",
      );
      if (hasCodeChanges) {
        codeCommits.push(sha);
      }
    }

    return codeCommits.reverse(); // Chronological order for cherry-picking
  } catch {
    return [];
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
    git(basePath, "rev-parse --verify upstream/main");
    baseRef = "upstream/main";
  } catch {
    baseRef = mainBranch;
  }

  // Find code-only commits
  const commits = getCodeOnlyCommits(basePath, baseRef, "HEAD");

  if (commits.length === 0) {
    ctx.ui.notify("No code-only commits found (all commits only touch .gsd/ files).", "info");
    return;
  }

  if (dryRun) {
    const lines = [`Would create PR branch with ${commits.length} commits (filtering .gsd/ paths):\n`];
    for (const sha of commits) {
      const msg = git(basePath, `log --format=%s -1 ${sha}`);
      lines.push(`  ${sha.slice(0, 8)} ${msg}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  const prBranch = nameMatch?.[1] ?? `pr/${currentBranch}`;

  if (nativeBranchExists(basePath, prBranch)) {
    ctx.ui.notify(
      `Branch ${prBranch} already exists. Use --name to specify a different name, or delete it first.`,
      "warning",
    );
    return;
  }

  try {
    // Create clean branch from base
    git(basePath, `checkout -b ${prBranch} ${baseRef}`);

    // Cherry-pick each code commit
    let picked = 0;
    for (const sha of commits) {
      try {
        git(basePath, `cherry-pick ${sha}`);
        picked++;
      } catch {
        // If cherry-pick fails (conflict), abort and report
        try {
          git(basePath, "cherry-pick --abort");
        } catch {
          // already aborted
        }
        ctx.ui.notify(
          `Cherry-pick conflict at ${sha.slice(0, 8)}. Picked ${picked}/${commits.length} commits. Resolve manually.`,
          "warning",
        );
        // Switch back to original branch
        git(basePath, `checkout ${currentBranch}`);
        return;
      }
    }

    ctx.ui.notify(
      `Created ${prBranch} with ${picked} commits (no .gsd/ artifacts).\nSwitch back: git checkout ${currentBranch}`,
      "success",
    );
  } catch (err) {
    // Restore original branch on failure
    try {
      git(basePath, `checkout ${currentBranch}`);
    } catch {
      // best effort
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to create PR branch: ${msg}`, "error");
  }
}
