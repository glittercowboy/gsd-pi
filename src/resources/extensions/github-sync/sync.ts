/**
 * Core GitHub sync engine.
 *
 * Entry point: `runGitHubSync()` — called from the GSD post-unit pipeline.
 * Routes to per-event sync functions based on the unit type, reads GSD
 * files to build GitHub entities, and persists the sync mapping.
 *
 * All errors are caught internally — sync failures never block execution.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadFile, parseSummary } from "../gsd/files.js";
import { parseRoadmap, parsePlan } from "../gsd/parsers-legacy.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
  resolveTaskFile,
} from "../gsd/paths.js";
import { debugLog } from "../gsd/debug-logger.js";
import { loadEffectiveGSDPreferences } from "../gsd/preferences.js";

import type { GitHubSyncConfig, SyncMapping } from "./types.js";
import {
  loadSyncMapping,
  saveSyncMapping,
  createEmptyMapping,
  getMilestoneRecord,
  getSliceRecord,
  getTaskRecord,
  setMilestoneRecord,
  setSliceRecord,
  setTaskRecord,
} from "./mapping.js";
import {
  ghIsAvailable,
  ghHasRateLimit,
  ghDetectRepo,
  ghCreateIssue,
  ghCloseIssue,
  ghAddComment,
  ghCreateMilestone,
  ghCloseMilestone,
  ghCreatePR,
  ghMarkPRReady,
  ghMergePR,
  ghCreateBranch,
  ghPushBranch,
  ghAddToProject,
} from "./cli.js";
import {
  formatMilestoneIssueBody,
  formatSlicePRBody,
  formatTaskIssueBody,
  formatSummaryComment,
} from "./templates.js";

// ─── Entry Point ────────────────────────────────────────────────────────────

/**
 * Main sync entry point — called from GSD post-unit pipeline.
 * Routes to the appropriate sync function based on unit type.
 */
export async function runGitHubSync(
  basePath: string,
  unitType: string,
  unitId: string,
): Promise<void> {
  try {
    const config = loadGitHubSyncConfig(basePath);
    if (!config?.enabled) return;
    if (!ghIsAvailable()) {
      debugLog("github-sync", { skip: "gh CLI not available" });
      return;
    }

    // Resolve repo
    const repo = config.repo ?? resolveRepo(basePath);
    if (!repo) {
      debugLog("github-sync", { skip: "could not detect repo" });
      return;
    }

    // Rate limit check
    if (!ghHasRateLimit(basePath)) {
      debugLog("github-sync", { skip: "rate limit low" });
      return;
    }

    // Load or init mapping
    let mapping = loadSyncMapping(basePath) ?? createEmptyMapping(repo);
    mapping.repo = repo;

    // Parse unit ID parts
    const parts = unitId.split("/");
    const [mid, sid, tid] = parts;

    // Route by unit type
    switch (unitType) {
      case "plan-milestone":
        if (mid) await syncMilestonePlan(basePath, mapping, config, mid);
        break;
      case "plan-slice":
      case "research-slice":
        if (mid && sid) await syncSlicePlan(basePath, mapping, config, mid, sid);
        break;
      case "execute-task":
      case "reactive-execute":
        if (mid && sid && tid) await syncTaskComplete(basePath, mapping, config, mid, sid, tid);
        break;
      case "complete-slice":
        if (mid && sid) await syncSliceComplete(basePath, mapping, config, mid, sid);
        break;
      case "complete-milestone":
        if (mid) await syncMilestoneComplete(basePath, mapping, config, mid);
        break;
    }

    saveSyncMapping(basePath, mapping);
  } catch (err) {
    debugLog("github-sync", { error: String(err) });
  }
}

// ─── Per-Event Sync Functions ───────────────────────────────────────────────

