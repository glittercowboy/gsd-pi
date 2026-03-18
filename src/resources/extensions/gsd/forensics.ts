/**
 * GSD Forensics — Post-mortem investigation of auto-mode failures
 *
 * Programmatically scans activity logs, metrics, crash locks, and doctor
 * diagnostics for anomalies, then hands a structured report to the LLM
 * for interactive investigation.
 *
 * Entry point: handleForensics() called from commands.ts
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { extractTrace, type ExecutionTrace } from "./session-forensics.js";
import { nativeParseJsonlTail } from "./native-parser-bridge.js";
import { MAX_JSONL_BYTES, parseJSONL } from "./jsonl-utils.js";
import {
  loadLedgerFromDisk, getAverageCostPerUnitType, getProjectTotals,
  formatCost, formatTokenCount, type UnitMetrics, type MetricsLedger,
} from "./metrics.js";
import { readCrashLock, isLockProcessAlive, formatCrashInfo, type LockData } from "./crash-recovery.js";
import { runGSDDoctor, formatDoctorIssuesForPrompt, type DoctorIssue } from "./doctor.js";
import { verifyExpectedArtifact } from "./auto-recovery.js";
import { deriveState } from "./state.js";
import { isAutoActive } from "./auto.js";
import { loadPrompt } from "./prompt-loader.js";
import { gsdRoot } from "./paths.js";
import { formatDuration } from "../shared/mod.js";
import { getAutoWorktreePath } from "./auto-worktree.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ForensicAnomaly {
  type: "stuck-loop" | "cost-spike" | "timeout" | "missing-artifact" | "crash" | "doctor-issue" | "error-trace";
  severity: "info" | "warning" | "error";
  unitType?: string;
  unitId?: string;
  summary: string;
  details: string;
}

interface UnitTrace {
  file: string;
  unitType: string;
  unitId: string;
  seq: number;
  trace: ExecutionTrace;
  mtime: number;
}

interface ForensicReport {
  gsdVersion: string;
  timestamp: string;
  basePath: string;
  activeMilestone: string | null;
  activeSlice: string | null;
  activeWorktree: string | null;
  unitTraces: UnitTrace[];
  metrics: MetricsLedger | null;
  completedKeys: string[];
  crashLock: LockData | null;
  doctorIssues: DoctorIssue[];
  anomalies: ForensicAnomaly[];
  recentUnits: { type: string; id: string; cost: number; duration: number; model: string; finishedAt: number }[];
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

export async function handleForensics(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (isAutoActive()) {
    ctx.ui.notify("Cannot run forensics while auto-mode is active. Stop auto-mode first.", "error");
    return;
  }

  const basePath = process.cwd();
  const root = gsdRoot(basePath);
  if (!existsSync(root)) {
    ctx.ui.notify("No GSD state found. Run /gsd auto first.", "warning");
    return;
  }

  let problemDescription = args.trim();
  if (!problemDescription) {
    problemDescription = await ctx.ui.input(
      "Describe what went wrong:",
      "e.g. auto-mode got stuck on task T03",
    ) ?? "";
  }
  if (!problemDescription?.trim()) {
    ctx.ui.notify("Problem description required for forensic analysis.", "warning");
    return;
  }

  ctx.ui.notify("Building forensic report...", "info");

  const report = await buildForensicReport(basePath);
  const savedPath = saveForensicReport(basePath, report, problemDescription);

  // Derive GSD source dir for prompt
  const __extensionDir = dirname(fileURLToPath(import.meta.url));
  const gsdSourceDir = __extensionDir;

  const forensicData = formatReportForPrompt(report);
  const content = loadPrompt("forensics", {
    problemDescription,
    forensicData,
    gsdSourceDir,
  });

  ctx.ui.notify(`Forensic report saved: ${relative(basePath, savedPath)}`, "info");

  pi.sendMessage(
    { customType: "gsd-forensics", content, display: false },
    { triggerTurn: true },
  );
}

// ─── Report Builder ───────────────────────────────────────────────────────────

async function buildForensicReport(basePath: string): Promise<ForensicReport> {
  const anomalies: ForensicAnomaly[] = [];

  // 1. Derive current state
  let activeMilestone: string | null = null;
  let activeSlice: string | null = null;
  try {
    const state = await deriveState(basePath);
    activeMilestone = state.activeMilestone?.id ?? null;
    activeSlice = state.activeSlice?.id ?? null;
  } catch { /* state derivation failure is non-fatal */ }

  // 1b. Check for active auto-worktree
  const activeWorktree = activeMilestone ? getAutoWorktreePath(basePath, activeMilestone) : null;

  // 2. Scan activity logs (last 5) — worktree-aware
  const unitTraces = scanActivityLogs(basePath, activeMilestone);

  // 3. Load metrics
  const metrics = loadLedgerFromDisk(basePath);

  // 4. Load completed keys
  const completedKeys = loadCompletedKeys(basePath);

  // 5. Check crash lock
  const crashLock = readCrashLock(basePath);

  // 6. Run doctor
  let doctorIssues: DoctorIssue[] = [];
  try {
    const report = await runGSDDoctor(basePath, { scope: undefined });
    doctorIssues = report.issues;
  } catch { /* doctor failure is non-fatal */ }

  // 7. Build recent units from metrics
  const recentUnits: ForensicReport["recentUnits"] = [];
  if (metrics?.units) {
    const sorted = [...metrics.units].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 10);
    for (const u of sorted) {
      recentUnits.push({
        type: u.type,
        id: u.id,
        cost: u.cost,
        duration: u.finishedAt - u.startedAt,
        model: u.model,
        finishedAt: u.finishedAt,
      });
    }
  }

  // 8. GSD version — use GSD_VERSION env var set by the loader at startup.
  // Extensions run from ~/.gsd/agent/extensions/gsd/ at runtime, so path-traversal
  // from import.meta.url would resolve to ~/package.json (wrong on every system).
  const gsdVersion = process.env.GSD_VERSION || "unknown";

  // 9. Run anomaly detectors
  if (metrics?.units) detectStuckLoops(metrics.units, anomalies);
  if (metrics?.units) detectCostSpikes(metrics.units, anomalies);
  detectTimeouts(unitTraces, anomalies);
  detectMissingArtifacts(completedKeys, basePath, activeMilestone, anomalies);
  detectCrash(crashLock, anomalies);
  detectDoctorIssues(doctorIssues, anomalies);
  detectErrorTraces(unitTraces, anomalies);

  return {
    gsdVersion,
    timestamp: new Date().toISOString(),
    basePath,
    activeMilestone,
    activeSlice,
    activeWorktree: activeWorktree ? relative(basePath, activeWorktree) : null,
    unitTraces,
    metrics,
    completedKeys,
    crashLock,
    doctorIssues,
    anomalies,
    recentUnits,
  };
}

