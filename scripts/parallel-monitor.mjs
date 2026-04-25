#!/usr/bin/env node
/**
 * GSD Parallel Worker Monitor
 * 
 * Real-time TUI dashboard for monitoring parallel GSD auto-mode workers.
 * Zero dependencies — uses raw ANSI escape codes, Node.js builtins only.
 * 
 * Usage:
 *   node scripts/parallel-monitor.mjs                    # live dashboard, 5s refresh
 *   node scripts/parallel-monitor.mjs --interval 3       # faster refresh
 *   node scripts/parallel-monitor.mjs --once              # single snapshot, then exit
 *   node scripts/parallel-monitor.mjs --heal              # auto-respawn dead workers
 *   node scripts/parallel-monitor.mjs --heal --heal-retries 5 --heal-cooldown 60
 * 
 * Options:
 *   --interval <sec>      Refresh interval in seconds (default: 5)
 *   --once                Render once and exit (useful for scripting/piping)
 *   --heal                Auto-respawn dead workers (opt-in, off by default)
 *   --heal-retries <n>    Max respawn attempts per worker (default: 3)
 *   --heal-cooldown <sec> Seconds between respawn attempts (default: 30)
 *   --dir <path>          Status file directory (default: .gsd/parallel)
 *   --root <path>         Project root (default: cwd)
 * 
 * Data sources:
 *   .gsd/parallel/M0xx.status.json  — heartbeat, cost, state (written by orchestrator)
 *   .gsd/worktrees/M0xx/.gsd/auto.lock — current unit type + ID (written by worker)
 *   .gsd/worktrees/M0xx/.gsd/gsd.db — task/slice completion (SQLite, queried via cli)
 *   .gsd/parallel/M0xx.stdout.log — NDJSON events (cost extraction, notify messages)
 *   .gsd/parallel/M0xx.stderr.log — error surfacing
 * 
 * Health indicators:
 *   ● green  — PID alive, fresh heartbeat (<30s)
 *   ● green  — PID alive, heartbeat stale (respawned worker, file mtime used as proxy)
 *   ○ red    — PID dead
 * 
 * Self-healing (--heal):
 *   When a dead worker is detected, the monitor writes a temp shell script and launches
 *   a new headless auto-mode process in the worker's worktree with the correct env vars.
 *   Cooldown prevents rapid respawn loops. Gives up after --heal-retries consecutive 
 *   failures. Resets retry count when a worker comes back alive.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn, spawnSync } from 'node:child_process';

// ─── Configuration ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const INTERVAL_SEC = parseInt(getArg('--interval', '5'), 10);
const PARALLEL_DIR = getArg('--dir', '.gsd/parallel');
const PROJECT_ROOT = getArg('--root', process.cwd());
const ONE_SHOT = args.includes('--once');
const HEAL_MODE = args.includes('--heal');
const HEAL_MAX_RETRIES = parseInt(getArg('--heal-retries', '3'), 10);
const HEAL_COOLDOWN_SEC = parseInt(getArg('--heal-cooldown', '30'), 10);

// Per-worker heal state: { lastAttempt: number, retries: number }
const healState = {};

function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

// ─── ANSI Helpers ────────────────────────────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;

const FG = {
  black: `${ESC}30m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,
};

const BG = {
  black: `${ESC}40m`,
  red: `${ESC}41m`,
  green: `${ESC}42m`,
  yellow: `${ESC}43m`,
  blue: `${ESC}44m`,
  white: `${ESC}47m`,
};

// Screen control
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const SAVE_POS = `${ESC}s`;
const RESTORE_POS = `${ESC}u`;

function moveTo(row, col) { return `${ESC}${row};${col}H`; }

// ─── Data Reading ────────────────────────────────────────────────────────────

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function discoverWorkers() {
  const dir = path.resolve(PROJECT_ROOT, PARALLEL_DIR);
  const worktreeDir = path.resolve(PROJECT_ROOT, '.gsd/worktrees');
  const mids = new Set();
  
  // From status files
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.status.json')) mids.add(f.replace('.status.json', ''));
    }
  }
  
  // From stderr/stdout logs (manually respawned workers may lack status.json)
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(M\d+)\.(stderr|stdout)\.log$/);
      if (m) mids.add(m[1]);
    }
  }
  
  // From worktree directories that have auto.lock (actively running)
  if (fs.existsSync(worktreeDir)) {
    for (const d of fs.readdirSync(worktreeDir)) {
      if (d.startsWith('M') && fs.existsSync(path.join(worktreeDir, d, '.gsd', 'auto.lock'))) {
        mids.add(d);
      }
    }
  }
  
  return [...mids].sort();
}

function readWorkerStatus(mid) {
  const statusPath = path.resolve(PROJECT_ROOT, PARALLEL_DIR, `${mid}.status.json`);
  return readJsonSafe(statusPath);
}

function readAutoLock(mid) {
  const lockPath = path.resolve(PROJECT_ROOT, `.gsd/worktrees/${mid}/.gsd/auto.lock`);
  return readJsonSafe(lockPath);
}

function querySliceProgress(mid) {
  const dbPath = path.resolve(PROJECT_ROOT, `.gsd/worktrees/${mid}/.gsd/gsd.db`);
  if (!fs.existsSync(dbPath)) return [];
  
  try {
    const sql = `SELECT s.id, s.status, COUNT(t.id), SUM(CASE WHEN t.status='complete' THEN 1 ELSE 0 END) FROM slices s LEFT JOIN tasks t ON s.milestone_id=t.milestone_id AND s.id=t.slice_id WHERE s.milestone_id='${mid}' GROUP BY s.id ORDER BY s.id`;
    const out = execSync(`sqlite3 "${dbPath}" "${sql}"`, { timeout: 3000, encoding: 'utf-8' }).trim();
    if (!out) return [];
    return out.split('\n').map(line => {
      const [id, status, total, done] = line.split('|');
      return { id, status, total: parseInt(total, 10), done: parseInt(done || '0', 10) };
    });
  } catch {
    return [];
  }
}

function readRecentEvents(mid, maxLines = 5) {
  const stdoutPath = path.resolve(PROJECT_ROOT, PARALLEL_DIR, `${mid}.stdout.log`);
  const notifications = [];
  const errors = [];
  
  // Parse NDJSON notify events from stdout log
  if (fs.existsSync(stdoutPath)) {
    try {
      const stat = fs.statSync(stdoutPath);
      const readSize = Math.min(stat.size, 32768);
      const fd = fs.openSync(stdoutPath, 'r');
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);
      const content = buf.toString('utf-8');
      const lines = content.trim().split('\n').slice(-100);
      
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.method === 'notify' && obj.message) {
            notifications.push({ ts: Date.now(), msg: obj.message, mid });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  
  // Parse errors from stderr log — only new bytes since monitor started
  const stderrPath = path.resolve(PROJECT_ROOT, PARALLEL_DIR, `${mid}.stderr.log`);
  if (fs.existsSync(stderrPath)) {
    try {
      const stat = fs.statSync(stderrPath);
      
      // Record baseline on first read — skip pre-existing errors
      if (!(mid in stderrBaselines)) {
        stderrBaselines[mid] = stat.size;
      }
      
      const baseline = stderrBaselines[mid];
      const newBytes = stat.size - baseline;
      
      if (newBytes > 0) {
        const readSize = Math.min(newBytes, 4096);
        const fd = fs.openSync(stderrPath, 'r');
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, Math.max(baseline, stat.size - readSize));
        fs.closeSync(fd);
        const content = buf.toString('utf-8');
        const lines = content.trim().split('\n').slice(-10);
        
        for (const line of lines) {
          if (line.includes('error') || line.includes('Error') || line.includes('WARN') || line.includes('exited')) {
            errors.push({ ts: Date.now(), msg: line.trim(), mid, isError: true });
          }
        }
      }
    } catch { /* skip */ }
  }
  
  return {
    notifications: notifications.slice(-maxLines),
    errors: errors.slice(-3),
  };
}