async function syncMilestonePlan(
  basePath: string,
  mapping: SyncMapping,
  config: GitHubSyncConfig,
  mid: string,
): Promise<void> {
  // Skip if already synced
  if (getMilestoneRecord(mapping, mid)) return;

  // Load roadmap data
  const roadmapPath = resolveMilestoneFile(basePath, mid, "ROADMAP");
  if (!roadmapPath) return;
  const content = await loadFile(roadmapPath);
  if (!content) return;

  const roadmap = parseRoadmap(content);
  const title = `${mid}: ${roadmap.title || "Milestone"}`;

  // Create GitHub Milestone
  const milestoneResult = ghCreateMilestone(
    basePath,
    mapping.repo,
    title,
    roadmap.vision || "",
  );
  if (!milestoneResult.ok) {
    debugLog("github-sync", { phase: "create-milestone", error: milestoneResult.error });
    return;
  }
  const ghMilestoneNumber = milestoneResult.data!;

  // Create tracking issue
  const issueBody = formatMilestoneIssueBody({
    id: mid,
    title: roadmap.title || "Milestone",
    vision: roadmap.vision,
    successCriteria: roadmap.successCriteria,
    slices: roadmap.slices?.map(s => ({
      id: s.id,
      title: s.title,
    })),
  });

  const issueResult = ghCreateIssue(basePath, {
    repo: mapping.repo,
    title: `${mid}: ${roadmap.title || "Milestone"} — Tracking`,
    body: issueBody,
    labels: config.labels,
    milestone: ghMilestoneNumber,
  });
  if (!issueResult.ok) {
    debugLog("github-sync", { phase: "create-tracking-issue", error: issueResult.error });
    return;
  }

  // Add to project if configured
  if (config.project) {
    ghAddToProject(basePath, mapping.repo, config.project, issueResult.data!);
  }

  setMilestoneRecord(mapping, mid, {
    issueNumber: issueResult.data!,
    ghMilestoneNumber,
    lastSyncedAt: new Date().toISOString(),
    state: "open",
  });

  debugLog("github-sync", {
    phase: "milestone-synced",
    mid,
    milestone: ghMilestoneNumber,
    issue: issueResult.data,
  });
}

async function syncSlicePlan(
  basePath: string,
  mapping: SyncMapping,
  config: GitHubSyncConfig,
  mid: string,
  sid: string,
): Promise<void> {
  // Skip if already synced
  if (getSliceRecord(mapping, mid, sid)) return;

  // Ensure milestone is synced first
  if (!getMilestoneRecord(mapping, mid)) {
    await syncMilestonePlan(basePath, mapping, config, mid);
  }
  const milestoneRecord = getMilestoneRecord(mapping, mid);

  // Load slice plan
  const planPath = resolveSliceFile(basePath, mid, sid, "PLAN");
  if (!planPath) return;
  const content = await loadFile(planPath);
  if (!content) return;

  const plan = parsePlan(content);
  const sliceBranch = `milestone/${mid}/${sid}`;
  const milestoneBranch = `milestone/${mid}`;

  // Create task sub-issues first (so we can link them in the PR body)
  const taskIssueNumbers: Array<{ id: string; title: string; issueNumber?: number }> = [];

  if (plan.tasks) {
    for (const task of plan.tasks) {
      // Skip if already synced
      if (getTaskRecord(mapping, mid, sid, task.id)) {
        const existing = getTaskRecord(mapping, mid, sid, task.id)!;
        taskIssueNumbers.push({ id: task.id, title: task.title, issueNumber: existing.issueNumber });
        continue;
      }

      const taskBody = formatTaskIssueBody({
        id: task.id,
        title: task.title,
        description: task.description,
        files: task.files,
        verifyCriteria: task.verify ? [task.verify] : undefined,
      });

      const taskResult = ghCreateIssue(basePath, {
        repo: mapping.repo,
        title: `${mid}/${sid}/${task.id}: ${task.title}`,
        body: taskBody,
        labels: config.labels,
        milestone: milestoneRecord?.ghMilestoneNumber,
        parentIssue: milestoneRecord?.issueNumber,
      });

      if (taskResult.ok) {
        setTaskRecord(mapping, mid, sid, task.id, {
          issueNumber: taskResult.data!,
          lastSyncedAt: new Date().toISOString(),
          state: "open",
        });
        taskIssueNumbers.push({ id: task.id, title: task.title, issueNumber: taskResult.data! });

        if (config.project) {
          ghAddToProject(basePath, mapping.repo, config.project, taskResult.data!);
        }
      } else {
        taskIssueNumbers.push({ id: task.id, title: task.title });
      }
    }
  }

  if (config.slice_prs === false) {
    // Slice PRs disabled — just record without PR
    setSliceRecord(mapping, mid, sid, {
      issueNumber: 0,
      prNumber: 0,
      branch: sliceBranch,
      lastSyncedAt: new Date().toISOString(),
      state: "open",
    });
    return;
  }

  // Create slice branch from milestone branch
  const branchResult = ghCreateBranch(basePath, sliceBranch, milestoneBranch);
  if (!branchResult.ok) {
    debugLog("github-sync", { phase: "create-slice-branch", error: branchResult.error });
    // Branch might already exist — continue anyway
  }

  // Push the slice branch
  const pushResult = ghPushBranch(basePath, sliceBranch);
  if (!pushResult.ok) {
    debugLog("github-sync", { phase: "push-slice-branch", error: pushResult.error });
  }

  // Create draft PR
  const prBody = formatSlicePRBody({
    id: sid,
    title: plan.title || sid,
    goal: plan.goal,
    mustHaves: plan.mustHaves,
    demoCriterion: plan.demo,
    tasks: taskIssueNumbers,
  });

  const prResult = ghCreatePR(basePath, {
    repo: mapping.repo,
    base: milestoneBranch,
    head: sliceBranch,
    title: `${sid}: ${plan.title || sid}`,
    body: prBody,
    draft: true,
  });

  const prNumber = prResult.ok ? prResult.data! : 0;
  if (!prResult.ok) {
    debugLog("github-sync", { phase: "create-slice-pr", error: prResult.error });
  }

  setSliceRecord(mapping, mid, sid, {
    issueNumber: 0, // Slice doesn't get its own issue — tracked via PR
    prNumber,
    branch: sliceBranch,
    lastSyncedAt: new Date().toISOString(),
    state: "open",
  });

  debugLog("github-sync", {
    phase: "slice-synced",
    mid,
    sid,
    pr: prNumber,
    taskIssues: taskIssueNumbers.filter(t => t.issueNumber).length,
  });
}

