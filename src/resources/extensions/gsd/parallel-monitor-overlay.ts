/**
 * GSD Parallel Monitor Overlay
 *
 * Full-screen TUI overlay showing real-time parallel worker progress.
 * Opened via `/gsd parallel watch`, Ctrl+Alt+P (⌃⌥P on macOS),
 * or Ctrl+Shift+P fallback.
 * Reads the same data sources as `scripts/parallel-monitor.mjs` but
 * renders as a native pi-tui overlay with theme integration.
 */

import { existsSync, statSync, readFileSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import type { Theme } from "@gsd/pi-coding-agent";
import { truncateToWidth, visibleWidth, matchesKey, Key } from "@gsd/pi-tui";

import { formatDuration, STATUS_GLYPH, STATUS_COLOR } from "../shared/mod.js";
import { formattedShortcutPair } from "./shortcut-defs.js";

// ─── Types ────────────────────────────────────────────────────────────────

interface StatusJson {
  milestoneId: string;
  pid: number;
  state: string;
  cost: number;
  lastHeartbeat: number;
  startedAt: number;
  worktreePath: string;
}

interface AutoLock {
  pid: number;
  startedAt: string;
  unitType: string;
  unitId: string;
  unitStartedAt: string;
}

interface SliceProgress {
  id: string;
  status: string;
  total: number;
  done: number;
}

interface WorkerView {
  mid: string;
  pid: number;
  alive: boolean;
  state: string;
  cost: number;
  heartbeatAge: number;
  currentUnit: string | null;
  unitType: string | null;
  unitElapsed: number;
  elapsed: number;
  totalTasks: number;
  doneTasks: number;
  totalSlices: number;
  doneSlices: number;
  slices: SliceProgress[];
  errors: string[];
}

// ─── Data Helpers ─────────────────────────────────────────────────────────

function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tailRead(filePath: string, maxBytes: number): string {
  try {
    const stat = statSync(filePath);
    const readSize = Math.min(stat.size, maxBytes);
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    closeSync(fd);
    return buf.toString("utf-8");
  } catch {
    return "";
  }
}

function discoverWorkers(basePath: string): string[] {
  const parallelDir = join(basePath, ".gsd", "parallel");
  const worktreeDir = join(basePath, ".gsd", "worktrees");
  const mids = new Set<string>();

  if (existsSync(parallelDir)) {
    try {
      for (const f of readdirSync(parallelDir)) {
        if (f.endsWith(".status.json")) mids.add(f.replace(".status.json", ""));
        const m = f.match(/^(M\d+)\.(stderr|stdout)\.log$/);
        if (m) mids.add(m[1]);
      }
    } catch { /* skip */ }
  }

  if (existsSync(worktreeDir)) {
    try {
      for (const d of readdirSync(worktreeDir)) {
        if (d.startsWith("M") && existsSync(join(worktreeDir, d, ".gsd", "auto.lock"))) {
          mids.add(d);
        }
      }
    } catch { /* skip */ }
  }

  return [...mids].sort();
}

function querySliceProgress(basePath: string, mid: string): SliceProgress[] {
  const dbPath = join(basePath, ".gsd", "worktrees", mid, ".gsd", "gsd.db");
  if (!existsSync(dbPath)) return [];

  try {
    const sql = `SELECT s.id, s.status, COUNT(t.id), SUM(CASE WHEN t.status='complete' THEN 1 ELSE 0 END) FROM slices s LEFT JOIN tasks t ON s.milestone_id=t.milestone_id AND s.id=t.slice_id WHERE s.milestone_id='${mid}' GROUP BY s.id ORDER BY s.id`;
    const result = spawnSync("sqlite3", [dbPath, sql], { timeout: 3000, encoding: "utf-8" });
    const out = (result.stdout || "").trim();
    if (!out || result.status !== 0) return [];
    return out.split("\n").map((line) => {
      const [id, status, total, done] = line.split("|");
      return { id, status, total: parseInt(total, 10), done: parseInt(done || "0", 10) };
    });
  } catch {
    return [];
  }
}

function extractCostFromNdjson(basePath: string, mid: string): number {
  const stdoutPath = join(basePath, ".gsd", "parallel", `${mid}.stdout.log`);
  if (!existsSync(stdoutPath)) return 0;
  try {
    const content = readFileSync(stdoutPath, "utf-8");
    let total = 0;
    for (const line of content.split("\n")) {
      if (!line.includes("message_end")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "message_end") {
          const cost = obj.message?.usage?.cost?.total;
          if (typeof cost === "number") total += cost;
        }
      } catch { /* skip */ }
    }
    return total;
  } catch {
    return 0;
  }
}