// ─── Activity Log Scanner ─────────────────────────────────────────────────────

const ACTIVITY_FILENAME_RE = /^(\d+)-(.+?)-(.+)\.jsonl$/;

function scanActivityLogs(basePath: string, activeMilestone?: string | null): UnitTrace[] {
  const activityDirs = resolveActivityDirs(basePath, activeMilestone);
  const allTraces: UnitTrace[] = [];

  for (const activityDir of activityDirs) {
    if (!existsSync(activityDir)) continue;

    const files = readdirSync(activityDir).filter(f => f.endsWith(".jsonl")).sort();
    const lastFiles = files.slice(-5);

    for (const file of lastFiles) {
      const match = ACTIVITY_FILENAME_RE.exec(file);
      if (!match) continue;

      const seq = parseInt(match[1]!, 10);
      const unitType = match[2]!;
      const unitId = match[3]!;
      const filePath = join(activityDir, file);

      let entries: unknown[] = [];
      const nativeResult = nativeParseJsonlTail(filePath, MAX_JSONL_BYTES);
      if (nativeResult) {
        entries = nativeResult.entries;
      } else {
        try {
          const raw = readFileSync(filePath, "utf-8");
          entries = parseJSONL(raw);
        } catch { continue; }
      }

      const trace = extractTrace(entries);
      const stat = statSync(filePath, { throwIfNoEntry: false });

      allTraces.push({
        file: activityDirs.length > 1 ? `[${relative(basePath, activityDir)}] ${file}` : file,
        unitType,
        unitId,
        seq,
        trace,
        mtime: stat?.mtimeMs ?? 0,
      });
    }
  }

  // Sort by mtime descending so the most recent traces (regardless of source) come first
  return allTraces.sort((a, b) => b.mtime - a.mtime).slice(0, 5);
}

/**
 * Resolve activity directories to scan for forensics.
 * If an active auto-worktree exists for the milestone, its activity dir
 * is included first (preferred) so stale root logs don't mask worktree progress.
 */