/**
 * Extract accumulated cost from NDJSON stdout log (fallback when status.json is missing).
 * Sums `message.usage.cost.total` from all `message_end` events.
 */
function extractCostFromNdjson(mid) {
  const stdoutPath = path.resolve(PROJECT_ROOT, PARALLEL_DIR, `${mid}.stdout.log`);
  if (!fs.existsSync(stdoutPath)) return 0;
  
  try {
    const content = fs.readFileSync(stdoutPath, 'utf-8');
    let total = 0;
    for (const line of content.split('\n')) {
      if (!line.includes('message_end')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'message_end') {
          const cost = obj.message?.usage?.cost?.total;
          if (typeof cost === 'number') total += cost;
        }
      } catch { /* skip */ }
    }
    return total;
  } catch {
    return 0;
  }
}

// ─── Self-Healing ────────────────────────────────────────────────────────────

// Auto-detect the GSD loader path — works across npm global, homebrew, and local installs
function findGsdLoader() {
  // 1. Check if we're running from inside the gsd-2 repo itself
  const repoLoader = path.resolve(import.meta.dirname, '..', 'dist', 'loader.js');
  if (fs.existsSync(repoLoader)) return repoLoader;
  
  // 2. Check common global install locations
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 3000 }).trim();
    const candidates = [
      path.join(globalRoot, 'gsd-pi', 'dist', 'loader.js'),
      path.join(globalRoot, '@gsd', 'pi', 'dist', 'loader.js'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  } catch { /* skip */ }
  
  // 3. Try `which gsd` and resolve symlink
  try {
    const pathLookup = process.platform === 'win32' ? 'where.exe' : 'which';
    const lookupArgs = ['gsd'];
    const result = spawnSync(pathLookup, lookupArgs, { encoding: 'utf-8', timeout: 3000 });
    const bin = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0]?.trim() : '';
    if (bin) {
      const realBin = fs.realpathSync(bin);
      const loader = path.resolve(path.dirname(realBin), '..', 'dist', 'loader.js');
      if (fs.existsSync(loader)) return loader;
    }
  } catch { /* skip */ }
  
  return null;
}