async function syncTaskComplete(
  basePath: string,
  mapping: SyncMapping,
  config: GitHubSyncConfig,
  mid: string,
  sid: string,
  tid: string,
): Promise<void> {
  const taskRecord = getTaskRecord(mapping, mid, sid, tid);
  if (!taskRecord || taskRecord.state === "closed") return;

  // Load task summary
  const summaryPath = resolveTaskFile(basePath, mid, sid, tid, "SUMMARY");
  if (summaryPath) {
    const content = await loadFile(summaryPath);
    if (content) {
      const summary = parseSummary(content);
      const comment = formatSummaryComment({
        oneLiner: summary.oneLiner,
        body: summary.whatHappened,
        frontmatter: summary.frontmatter as unknown as Record<string, unknown>,
      });
      ghAddComment(basePath, mapping.repo, taskRecord.issueNumber, comment);
    }
  }

  // Close the task issue
  ghCloseIssue(basePath, mapping.repo, taskRecord.issueNumber);

  taskRecord.state = "closed";
  taskRecord.lastSyncedAt = new Date().toISOString();
  setTaskRecord(mapping, mid, sid, tid, taskRecord);

  debugLog("github-sync", { phase: "task-closed", mid, sid, tid, issue: taskRecord.issueNumber });
}

async function syncSliceComplete(
  basePath: string,
  mapping: SyncMapping,
  config: GitHubSyncConfig,
  mid: string,
  sid: string,
): Promise<void> {
  const sliceRecord = getSliceRecord(mapping, mid, sid);
  if (!sliceRecord || sliceRecord.state === "closed") return;

  // Post slice summary as PR comment
  const summaryPath = resolveSliceFile(basePath, mid, sid, "SUMMARY");
  if (summaryPath && sliceRecord.prNumber) {
    const content = await loadFile(summaryPath);
    if (content) {
      const summary = parseSummary(content);
      const comment = formatSummaryComment({
        oneLiner: summary.oneLiner,
        body: summary.whatHappened,
        frontmatter: summary.frontmatter as unknown as Record<string, unknown>,
      });
      ghAddComment(basePath, mapping.repo, sliceRecord.prNumber, comment);
    }
  }

  // Mark PR ready for review, then merge
  if (sliceRecord.prNumber) {
    ghMarkPRReady(basePath, mapping.repo, sliceRecord.prNumber);
    // Squash-merge into milestone branch
    ghMergePR(basePath, mapping.repo, sliceRecord.prNumber, "squash");
  }

  sliceRecord.state = "closed";
  sliceRecord.lastSyncedAt = new Date().toISOString();
  setSliceRecord(mapping, mid, sid, sliceRecord);

  debugLog("github-sync", { phase: "slice-completed", mid, sid, pr: sliceRecord.prNumber });
}

