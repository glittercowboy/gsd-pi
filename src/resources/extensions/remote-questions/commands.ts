/**
 * Telegram Command Handler
 *
 * Handles slash-commands sent by the user via Telegram chat:
 *   /help     — list all commands
 *   /status   — current auto-mode state (milestone, unit, cost)
 *   /progress — roadmap overview (done / open milestones)
 *   /budget   — token and cost usage this session
 *   /pause    — pause auto-mode via a stop capture
 *   /resume   — clear pending stop captures so auto-mode can proceed
 *   /log [n]  — last n activity log entries (default: 5)
 *
 * Only Telegram is supported here. Other channels (Slack, Discord) use
 * webhook models and do not share the same polling loop.
 */

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal contract for sending a reply back to the caller. */
export interface CommandSender {
  send(text: string): Promise<void>;
}

// ─── Command Detection ────────────────────────────────────────────────────────

/**
 * Returns true when the message text is a bot command (starts with `/`
 * followed by at least one word character).
 */
export function isCommand(text: string): boolean {
  return /^\/\w/.test(text);
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Parse and execute a Telegram command.
 *
 * @param text   Raw message text, e.g. "/log 10"
 * @param sender Interface used to reply into the chat
 * @param basePath Project root (process.cwd() in normal operation)
 */
export async function handleCommand(
  text: string,
  sender: CommandSender,
  basePath: string,
): Promise<void> {
  const [rawCmd, ...argParts] = text.trim().split(/\s+/);
  const cmd = (rawCmd ?? "").toLowerCase();
  const args = argParts.join(" ");

  switch (cmd) {
    case "/help":
      await sender.send(withProject(basePath, buildHelp()));
      break;
    case "/status":
      await sender.send(withProject(basePath, await buildStatus(basePath)));
      break;
    case "/progress":
      await sender.send(withProject(basePath, await buildProgress(basePath)));
      break;
    case "/budget":
      await sender.send(withProject(basePath, await buildBudget(basePath)));
      break;
    case "/pause":
      await sender.send(withProject(basePath, await buildPause(basePath)));
      break;
    case "/resume":
      await sender.send(withProject(basePath, await buildResume(basePath)));
      break;
    case "/log":
      await sender.send(withProject(basePath, buildLog(basePath, args)));
      break;
    default:
      await sender.send(withProject(basePath, buildUnknown(cmd)));
  }
}

// ─── Project Prefix Helper ────────────────────────────────────────────────────

function withProject(basePath: string, body: string): string {
  const name = basename(basePath);
  return `📁 ${name}\n\n${body}`;
}

// ─── Command Builders ─────────────────────────────────────────────────────────

function buildHelp(): string {
  return [
    "GSD Remote Commands:",
    "",
    "/status   — current milestone, unit, and cost",
    "/progress — roadmap overview (done / open milestones)",
    "/budget   — token and cost usage this session",
    "/pause    — pause auto-mode after the current unit",
    "/resume   — clear pause directive so auto-mode continues",
    "/log <n>  — last n activity log entries (default: 5)",
    "/help     — show this message",
  ].join("\n");
}

function buildUnknown(cmd: string): string {
  return `Unknown command: ${cmd}\n\nType /help to see available commands.`;
}

// ─── /status ─────────────────────────────────────────────────────────────────

/**
 * Build the /status reply.
 *
 * NOTE: basePath only controls disk-based fallbacks (e.g. reading paused-session.json).
 * In-process module resolution via dynamic import() is fixed at build time by ESM
 * semantics and is unaffected by basePath.
 */
async function buildStatus(basePath: string): Promise<string> {
  let autoData: AutoDashboardSnapshot | null = null;
  try {
    const autoMod = await tryImportModule<AutoMod>("../gsd/auto.js");
    if (autoMod) {
      autoData = autoMod.getAutoDashboardData();
    }
  } catch {
    // auto.ts not loaded or available — fall through to disk-based status
  }

  const lines: string[] = ["GSD Status"];
  lines.push("");

  if (autoData && (autoData.active || autoData.paused)) {
    // In-process auto-mode is active or paused — use live data
    lines.push(autoData.active ? "State: running" : "State: paused");

    if (autoData.currentUnit) {
      lines.push(`Unit:  ${autoData.currentUnit.type} / ${autoData.currentUnit.id}`);
    }
    if (autoData.totalCost > 0) {
      lines.push(`Cost:  $${autoData.totalCost.toFixed(4)}`);
    }
    if (autoData.totalTokens > 0) {
      lines.push(`Tokens: ${formatTokens(autoData.totalTokens)}`);
    }
    if (autoData.pendingCaptureCount > 0) {
      lines.push(`Captures pending: ${autoData.pendingCaptureCount}`);
    }
  } else {
    // No active in-process session — check disk for a cross-process paused session
    const pausedMeta = readPausedSession(basePath);
    if (pausedMeta) {
      lines.push("State: paused (from disk)");
      if (pausedMeta.milestoneId) lines.push(`Milestone: ${pausedMeta.milestoneId}`);
      if (pausedMeta.unitType && pausedMeta.unitId) {
        lines.push(`Unit: ${pausedMeta.unitType} / ${pausedMeta.unitId}`);
      }
      if (pausedMeta.pausedAt) lines.push(`Paused at: ${pausedMeta.pausedAt}`);
    } else {
      lines.push("State: idle (no active session)");
    }
  }

  return lines.join("\n");
}

// ─── /progress ───────────────────────────────────────────────────────────────

/**
 * Build the /progress reply.
 *
 * NOTE: basePath only controls disk-based fallbacks. In-process module resolution
 * via dynamic import() is fixed at build time by ESM semantics and is unaffected
 * by basePath.
 */
async function buildProgress(basePath: string): Promise<string> {
  const milestones = await readMilestonesFromDb();
  if (milestones.length === 0) {
    return "No milestones found in .gsd database.\n\nRun /gsd to start GSD first.";
  }

  const done = milestones.filter(m => m.status === "complete");
  const active = milestones.filter(m => m.status === "active" || m.status === "in_progress");
  const open = milestones.filter(
    m => !done.includes(m) && !active.includes(m) && m.status !== "parked",
  );
  const parked = milestones.filter(m => m.status === "parked");

  const lines: string[] = ["GSD Progress"];
  lines.push(`${done.length}/${milestones.length} milestones complete`);
  lines.push("");

  if (active.length > 0) {
    lines.push("Active:");
    for (const m of active) lines.push(`  ${m.id}: ${m.title}`);
    lines.push("");
  }

  if (open.length > 0) {
    lines.push("Open:");
    for (const m of open) lines.push(`  ${m.id}: ${m.title}`);
    lines.push("");
  }

  if (done.length > 0) {
    lines.push(`Done (${done.length}):`);
    for (const m of done) lines.push(`  ${m.id}: ${m.title}`);
    lines.push("");
  }

  if (parked.length > 0) {
    lines.push(`Parked (${parked.length}):`);
    for (const m of parked) lines.push(`  ${m.id}: ${m.title}`);
  }

  return lines.join("\n").trimEnd();
}

// ─── /budget ─────────────────────────────────────────────────────────────────

async function buildBudget(basePath: string): Promise<string> {
  let totals: ProjectTotalsSnapshot | null = null;
  try {
    const metricsMod = await tryImportModule<MetricsMod>("../gsd/metrics.js");
    if (metricsMod) {
      const ledger = metricsMod.getLedger();
      if (ledger) {
        totals = metricsMod.getProjectTotals(ledger.units);
      }
    }
  } catch {
    // metrics module not available — fall through to disk
  }

  if (!totals) {
    totals = readMetricsFromDisk(basePath);
  }

  if (!totals) {
    return "No metrics data available yet.\n\nMetrics are collected during auto-mode runs.";
  }

  const lines: string[] = ["GSD Budget"];
  lines.push("");
  lines.push(`Cost:    $${totals.cost.toFixed(4)}`);
  lines.push(`Tokens:  ${formatTokens(totals.tokens.total)}`);
  lines.push(`  Input:      ${formatTokens(totals.tokens.input)}`);
  lines.push(`  Output:     ${formatTokens(totals.tokens.output)}`);
  if (totals.tokens.cacheRead > 0) {
    lines.push(`  Cache read: ${formatTokens(totals.tokens.cacheRead)}`);
  }
  lines.push(`Units:   ${totals.units}`);

  return lines.join("\n");
}

// ─── /pause ──────────────────────────────────────────────────────────────────

async function buildPause(basePath: string): Promise<string> {
  try {
    const capturesMod = await import("../gsd/captures.js");
    const id = capturesMod.appendCapture(basePath, "Remote pause via Telegram /pause command");
    capturesMod.markCaptureResolved(
      basePath,
      id,
      "stop",
      "Pause requested via Telegram",
      "User sent /pause command via Telegram remote channel",
    );
    return "Pause directive written. Auto-mode will stop after the current unit completes.";
  } catch (err) {
    return `Failed to write pause directive: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── /resume ─────────────────────────────────────────────────────────────────

async function buildResume(basePath: string): Promise<string> {
  try {
    const capturesMod = await import("../gsd/captures.js");
    const stopCaptures = capturesMod.loadStopCaptures(basePath);
    if (stopCaptures.length === 0) {
      return "No pending pause directives found. Auto-mode is not paused (or paused for another reason).";
    }
    for (const cap of stopCaptures) {
      capturesMod.markCaptureExecuted(basePath, cap.id);
    }
    return `Cleared ${stopCaptures.length} pause directive(s). Auto-mode will continue on next iteration.`;
  } catch (err) {
    return `Failed to clear pause directives: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── /log ─────────────────────────────────────────────────────────────────────

function buildLog(basePath: string, args: string): string {
  const n = args.trim() ? parseInt(args.trim(), 10) : 5;
  const count = Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 5;

  const activityDir = resolveActivityDir(basePath);
  if (!existsSync(activityDir)) {
    return "No activity logs found.\n\nActivity logs are created during auto-mode runs.";
  }

  let files: string[] = [];
  try {
    files = readdirSync(activityDir)
      .filter(f => f.endsWith(".jsonl"))
      .sort();
  } catch {
    return "Could not read activity log directory.";
  }

  if (files.length === 0) {
    return "No activity logs found.\n\nActivity logs are created during auto-mode runs.";
  }

  // Take the last `count` files (most recent)
  const recent = files.slice(-count);
  const lines: string[] = [`Last ${recent.length} activity log entries:`];
  lines.push("");

  for (const file of recent) {
    const match = file.match(/^(\d+)-([\w-]+?)-(M\d[\w-]*)\.jsonl$/);
    if (!match) continue;
    const [, seq, unitType, unitId] = match;
    const safePath = join(activityDir, file);
    let size = "?";
    try {
      const st = statSync(safePath);
      size = formatSize(st.size);
    } catch { /* non-fatal */ }

    lines.push(`#${seq} ${unitType} / ${unitId.replace(/-/g, "/")}  (${size})`);
  }

  return lines.join("\n");
}

// ─── Helpers: lazy dynamic imports ────────────────────────────────────────────

// Dynamic import() is used for optional runtime modules (auto, metrics, gsd-db)
// that have side effects and may not be present in every execution context.
// The ESM module hook (dist-redirect.mjs) rewrites .js → .ts for test runs.

/**
 * Attempt a dynamic import, returning null if the module cannot be loaded.
 * Used for optional modules like auto.js and metrics.js that may not be
 * available outside a full GSD process context.
 */
async function tryImportModule<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

interface AutoDashboardSnapshot {
  active: boolean;
  paused: boolean;
  currentUnit: { type: string; id: string } | null;
  totalCost: number;
  totalTokens: number;
  pendingCaptureCount: number;
}

interface TokenCountsSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface ProjectTotalsSnapshot {
  units: number;
  tokens: TokenCountsSnapshot;
  cost: number;
}

interface MetricsMod {
  getLedger(): { units: unknown[] } | null;
  getProjectTotals(units: unknown[]): ProjectTotalsSnapshot;
}

interface AutoMod {
  getAutoDashboardData(): AutoDashboardSnapshot;
}

interface MilestoneSnapshot {
  id: string;
  title: string;
  status: string;
}

async function readMilestonesFromDb(): Promise<MilestoneSnapshot[]> {
  try {
    const dbMod = await tryImportModule<{ getAllMilestones(): MilestoneSnapshot[] }>(
      "../gsd/gsd-db.js",
    );
    return dbMod?.getAllMilestones() ?? [];
  } catch {
    return [];
  }
}

// ─── Helpers: disk reads ──────────────────────────────────────────────────────

interface PausedSessionMeta {
  milestoneId?: string;
  unitType?: string;
  unitId?: string;
  pausedAt?: string;
}

function gsdRootPath(basePath: string): string {
  // Inline resolution: .gsd lives directly under basePath.
  // Avoids importing paths.ts to keep this module's dependency surface small.
  return join(basePath, ".gsd");
}

function readPausedSession(basePath: string): PausedSessionMeta | null {
  try {
    const p = join(gsdRootPath(basePath), "runtime", "paused-session.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as PausedSessionMeta;
  } catch {
    return null;
  }
}

function readMetricsFromDisk(basePath: string): ProjectTotalsSnapshot | null {
  try {
    const p = join(gsdRootPath(basePath), "metrics.json");
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as {
      units?: Array<{ cost?: number; tokens?: TokenCountsSnapshot }>;
    };
    if (!Array.isArray(raw.units)) return null;
    let cost = 0;
    const tokens: TokenCountsSnapshot = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    };
    for (const u of raw.units) {
      cost += u.cost ?? 0;
      if (u.tokens) {
        tokens.input += u.tokens.input ?? 0;
        tokens.output += u.tokens.output ?? 0;
        tokens.cacheRead += u.tokens.cacheRead ?? 0;
        tokens.cacheWrite += u.tokens.cacheWrite ?? 0;
        tokens.total += u.tokens.total ?? 0;
      }
    }
    return { units: raw.units.length, cost, tokens };
  } catch {
    return null;
  }
}

function resolveActivityDir(basePath: string): string {
  return join(gsdRootPath(basePath), "activity");
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