const GSD_LOADER = findGsdLoader();

/**
 * Respawn a dead worker. Returns the new PID or null on failure.
 * Uses a detached Node child with log file descriptors so the child is fully detached.
 */
function respawnWorker(mid) {
  const worktreeDir = path.resolve(PROJECT_ROOT, `.gsd/worktrees/${mid}`);
  if (!fs.existsSync(worktreeDir)) return null;
  if (!fs.existsSync(GSD_LOADER)) return null;
  
  const stdoutLog = path.resolve(PROJECT_ROOT, PARALLEL_DIR, `${mid}.stdout.log`);
  const stderrLog = path.resolve(PROJECT_ROOT, PARALLEL_DIR, `${mid}.stderr.log`);
  
  let stdoutFd;
  let stderrFd;
  try {
    fs.mkdirSync(path.dirname(stdoutLog), { recursive: true });
    stdoutFd = fs.openSync(stdoutLog, 'a');
    stderrFd = fs.openSync(stderrLog, 'a');

    const child = spawn(process.execPath, [GSD_LOADER, 'headless', '--json', 'auto'], {
      cwd: worktreeDir,
      detached: true,
      env: {
        ...process.env,
        GSD_MILESTONE_LOCK: mid,
        GSD_PROJECT_ROOT: PROJECT_ROOT,
        GSD_PARALLEL_WORKER: '1',
      },
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
    });

    child.unref();
    return child.pid ?? null;
  } catch (err) {
    return null;
  } finally {
    if (stdoutFd !== undefined) {
      try { fs.closeSync(stdoutFd); } catch {}
    }
    if (stderrFd !== undefined) {
      try { fs.closeSync(stderrFd); } catch {}
    }
  }
}

/**
 * Check all workers and respawn dead ones if --heal is active.
 * Returns an array of heal events for the event feed.
 */
