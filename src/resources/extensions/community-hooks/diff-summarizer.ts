// GSD Community Hooks — Diff Summarizer
//
// After each agent run, generates a concise summary of all file changes using
// git diff. Displays the summary as a notification so you always know what changed.

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { recordFire, recordAction } from "./stats.js";

interface FileStat {
  file: string;
  insertions: number;
  deletions: number;
}

function gitDiffStat(cwd: string): Promise<FileStat[]> {
  return new Promise((resolve) => {
    // Show both staged and unstaged changes
    execFile("git", ["diff", "--numstat", "HEAD"], {
      cwd,
      timeout: 10_000,
    }, (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }
      const stats: FileStat[] = [];
      for (const line of stdout.trim().split("\n")) {
        if (!line.trim()) continue;
        const [ins, del, file] = line.split("\t");
        if (file) {
          stats.push({
            file,
            insertions: parseInt(ins, 10) || 0,
            deletions: parseInt(del, 10) || 0,
          });
        }
      }
      resolve(stats);
    });
  });
}

function gitUntrackedFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd,
      timeout: 10_000,
    }, (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }
      resolve(stdout.trim().split("\n").filter(Boolean));
    });
  });
}

function formatSummary(stats: FileStat[], untracked: string[]): string {
  const totalIns = stats.reduce((s, f) => s + f.insertions, 0);
  const totalDel = stats.reduce((s, f) => s + f.deletions, 0);
  const changedCount = stats.length;
  const newCount = untracked.length;

  const parts: string[] = [];

  if (changedCount > 0) {
    parts.push(`${changedCount} file${changedCount !== 1 ? "s" : ""} changed (+${totalIns}/-${totalDel})`);
  }
  if (newCount > 0) {
    parts.push(`${newCount} new file${newCount !== 1 ? "s" : ""}`);
  }

  if (parts.length === 0) return "";

  // List individual files (cap at 10)
  const allFiles = [
    ...stats.map((s) => `  ${s.file} (+${s.insertions}/-${s.deletions})`),
    ...untracked.map((f) => `  ${f} (new)`),
  ];

  const fileList = allFiles.length > 10
    ? [...allFiles.slice(0, 10), `  ... and ${allFiles.length - 10} more`].join("\n")
    : allFiles.join("\n");

  return `${parts.join(", ")}:\n${fileList}`;
}

export function registerDiffSummarizer(pi: ExtensionAPI): void {
  pi.on("agent_end", async (_event, ctx) => {
    const cwd = process.cwd();

    const [stats, untracked] = await Promise.all([
      gitDiffStat(cwd),
      gitUntrackedFiles(cwd),
    ]);

    recordFire("diffSummarizer");
    const summary = formatSummary(stats, untracked);
    if (!summary) return;

    recordAction("diffSummarizer", `${stats.length} modified, ${untracked.length} new`);
    ctx.ui.notify(`Changes this run:\n${summary}`, "info");
  });
}