function queryRecentCompletions(basePath: string, mid: string): string[] {
  const dbPath = join(basePath, ".gsd", "worktrees", mid, ".gsd", "gsd.db");
  if (!existsSync(dbPath)) return [];
  try {
    const sql = `SELECT id, slice_id, one_liner FROM tasks WHERE milestone_id='${mid}' AND status='complete' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 5`;
    const result = spawnSync("sqlite3", [dbPath, sql], { timeout: 3000, encoding: "utf-8" });
    const out = (result.stdout || "").trim();
    if (!out || result.status !== 0) return [];
    return out.split("\n").map((line) => {
      const [taskId, sliceId, oneLiner] = line.split("|");
      return `✓ ${mid}/${sliceId}/${taskId}${oneLiner ? ": " + oneLiner : ""}`;
    });
  } catch {
    return [];
  }
}

function collectWorkerData(basePath: string): WorkerView[] {
  const mids = discoverWorkers(basePath);
  const parallelDir = join(basePath, ".gsd", "parallel");
  const workers: WorkerView[] = [];

  for (const mid of mids) {
    const status = readJsonSafe<StatusJson>(join(parallelDir, `${mid}.status.json`));
    const lock = readJsonSafe<AutoLock>(join(basePath, ".gsd", "worktrees", mid, ".gsd", "auto.lock"));
    const slices = querySliceProgress(basePath, mid);

    const pid = lock?.pid || status?.pid || 0;
    const alive = pid ? isPidAlive(pid) : false;

    // Heartbeat: prefer status.json if PID matches, else use file mtime
    let heartbeatAge = Infinity;
    const statusPidMatches = status?.pid === pid && status?.lastHeartbeat;
    if (statusPidMatches) {
      heartbeatAge = Date.now() - status!.lastHeartbeat;
    } else {
      const mtimes: number[] = [];
      const stdoutLog = join(parallelDir, `${mid}.stdout.log`);
      const stderrLog = join(parallelDir, `${mid}.stderr.log`);
      if (existsSync(stdoutLog)) mtimes.push(statSync(stdoutLog).mtimeMs);
      if (existsSync(stderrLog)) mtimes.push(statSync(stderrLog).mtimeMs);
      if (lock?.unitStartedAt) mtimes.push(new Date(lock.unitStartedAt).getTime());
      if (mtimes.length > 0) heartbeatAge = Date.now() - Math.max(...mtimes);
    }

    let cost = status?.cost || 0;
    if (cost === 0) cost = extractCostFromNdjson(basePath, mid);

    const totalTasks = slices.reduce((sum, s) => sum + s.total, 0);
    const doneTasks = slices.reduce((sum, s) => sum + s.done, 0);
    const doneSlices = slices.filter((s) => s.status === "complete").length;

    const elapsed = status?.startedAt
      ? Date.now() - status.startedAt
      : lock?.startedAt
        ? Date.now() - new Date(lock.startedAt).getTime()
        : 0;

    // Errors from stderr (last 4KB, only new content)
    const errors: string[] = [];
    const stderrLog = join(parallelDir, `${mid}.stderr.log`);
    if (existsSync(stderrLog)) {
      const content = tailRead(stderrLog, 4096);
      for (const line of content.trim().split("\n").slice(-5)) {
        if (line.includes("error") || line.includes("Error") || line.includes("exited")) {
          errors.push(line.trim());
        }
      }
    }

    workers.push({
      mid,
      pid,
      alive,
      state: alive ? "running" : (status?.state || "dead"),
      cost,
      heartbeatAge,
      currentUnit: lock?.unitId || null,
      unitType: lock?.unitType || null,
      unitElapsed: lock?.unitStartedAt ? Date.now() - new Date(lock.unitStartedAt).getTime() : 0,
      elapsed,
      totalTasks,
      doneTasks,
      totalSlices: slices.length,
      doneSlices,
      slices,
      errors,
    });
  }

  return workers;
}