function healWorkers(workers) {
  if (!HEAL_MODE) return [];
  
  const events = [];
  const now = Date.now();
  
  for (const wk of workers) {
    if (wk.alive) {
      // Worker is alive — reset its heal state on success
      if (healState[wk.mid]) {
        healState[wk.mid].retries = 0;
      }
      continue;
    }
    
    // Worker is dead — check if we should attempt a respawn
    if (!healState[wk.mid]) {
      healState[wk.mid] = { lastAttempt: 0, retries: 0 };
    }
    
    const hs = healState[wk.mid];
    
    // Give up after max retries
    if (hs.retries >= HEAL_MAX_RETRIES) {
      if (hs.retries === HEAL_MAX_RETRIES) {
        events.push({ 
          ts: now, mid: wk.mid, 
          msg: `⛔ ${wk.mid}: gave up after ${HEAL_MAX_RETRIES} respawn attempts` 
        });
        hs.retries++; // Increment past max so this message only shows once
      }
      continue;
    }
    
    // Cooldown — don't respawn too quickly
    const elapsed = now - hs.lastAttempt;
    if (elapsed < HEAL_COOLDOWN_SEC * 1000) {
      const remaining = Math.ceil((HEAL_COOLDOWN_SEC * 1000 - elapsed) / 1000);
      // Don't spam the feed — only note on first cooldown tick
      continue;
    }
    
    // Check the milestone isn't already complete
    const allSlicesDone = wk.slices.length > 0 && wk.slices.every(s => s.status === 'complete');
    if (allSlicesDone) {
      events.push({ ts: now, mid: wk.mid, msg: `✅ ${wk.mid}: all slices complete, no respawn needed` });
      hs.retries = HEAL_MAX_RETRIES + 1; // Don't try again
      continue;
    }
    
    // Attempt respawn
    hs.lastAttempt = now;
    hs.retries++;
    
    events.push({ 
      ts: now, mid: wk.mid, 
      msg: `🔄 ${wk.mid}: respawning (attempt ${hs.retries}/${HEAL_MAX_RETRIES})...` 
    });
    
    const newPid = respawnWorker(wk.mid);
    
    if (newPid) {
      events.push({ 
        ts: now, mid: wk.mid, 
        msg: `🟢 ${wk.mid}: respawned as PID ${newPid}` 
      });
      // Reset stderr baseline so we don't show old errors
      delete stderrBaselines[wk.mid];
    } else {
      events.push({ 
        ts: now, mid: wk.mid, isError: true,
        msg: `❌ ${wk.mid}: respawn failed` 
      });
    }
  }
  
  return events;
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms || ms < 0) return '--:--';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
}

function formatCost(cost) {
  if (cost == null) return '$-.--';
  return `$${cost.toFixed(2)}`;
}

function healthColor(heartbeatAge, alive) {
  if (!alive) return 'red';
  // PID alive is the strongest signal — worker is running
  if (heartbeatAge < 30000) return 'green';
  // Alive but stale heartbeat — either respawned (no orchestrator writing status.json)
  // or potentially stuck. Show green since headless idle timeout (120s) kills stuck workers.
  if (alive) return 'green';
  return 'red';
}

function healthIcon(color) {
  switch (color) {
    case 'green': return '●';
    case 'yellow': return '◐';
    case 'red': return '○';
    default: return '?';
  }
}

function unitTypeLabel(unitType) {
  const labels = {
    'execute-task': 'EXEC',
    'research-slice': 'RSRCH',
    'plan-slice': 'PLAN',
    'complete-slice': 'DONE',
    'complete-task': 'DONE',
    'reassess': 'ASSESS',
    'validate': 'VALID',
  };
  return labels[unitType] || (unitType || '---').toUpperCase().slice(0, 5);
}