function resolveActivityDirs(basePath: string, activeMilestone?: string | null): string[] {
  const dirs: string[] = [];

  // Check for active auto-worktree activity logs
  if (activeMilestone) {
    const wtPath = getAutoWorktreePath(basePath, activeMilestone);
    if (wtPath) {
      const wtActivityDir = join(wtPath, ".gsd", "activity");
      if (existsSync(wtActivityDir)) {
        dirs.push(wtActivityDir);
      }
    }
  }

  // Always include root activity logs
  const rootActivityDir = join(gsdRoot(basePath), "activity");
  dirs.push(rootActivityDir);

  return dirs;
}

// ─── Completed Keys Loader ────────────────────────────────────────────────────

function loadCompletedKeys(basePath: string): string[] {
  const file = join(basePath, ".gsd", "completed-units.json");
  try {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch { /* non-fatal */ }
  return [];
}

// ─── Anomaly Detectors ───────────────────────────────────────────────────────

function detectStuckLoops(units: UnitMetrics[], anomalies: ForensicAnomaly[]): void {
  const counts = new Map<string, number>();
  for (const u of units) {
    const key = `${u.type}/${u.id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count > 1) {
      const [unitType, ...idParts] = key.split("/");
      anomalies.push({
        type: "stuck-loop",
        severity: count >= 3 ? "error" : "warning",
        unitType,
        unitId: idParts.join("/"),
        summary: `Unit ${key} was dispatched ${count} times`,
        details: `Repeated dispatch suggests the unit completed but its artifacts weren't verified, or the state machine kept returning it.`,
      });
    }
  }
}

function detectCostSpikes(units: UnitMetrics[], anomalies: ForensicAnomaly[]): void {
  const avgMap = getAverageCostPerUnitType(units);
  for (const u of units) {
    const avg = avgMap.get(u.type);
    if (avg && avg > 0 && u.cost > avg * 3) {
      anomalies.push({
        type: "cost-spike",
        severity: "warning",
        unitType: u.type,
        unitId: u.id,
        summary: `${formatCost(u.cost)} vs ${formatCost(avg)} average for ${u.type}`,
        details: `Unit ${u.type}/${u.id} cost ${(u.cost / avg).toFixed(1)}x the average. May indicate excessive retries or large context.`,
      });
    }
  }
}

function detectTimeouts(traces: UnitTrace[], anomalies: ForensicAnomaly[]): void {
  for (const ut of traces) {
    // Check for timeout-recovery custom messages in tool calls
    const hasTimeout = ut.trace.toolCalls.some(tc =>
      tc.name === "sendmessage" &&
      JSON.stringify(tc.input).includes("gsd-auto-timeout-recovery"),
    );
    // Check for timeout keywords in last reasoning
    const reasoningTimeout = ut.trace.lastReasoning &&
      /(?:idle.?timeout|hard.?timeout|timeout.?recovery)/i.test(ut.trace.lastReasoning);

    if (hasTimeout || reasoningTimeout) {
      anomalies.push({
        type: "timeout",
        severity: "warning",
        unitType: ut.unitType,
        unitId: ut.unitId,
        summary: `Timeout detected in ${ut.unitType}/${ut.unitId}`,
        details: `Activity log ${ut.file} contains timeout recovery patterns. The unit may have stalled.`,
      });
    }
  }
}

function detectMissingArtifacts(completedKeys: string[], basePath: string, activeMilestone: string | null, anomalies: ForensicAnomaly[]): void {
  // Also check the worktree path for artifacts — they may exist there but not at root
  const wtBasePath = activeMilestone ? getAutoWorktreePath(basePath, activeMilestone) : null;

  for (const key of completedKeys) {
    const slashIdx = key.indexOf("/");
    if (slashIdx === -1) continue;
    const unitType = key.slice(0, slashIdx);
    const unitId = key.slice(slashIdx + 1);

    const rootHasArtifact = verifyExpectedArtifact(unitType, unitId, basePath);
    const wtHasArtifact = wtBasePath ? verifyExpectedArtifact(unitType, unitId, wtBasePath) : false;

    if (!rootHasArtifact && !wtHasArtifact) {
      anomalies.push({
        type: "missing-artifact",
        severity: "error",
        unitType,
        unitId,
        summary: `Completed key ${key} but artifact missing or invalid`,
        details: `The unit is recorded as completed but verifyExpectedArtifact() returns false at both project root and worktree. The completion state is stale.`,
      });
    }
  }
}

function detectCrash(crashLock: LockData | null, anomalies: ForensicAnomaly[]): void {
  if (!crashLock) return;
  if (isLockProcessAlive(crashLock)) return; // Process still running, not a crash

  anomalies.push({
    type: "crash",
    severity: "error",
    unitType: crashLock.unitType,
    unitId: crashLock.unitId,
    summary: `Stale crash lock: PID ${crashLock.pid} is dead`,
    details: formatCrashInfo(crashLock),
  });
}