// ─── Rendering Helpers ────────────────────────────────────────────────────

function unitTypeLabel(unitType: string | null): string {
  const labels: Record<string, string> = {
    "execute-task": "EXEC",
    "research-slice": "RSRCH",
    "plan-slice": "PLAN",
    "complete-slice": "DONE",
    "complete-task": "DONE",
    "reassess": "ASSESS",
    "validate": "VALID",
    "reassess-roadmap": "ASSESS",
  };
  return labels[unitType || ""] || (unitType || "---").toUpperCase().slice(0, 5);
}

function progressBar(done: number, total: number, width: number): string {
  if (total === 0) return "░".repeat(width);
  const filled = Math.round((done / total) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function healthGlyph(alive: boolean, heartbeatAge: number): string {
  if (!alive) return "○";
  return "●";
}

// ─── Overlay Class ────────────────────────────────────────────────────────

export class ParallelMonitorOverlay {
  private tui: { requestRender: () => void };
  private theme: Theme;
  private onClose: () => void;
  private basePath: string;
  private refreshTimer: ReturnType<typeof setInterval>;
  private workers: WorkerView[] = [];
  private events: string[] = [];
  private cachedLines?: string[];
  private scrollOffset = 0;
  private disposed = false;
  private resizeHandler: (() => void) | null = null;

  constructor(
    tui: { requestRender: () => void },
    theme: Theme,
    onClose: () => void,
    basePath?: string,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.basePath = basePath || process.cwd();

    this.resizeHandler = () => {
      if (this.disposed) return;
      this.invalidate();
      this.tui.requestRender();
    };
    process.stdout.on("resize", this.resizeHandler);

    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 5000);
  }

  private refresh(): void {
    if (this.disposed) return;
    this.workers = collectWorkerData(this.basePath);

    // Collect completion events
    for (const wk of this.workers) {
      const completions = queryRecentCompletions(this.basePath, wk.mid);
      for (const evt of completions) {
        if (!this.events.includes(evt)) this.events.push(evt);
      }
    }
    this.events = this.events.slice(-10);

    this.cachedLines = undefined;
    this.tui.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.refreshTimer);
    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrlAlt("p")) ||
      matchesKey(data, Key.ctrlShift("p")) ||
      data === "q"
    ) {
      this.dispose();
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.scrollOffset++;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
  }

  invalidate(): void {
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines) return this.cachedLines;

    const t = this.theme;
    const lines: string[] = [];
    const w = Math.max(width, 60);

    // Header
    const totalCost = this.workers.reduce((s, wk) => s + wk.cost, 0);
    const aliveCount = this.workers.filter((wk) => wk.alive).length;
    const now = new Date().toLocaleTimeString();

    lines.push(t.bold(t.fg("accent", " GSD Parallel Monitor ")));
    lines.push(
      t.fg("muted", `  ${now}  │  ${aliveCount}/${this.workers.length} alive  │  Total: `) +
      t.bold(`$${totalCost.toFixed(2)}`) +
      t.fg("muted", "  │  5s refresh"),
    );
    lines.push(t.fg("muted", "─".repeat(w)));

    if (this.workers.length === 0) {
      lines.push("");
      lines.push(t.fg("warning", "  No parallel workers found."));
      lines.push(t.fg("muted", "  Run /gsd parallel start to begin."));
    } else {
      for (const wk of this.workers) {
        lines.push("");

        // Health + ID + state
        const healthColor = wk.alive ? "success" : "error";
        const glyph = healthGlyph(wk.alive, wk.heartbeatAge);
        const stateText = wk.alive
          ? t.fg("success", "RUNNING")
          : t.fg("error", t.bold("DEAD"));
        const heartbeatText = wk.heartbeatAge === Infinity
          ? "never"
          : formatDuration(wk.heartbeatAge) + " ago";

        lines.push(
          `  ${t.fg(healthColor, glyph)}  ${t.bold(wk.mid)}  ${stateText}  ` +
          t.fg("muted", `PID ${wk.pid}  │  elapsed ${formatDuration(wk.elapsed)}  │  `) +
          `cost ${t.bold("$" + wk.cost.toFixed(2))}  ` +
          t.fg("muted", "│  heartbeat ") + t.fg(healthColor, heartbeatText),
        );

        // Current unit
        if (wk.currentUnit) {
          const phaseColor =
            wk.unitType === "execute-task" ? "accent"
            : wk.unitType === "research-slice" ? "warning"
            : wk.unitType?.includes("complete") ? "success"
            : "text";
          lines.push(
            `     ${t.fg("muted", "▸")} ${t.fg(phaseColor, unitTypeLabel(wk.unitType))}  ${wk.currentUnit}  ` +
            t.fg("muted", `(${formatDuration(wk.unitElapsed)})`),
          );
        } else if (!wk.alive) {
          lines.push(`     ${t.fg("muted", "▸")} ${t.fg("error", "stopped")}`);
        } else {
          lines.push(`     ${t.fg("muted", "▸ idle / between units")}`);
        }

        // Slice progress chips
        if (wk.slices.length > 0) {
          const chips = wk.slices.map((s) => {
            const pct = s.total > 0 ? s.done / s.total : 0;
            const color = s.status === "complete" ? "success" : pct > 0 ? "warning" : "muted";
            return t.fg(color, `${s.id}:${s.done}/${s.total}`);
          });
          lines.push(`     ${t.fg("muted", "slices")}  ${chips.join("  ")}`);

          // Task progress bar
          const bar = progressBar(wk.doneTasks, wk.totalTasks, 25);
          const pct = wk.totalTasks > 0 ? Math.round((wk.doneTasks / wk.totalTasks) * 100) : 0;
          lines.push(
            `     ${t.fg("muted", "tasks")}   ${t.fg("success", bar)}  ${wk.doneTasks}/${wk.totalTasks} ` +
            t.fg("muted", `(${pct}%)  │  slices done ${wk.doneSlices}/${wk.totalSlices}`),
          );
        }

        // Errors
        for (const err of wk.errors.slice(-2)) {
          const truncated = err.length > w - 10 ? err.slice(0, w - 11) + "…" : err;
          lines.push(`     ${t.fg("error", "⚠ " + truncated)}`);
        }
      }
    }

    // Event feed
    lines.push("");
    lines.push(t.fg("muted", "─".repeat(w)));
    lines.push(`  ${t.bold("Recent Events")}`);

    if (this.events.length === 0) {
      lines.push(t.fg("muted", "  No events yet..."));
    } else {
      for (const evt of this.events.slice(-8)) {
        const mid = evt.match(/^✓ (M\d+)\//)?.[1] || "";
        const truncated = evt.length > w - 10 ? evt.slice(0, w - 11) + "…" : evt;
        lines.push(`  ${t.fg("muted", "│")} ${t.fg("accent", mid)} ${truncated.replace(/^✓ M\d+\//, "")}`);
      }
    }

    // Footer
    lines.push("");
    const allDone = this.workers.length > 0 && this.workers.every((wk) => !wk.alive);
    if (allDone) {
      lines.push(t.bold(t.fg("success", "  ALL WORKERS COMPLETE")));
      for (const wk of this.workers) {
        lines.push(
          `  ${wk.mid}  $${wk.cost.toFixed(2)}  │  ${wk.doneSlices}/${wk.totalSlices} slices  ` +
          `${wk.doneTasks}/${wk.totalTasks} tasks  │  ${formatDuration(wk.elapsed)}`,
        );
      }
      lines.push(`  ${t.bold("Total: $" + this.workers.reduce((s, wk) => s + wk.cost, 0).toFixed(2))}`);
    }
    lines.push(t.fg("muted", `  ESC/q/${formattedShortcutPair("parallel")} close  │  ↑↓ scroll`));

    // Apply scroll — use terminal rows as height estimate
    const termHeight = process.stdout.rows || 40;
    const maxScroll = Math.max(0, lines.length - termHeight);
    this.scrollOffset = Math.min(Math.max(this.scrollOffset, 0), maxScroll);
    const visible = lines.slice(this.scrollOffset, this.scrollOffset + termHeight);
    this.cachedLines = visible;
    return visible;
  }
}