function progressBar(done, total, width = 20) {
  if (total === 0) return `${'░'.repeat(width)}`;
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
}

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function rpad(str, width) {
  const s = String(str);
  return s.length >= width ? s.slice(0, width) : ' '.repeat(width - s.length) + s;
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Get recently completed tasks/slices from the worktree DB for the event feed.
 */
function queryRecentCompletions(mid) {
  const dbPath = path.resolve(PROJECT_ROOT, `.gsd/worktrees/${mid}/.gsd/gsd.db`);
  if (!fs.existsSync(dbPath)) return [];
  
  try {
    // Completed tasks with timestamps, most recent first
    const sql = `SELECT id, slice_id, one_liner, completed_at FROM tasks WHERE milestone_id='${mid}' AND status='complete' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 5`;
    const out = execSync(`sqlite3 "${dbPath}" "${sql}"`, { timeout: 3000, encoding: 'utf-8' }).trim();
    if (!out) return [];
    return out.split('\n').map(line => {
      const [taskId, sliceId, oneLiner, completedAt] = line.split('|');
      return {
        ts: completedAt ? new Date(completedAt).getTime() : Date.now(),
        msg: `✓ ${mid}/${sliceId}/${taskId}${oneLiner ? ': ' + oneLiner : ''}`,
        mid,
      };
    });
  } catch {
    return [];
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const COLS = Math.max(process.stdout.columns || 100, 80);
const ROWS = Math.max(process.stdout.rows || 40, 20);

let lastEventFeed = []; // Persisted across renders
const stderrBaselines = {}; // mid → file size at monitor startup (skip pre-existing errors)

function collectWorkerData() {
  const mids = discoverWorkers();
  const workers = [];
  
  for (const mid of mids) {
    const status = readWorkerStatus(mid);
    const lock = readAutoLock(mid);
    const slices = querySliceProgress(mid);
    const { notifications, errors } = readRecentEvents(mid, 3);
    
    // Prefer auto.lock PID (written by the running worker) over status.json PID 
    // (written by the orchestrator, stale after respawn)
    const pid = lock?.pid || status?.pid;
    const alive = pid ? isPidAlive(pid) : false;
    // Heartbeat: prefer status.json if its PID matches (orchestrator-managed),
    // otherwise fall back to stdout.log mtime (respawned workers write NDJSON continuously)
    let heartbeatAge = Infinity;
    const statusPidMatches = status?.pid && status.pid === pid;
    if (status?.lastHeartbeat && statusPidMatches) {
      heartbeatAge = Date.now() - status.lastHeartbeat;
    } else {
      // Check stdout/stderr log mtime as proxy heartbeat
      const stdoutLog = path.resolve(PROJECT_ROOT, PARALLEL_DIR, `${mid}.stdout.log`);
      const stderrLog = path.resolve(PROJECT_ROOT, PARALLEL_DIR, `${mid}.stderr.log`);
      try {
        const mtimes = [];
        if (fs.existsSync(stdoutLog)) mtimes.push(fs.statSync(stdoutLog).mtimeMs);
        if (fs.existsSync(stderrLog)) mtimes.push(fs.statSync(stderrLog).mtimeMs);
        if (lock?.unitStartedAt) mtimes.push(new Date(lock.unitStartedAt).getTime());
        if (mtimes.length > 0) heartbeatAge = Date.now() - Math.max(...mtimes);
      } catch { /* skip */ }
    }
    
    // Cost: prefer status.json, fall back to NDJSON log parsing
    let cost = status?.cost || 0;
    if (cost === 0) {
      cost = extractCostFromNdjson(mid);
    }
    
    const totalTasks = slices.reduce((sum, s) => sum + s.total, 0);
    const doneTasks = slices.reduce((sum, s) => sum + s.done, 0);
    const doneSlices = slices.filter(s => s.status === 'complete').length;
    const totalSlices = slices.length;
    
    // Current unit from auto.lock (more accurate than status.json currentUnit)
    const currentUnit = lock?.unitId || status?.currentUnit || null;
    const unitType = lock?.unitType || null;
    const unitStarted = lock?.unitStartedAt ? new Date(lock.unitStartedAt).getTime() : null;
    
    // If no lock and worker is dead, show nothing (not a misleading "START" label)
    const showUnit = currentUnit || (alive ? null : null);
    
    const elapsed = status?.startedAt 
      ? Date.now() - status.startedAt 
      : (lock?.startedAt ? Date.now() - new Date(lock.startedAt).getTime() : 0);
    
    workers.push({
      mid,
      pid,
      alive,
      state: alive ? 'running' : (status?.state || 'dead'),
      cost,
      heartbeatAge,
      health: healthColor(heartbeatAge, alive),
      currentUnit,
      unitType,
      unitElapsed: unitStarted ? Date.now() - unitStarted : 0,
      elapsed,
      totalTasks,
      doneTasks,
      totalSlices,
      doneSlices,
      slices,
      notifications,
      errors,
    });
  }
  
  return workers;
}

function render(workers) {
  const buf = [];
  const w = COLS;
  
  // ── Header ──
  buf.push('');
  const title = ' GSD Parallel Monitor ';
  const titlePad = Math.max(0, Math.floor((w - title.length) / 2));
  buf.push(
    `${' '.repeat(titlePad)}${BOLD}${BG.blue}${FG.white}${title}${RESET}`
  );
  
  const now = new Date().toLocaleTimeString();
  const totalCost = workers.reduce((s, w) => s + w.cost, 0);
  const aliveCount = workers.filter(w => w.alive).length;
  
  const healTag = HEAL_MODE ? `  │  ${FG.green}⚕ heal${RESET}${DIM}` : '';
  buf.push(
    `${DIM}  ${now}  │  ${aliveCount}/${workers.length} alive  │  Total: ${RESET}${BOLD}${formatCost(totalCost)}${RESET}${DIM}  │  Refresh: ${INTERVAL_SEC}s${healTag}${RESET}`
  );
  buf.push(`${DIM}${'─'.repeat(w)}${RESET}`);
  
  // ── Worker Panels ──
  if (workers.length === 0) {
    buf.push('');
    buf.push(`  ${FG.yellow}No workers found in ${PARALLEL_DIR}/${RESET}`);
    buf.push(`  ${DIM}Waiting for .gsd/parallel/*.status.json files...${RESET}`);
  } else {
    for (const wk of workers) {
      buf.push('');
      
      // Worker header: milestone ID + health + state
      const icon = healthIcon(wk.health);
      const hc = FG[wk.health];
      const stateLabel = wk.alive 
        ? (wk.state === 'running' ? `${FG.green}RUNNING${RESET}` : `${FG.yellow}${wk.state.toUpperCase()}${RESET}`)
        : `${FG.red}${BOLD}DEAD${RESET}`;
      
      const heartbeatText = wk.heartbeatAge === Infinity
        ? 'never'
        : formatDuration(wk.heartbeatAge) + ' ago';
      
      buf.push(
        `  ${hc}${icon}${RESET}  ${BOLD}${wk.mid}${RESET}  ${stateLabel}  ${DIM}PID ${wk.pid || '?'}${RESET}  ${DIM}│${RESET}  ${DIM}elapsed${RESET} ${formatDuration(wk.elapsed)}  ${DIM}│${RESET}  ${DIM}cost${RESET} ${BOLD}${formatCost(wk.cost)}${RESET}  ${DIM}│${RESET}  ${DIM}heartbeat${RESET} ${hc}${heartbeatText}${RESET}`
      );
      
      // Current unit
      if (wk.currentUnit) {
        const phaseColor = wk.unitType === 'execute-task' ? FG.cyan 
          : wk.unitType === 'research-slice' ? FG.magenta
          : wk.unitType === 'plan-slice' ? FG.blue
          : wk.unitType?.includes('complete') ? FG.green
          : FG.white;
        
        buf.push(
          `     ${DIM}▸${RESET} ${phaseColor}${unitTypeLabel(wk.unitType)}${RESET}  ${wk.currentUnit}  ${DIM}(${formatDuration(wk.unitElapsed)})${RESET}`
        );
      } else if (!wk.alive) {
        buf.push(`     ${DIM}▸ ${FG.red}stopped${RESET}`);
      } else {
        buf.push(`     ${DIM}▸ idle / between units${RESET}`);
      }
      
      // Slice progress grid
      if (wk.slices.length > 0) {
        const sliceChips = wk.slices.map(s => {
          const pct = s.total > 0 ? s.done / s.total : 0;
          let color;
          if (s.status === 'complete') color = FG.green;
          else if (pct > 0) color = FG.yellow;
          else color = FG.gray;
          
          const label = `${s.id}:${s.done}/${s.total}`;
          return `${color}${label}${RESET}`;
        });
        
        buf.push(`     ${DIM}slices${RESET}  ${sliceChips.join('  ')}`);
        
        // Overall progress bar
        const bar = progressBar(wk.doneTasks, wk.totalTasks, 30);
        const pctStr = wk.totalTasks > 0 
          ? `${Math.round((wk.doneTasks / wk.totalTasks) * 100)}%` 
          : '0%';
        buf.push(
          `     ${DIM}tasks${RESET}   ${FG.green}${bar}${RESET}  ${wk.doneTasks}/${wk.totalTasks} ${DIM}(${pctStr})${RESET}  ${DIM}│${RESET}  ${DIM}slices done${RESET} ${wk.doneSlices}/${wk.totalSlices}`
        );
      }
      
      // Recent errors from this worker
      if (wk.errors.length > 0) {
        for (const err of wk.errors.slice(-2)) {
          buf.push(`     ${FG.red}⚠ ${truncate(err.msg, w - 10)}${RESET}`);
        }
      }
    }
  }
  
  // ── Separator ──
  buf.push('');
  buf.push(`${DIM}${'─'.repeat(w)}${RESET}`);
  
  // ── Event Feed ──
  buf.push(`  ${BOLD}Recent Events${RESET}`);
  
  // Collect new notification events from all workers
  for (const wk of workers) {
    for (const evt of wk.notifications) {
      if (!lastEventFeed.some(e => e.msg === evt.msg && e.mid === evt.mid)) {
        lastEventFeed.push(evt);
      }
    }
  }
  
  // Also add recent task completions from the DB
  for (const wk of workers) {
    const completions = queryRecentCompletions(wk.mid);
    for (const evt of completions) {
      if (!lastEventFeed.some(e => e.msg === evt.msg)) {
        lastEventFeed.push(evt);
      }
    }
  }
  
  // Sort by timestamp and keep last 10
  lastEventFeed.sort((a, b) => a.ts - b.ts);
  lastEventFeed = lastEventFeed.slice(-10);
  
  if (lastEventFeed.length === 0) {
    buf.push(`  ${DIM}No events yet...${RESET}`);
  } else {
    for (const evt of lastEventFeed.slice(-6)) {
      const midTag = `${FG.cyan}${evt.mid}${RESET}`;
      buf.push(`  ${DIM}│${RESET} ${midTag} ${truncate(evt.msg, w - 12)}`);
    }
  }
  
  // ── Completion Check ──
  const allDone = workers.length > 0 && workers.every(w => !w.alive);
  if (allDone) {
    buf.push('');
    buf.push(`${DIM}${'─'.repeat(w)}${RESET}`);
    buf.push('');
    const doneMsg = ' ALL WORKERS COMPLETE ';
    const donePad = Math.max(0, Math.floor((w - doneMsg.length) / 2));
    buf.push(
      `${' '.repeat(donePad)}${BOLD}${BG.green}${FG.black}${doneMsg}${RESET}`
    );
    buf.push('');
    for (const wk of workers) {
      buf.push(`  ${wk.mid}  ${formatCost(wk.cost)}  ${DIM}│${RESET}  ${wk.doneSlices}/${wk.totalSlices} slices  ${wk.doneTasks}/${wk.totalTasks} tasks  ${DIM}│${RESET}  ${formatDuration(wk.elapsed)}`);
    }
    const totalCostFinal = workers.reduce((s, w) => s + w.cost, 0);
    buf.push(`  ${BOLD}Total: ${formatCost(totalCostFinal)}${RESET}`);
  }
  
  // ── Footer ──
  buf.push('');
  const healInfo = HEAL_MODE 
    ? ` │ heal: ${HEAL_COOLDOWN_SEC}s cooldown, ${HEAL_MAX_RETRIES} max retries`
    : '';
  buf.push(`  ${DIM}Ctrl+C to exit${allDone ? ' (monitoring stopped)' : ''}${healInfo}${RESET}`);
  
  // Write to screen
  process.stdout.write(CLEAR_SCREEN);
  process.stdout.write(buf.join('\n') + '\n');
  
  return allDone;
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

function main() {
  process.stdout.write(HIDE_CURSOR);
  
  // Handle resize
  process.stdout.on('resize', () => {
    // COLS/ROWS are recalculated on next render
  });
  
  // Graceful exit
  const cleanup = () => {
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write(CLEAR_SCREEN);
    console.log('Monitor stopped.');
    process.exit(0);
  };
  
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  
  // Initial render
  const workers = collectWorkerData();
  const healEvents = healWorkers(workers);
  for (const evt of healEvents) lastEventFeed.push(evt);
  let done = render(workers);
  
  if (done || ONE_SHOT) {
    process.stdout.write(SHOW_CURSOR);
    return;
  }
  
  // Refresh loop
  const timer = setInterval(() => {
    try {
      const workers = collectWorkerData();
      const healEvents = healWorkers(workers);
      for (const evt of healEvents) lastEventFeed.push(evt);
      done = render(workers);
      
      if (done) {
        clearInterval(timer);
        // Keep showing final state for 3 seconds then exit
        setTimeout(() => {
          process.stdout.write(SHOW_CURSOR);
          process.exit(0);
        }, 3000);
      }
    } catch (err) {
      // Don't crash the monitor on transient read errors
      process.stderr.write(`Monitor error: ${err.message}\n`);
    }
  }, INTERVAL_SEC * 1000);
}

main();