function detectDoctorIssues(issues: DoctorIssue[], anomalies: ForensicAnomaly[]): void {
  for (const issue of issues) {
    if (issue.severity === "error") {
      anomalies.push({
        type: "doctor-issue",
        severity: "error",
        summary: `Doctor: ${issue.message}`,
        details: `Code: ${issue.code}, Scope: ${issue.scope}, Unit: ${issue.unitId}${issue.file ? `, File: ${issue.file}` : ""}`,
      });
    }
  }
}

function detectErrorTraces(traces: UnitTrace[], anomalies: ForensicAnomaly[]): void {
  for (const ut of traces) {
    if (ut.trace.errors.length > 0) {
      anomalies.push({
        type: "error-trace",
        severity: "warning",
        unitType: ut.unitType,
        unitId: ut.unitId,
        summary: `${ut.trace.errors.length} error(s) in ${ut.unitType}/${ut.unitId}`,
        details: ut.trace.errors.slice(0, 3).join("\n"),
      });
    }
  }
}

// ─── Report Persistence ───────────────────────────────────────────────────────

function saveForensicReport(basePath: string, report: ForensicReport, problemDescription: string): string {
  const dir = join(gsdRoot(basePath), "forensics");
  mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  const filePath = join(dir, `report-${ts}.md`);

  const redact = (s: string) => redactForGitHub(s, basePath);

  const sections: string[] = [
    `# GSD Forensic Report`,
    ``,
    `**Generated:** ${report.timestamp}`,
    `**GSD Version:** ${report.gsdVersion}`,
    `**Active Milestone:** ${report.activeMilestone ?? "none"}`,
    `**Active Slice:** ${report.activeSlice ?? "none"}`,
    `**Active Worktree:** ${report.activeWorktree ?? "none"}`,
    ``,
    `## Problem Description`,
    ``,
    problemDescription,
    ``,
  ];

  // Anomalies
  if (report.anomalies.length > 0) {
    sections.push(`## Anomalies Detected (${report.anomalies.length})`, ``);
    for (const a of report.anomalies) {
      sections.push(`### [${a.severity.toUpperCase()}] ${a.type}: ${a.summary}`);
      if (a.unitType) sections.push(`- Unit: ${a.unitType}/${a.unitId ?? ""}`);
      sections.push(`- ${redact(a.details)}`, ``);
    }
  } else {
    sections.push(`## Anomalies`, ``, `No anomalies detected.`, ``);
  }

  // Recent units
  if (report.recentUnits.length > 0) {
    sections.push(`## Recent Units`, ``);
    sections.push(`| Type | ID | Cost | Duration | Model |`);
    sections.push(`|------|-----|------|----------|-------|`);
    for (const u of report.recentUnits) {
      sections.push(`| ${u.type} | ${u.id} | ${formatCost(u.cost)} | ${formatDuration(u.duration)} | ${u.model} |`);
    }
    sections.push(``);
  }

  // Unit traces
  if (report.unitTraces.length > 0) {
    sections.push(`## Activity Log Traces (last ${report.unitTraces.length})`, ``);
    for (const ut of report.unitTraces) {
      sections.push(`### ${ut.unitType}/${ut.unitId} (seq ${ut.seq})`);
      sections.push(`- Tool calls: ${ut.trace.toolCallCount}`);
      sections.push(`- Files written: ${ut.trace.filesWritten.length}`);
      sections.push(`- Errors: ${ut.trace.errors.length}`);
      if (ut.trace.lastReasoning) {
        sections.push(`- Last reasoning: ${redact(ut.trace.lastReasoning.slice(0, 200))}`);
      }
      sections.push(``);
    }
  }

  // Doctor issues
  if (report.doctorIssues.length > 0) {
    sections.push(`## Doctor Issues`, ``);
    sections.push(formatDoctorIssuesForPrompt(report.doctorIssues), ``);
  }

  // Crash lock
  if (report.crashLock) {
    sections.push(`## Crash Lock`, ``);
    sections.push(redact(formatCrashInfo(report.crashLock)), ``);
  }

  writeFileSync(filePath, sections.join("\n"), "utf-8");
  return filePath;
}

// ─── Prompt Formatter ─────────────────────────────────────────────────────────