async function syncMilestoneComplete(
  basePath: string,
  mapping: SyncMapping,
  config: GitHubSyncConfig,
  mid: string,
): Promise<void> {
  const record = getMilestoneRecord(mapping, mid);
  if (!record || record.state === "closed") return;

  // Close tracking issue
  ghCloseIssue(
    basePath,
    mapping.repo,
    record.issueNumber,
    `Milestone ${mid} completed.`,
  );

  // Close GitHub milestone
  ghCloseMilestone(basePath, mapping.repo, record.ghMilestoneNumber);

  record.state = "closed";
  record.lastSyncedAt = new Date().toISOString();
  setMilestoneRecord(mapping, mid, record);

  debugLog("github-sync", { phase: "milestone-completed", mid });
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

/**
 * Walk the `.gsd/milestones/` tree and create GitHub entities for any
 * that are missing from the sync mapping. Safe to run multiple times.
 */
export async function bootstrapSync(basePath: string): Promise<{
  milestones: number;
  slices: number;
  tasks: number;
}> {
  const config = loadGitHubSyncConfig(basePath);
  if (!config?.enabled) return { milestones: 0, slices: 0, tasks: 0 };
  if (!ghIsAvailable()) return { milestones: 0, slices: 0, tasks: 0 };

  const repo = config.repo ?? resolveRepo(basePath);
  if (!repo) return { milestones: 0, slices: 0, tasks: 0 };

  let mapping = loadSyncMapping(basePath) ?? createEmptyMapping(repo);
  mapping.repo = repo;

  const taskCountBefore = Object.keys(mapping.tasks).length;
  const counts = { milestones: 0, slices: 0, tasks: 0 };
  const milestonesDir = join(basePath, ".gsd", "milestones");
  if (!existsSync(milestonesDir)) return counts;

  const milestoneIds = readdirSync(milestonesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const mid of milestoneIds) {
    if (!getMilestoneRecord(mapping, mid)) {
      await syncMilestonePlan(basePath, mapping, config, mid);
      counts.milestones++;
    }

    // Find slices
    const slicesDir = join(milestonesDir, mid, "slices");
    if (!existsSync(slicesDir)) continue;

    const sliceIds = readdirSync(slicesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();

    for (const sid of sliceIds) {
      if (!getSliceRecord(mapping, mid, sid)) {
        await syncSlicePlan(basePath, mapping, config, mid, sid);
        counts.slices++;
      }
    }
  }

  counts.tasks = Object.keys(mapping.tasks).length - taskCountBefore;
  saveSyncMapping(basePath, mapping);
  return counts;
}

// ─── Config Loading ─────────────────────────────────────────────────────────

let _cachedConfig: GitHubSyncConfig | null | undefined;

function loadGitHubSyncConfig(_basePath: string): GitHubSyncConfig | null {
  if (_cachedConfig !== undefined) return _cachedConfig;
  try {
    const prefs = loadEffectiveGSDPreferences();
    const github = (prefs?.preferences as Record<string, unknown>)?.github;
    if (!github || typeof github !== "object") {
      _cachedConfig = null;
      return null;
    }
    _cachedConfig = github as GitHubSyncConfig;
    return _cachedConfig;
  } catch {
    _cachedConfig = null;
    return null;
  }
}

/** Reset config cache (for testing). */
export function _resetConfigCache(): void {
  _cachedConfig = undefined;
}

function resolveRepo(basePath: string): string | null {
  const result = ghDetectRepo(basePath);
  return result.ok ? result.data! : null;
}

// ─── Commit Linking ─────────────────────────────────────────────────────────

/**
 * Look up the GitHub issue number for a task so the commit message
 * can include `Resolves #N`. Called from git-service commit building.
 */
export function getTaskIssueNumberForCommit(
  basePath: string,
  mid: string,
  sid: string,
  tid: string,
): number | null {
  try {
    const config = loadGitHubSyncConfig(basePath);
    if (!config?.enabled) return null;
    if (config.auto_link_commits === false) return null;

    const mapping = loadSyncMapping(basePath);
    if (!mapping) return null;

    const record = getTaskRecord(mapping, mid, sid, tid);
    return record?.issueNumber ?? null;
  } catch {
    return null;
  }
}