function formatReportForPrompt(report: ForensicReport): string {
  const MAX_BYTES = 30 * 1024;
  const sections: string[] = [];

  // Anomalies (most important, first)
  sections.push(`### Anomalies (${report.anomalies.length})`);
  if (report.anomalies.length === 0) {
    sections.push("No anomalies detected.");
  } else {
    for (const a of report.anomalies) {
      sections.push(`- **[${a.severity.toUpperCase()}] ${a.type}**: ${a.summary}`);
      if (a.details) sections.push(`  ${a.details.slice(0, 300)}`);
    }
  }
  sections.push("");

  // Recent unit history
  if (report.recentUnits.length > 0) {
    sections.push(`### Recent Units (last ${report.recentUnits.length})`);
    sections.push("| Type | ID | Cost | Duration | Model |");
    sections.push("|------|-----|------|----------|-------|");
    for (const u of report.recentUnits) {
      sections.push(`| ${u.type} | ${u.id} | ${formatCost(u.cost)} | ${formatDuration(u.duration)} | ${u.model} |`);
    }
    sections.push("");
  }

  // Trace summaries (last 3)
  const recentTraces = report.unitTraces.slice(0, 3);
  if (recentTraces.length > 0) {
    sections.push(`### Activity Log Traces (last ${recentTraces.length})`);
    for (const ut of recentTraces) {
      sections.push(`**${ut.unitType}/${ut.unitId}** (seq ${ut.seq})`);
      sections.push(`- Tool calls: ${ut.trace.toolCallCount}, Errors: ${ut.trace.errors.length}`);
      if (ut.trace.filesWritten.length > 0) {
        sections.push(`- Files written: ${ut.trace.filesWritten.slice(0, 5).join(", ")}`);
      }
      if (ut.trace.errors.length > 0) {
        sections.push(`- Errors: ${ut.trace.errors.slice(0, 2).map(e => e.slice(0, 200)).join("; ")}`);
      }
      if (ut.trace.lastReasoning) {
        sections.push(`- Last reasoning: "${ut.trace.lastReasoning.slice(0, 300)}"`);
      }
      sections.push("");
    }
  }

  // Doctor issues (error severity only)
  const errorIssues = report.doctorIssues.filter(i => i.severity === "error");
  if (errorIssues.length > 0) {
    sections.push(`### Doctor Issues (${errorIssues.length} errors)`);
    sections.push(formatDoctorIssuesForPrompt(errorIssues));
    sections.push("");
  }

  // Crash lock
  if (report.crashLock) {
    sections.push("### Crash Lock");
    sections.push(formatCrashInfo(report.crashLock));
    const alive = isLockProcessAlive(report.crashLock);
    sections.push(`Process alive: ${alive}`);
    sections.push("");
  }

  // Metrics summary
  if (report.metrics?.units) {
    const totals = getProjectTotals(report.metrics.units);
    sections.push("### Metrics Summary");
    sections.push(`- Total units: ${totals.units}`);
    sections.push(`- Total cost: ${formatCost(totals.cost)}`);
    sections.push(`- Total tokens: ${formatTokenCount(totals.tokens.total)}`);
    sections.push(`- Total duration: ${formatDuration(totals.duration)}`);
    sections.push("");
  }

  // Completed keys count
  sections.push(`### Completed Keys: ${report.completedKeys.length}`);
  sections.push(`### GSD Version: ${report.gsdVersion}`);
  sections.push(`### Active Milestone: ${report.activeMilestone ?? "none"}`);
  sections.push(`### Active Slice: ${report.activeSlice ?? "none"}`);
  if (report.activeWorktree) {
    sections.push(`### Active Worktree: ${report.activeWorktree}`);
    sections.push(`Note: Activity logs were scanned from both the worktree and the project root. Worktree logs take priority.`);
  }

  let result = sections.join("\n");
  if (result.length > MAX_BYTES) {
    result = result.slice(0, MAX_BYTES) + "\n\n[... truncated at 30KB ...]";
  }
  return result;
}

// ─── Redaction ────────────────────────────────────────────────────────────────

function redactForGitHub(text: string, basePath: string): string {
  let result = text;

  // Replace absolute paths
  result = result.replaceAll(basePath, ".");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home) result = result.replaceAll(home, "~");

  // Strip API key patterns
  result = result.replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-***");
  result = result.replace(/Bearer\s+\S+/g, "Bearer ***");

  // Strip env var assignments
  result = result.replace(/[A-Z_]{2,}=\S+/g, (match) => {
    const eq = match.indexOf("=");
    return match.slice(0, eq + 1) + "***";
  });

  // Truncate long lines
  result = result.split("\n").map(line =>
    line.length > 500 ? line.slice(0, 497) + "..." : line,
  ).join("\n");

  return result;
}
