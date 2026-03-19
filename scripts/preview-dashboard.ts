/**
 * Visual preview of the auto-mode dashboard widget.
 * Run: npx tsx scripts/preview-dashboard.ts [width] [--no-milestone] [--narrow] [--unhealthy]
 *
 * Renders the two-column layout with mock data so you can see
 * exactly how it looks at any terminal width.
 *
 * Examples:
 *   npx tsx scripts/preview-dashboard.ts              # default 120 cols, with milestone
 *   npx tsx scripts/preview-dashboard.ts 80            # narrow single-column
 *   npx tsx scripts/preview-dashboard.ts --no-milestone # compact no-milestone view
 *   npx tsx scripts/preview-dashboard.ts --unhealthy   # yellow/red health states
 *   npx tsx scripts/preview-dashboard.ts --narrow      # force 80 cols
 */

import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { makeUI, GLYPH, INDENT } from "../src/resources/extensions/shared/mod.js";

// ── Minimal ANSI color theme (no Theme class dependency) ────────────────

const COLORS: Record<string, string> = {
  accent:  "\x1b[36m",   // cyan
  dim:     "\x1b[2m",    // dim
  text:    "\x1b[37m",   // white
  success: "\x1b[32m",   // green
  error:   "\x1b[31m",   // red
  warning: "\x1b[33m",   // yellow
  muted:   "\x1b[90m",   // gray
};
const RESET_FG = "\x1b[22m\x1b[39m";

const theme = {
  fg(color: string, text: string): string {
    const ansi = COLORS[color] ?? COLORS.text;
    return `${ansi}${text}${RESET_FG}`;
  },
  bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`;
  },
};

// ── CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const noMilestone = args.includes("--no-milestone");
const forceNarrow = args.includes("--narrow");
const unhealthy = args.includes("--unhealthy");
const widthArg = args.find(a => /^\d+$/.test(a));
const width = forceNarrow ? 80 : (parseInt(widthArg ?? "", 10) || process.stdout.columns || 120);

// ── Mock data ───────────────────────────────────────────────────────────

const mockTasks = [
  { id: "T01", title: "Core type definitions & interfaces", done: true },
  { id: "T02", title: "Database schema migration", done: true },
  { id: "T03", title: "API route handlers", done: true },
  { id: "T04", title: "Authentication middleware", done: false },
  { id: "T05", title: "Unit & integration tests", done: false },
  { id: "T06", title: "Documentation updates", done: false },
];

const currentTaskId = "T04";
const milestoneTitle = "Core Patching Daemon";
const sliceId = "S04";
const sliceTitle = "CI gate";
const unitId = noMilestone ? "some-unit-id" : "M001-07dqzj/S04";
const verb = noMilestone ? "executing" : "completing";
const phaseLabel = noMilestone ? "EXECUTE" : "COMPLETE";
const modeTag = "AUTO";
const elapsed = "1h 23m";
const slicesDone = 3;
const slicesTotal = 6;
const taskNum = 4;
const taskTotal = 6;
const eta = "~1h 47m remaining";
const nextStep = noMilestone ? "" : "reassess roadmap";
const pwd = noMilestone
  ? "~/Github/my-project (main)"
  : "~/Github/git-patcher/.gsd/worktrees/M001-07dqzj (milestone/M001-07dqzj)";
const tokenStats = "↑22 ↓11k R1.1M W38k ⚡85% $18.668 35.2%/200k";
const modelDisplay = "anthropic/claude-opus-4-6";

// Health states
const healthStates = unhealthy
  ? [
    { icon: "⚠", color: "warning", summary: "Struggling — 2 consecutive error unit(s)" },
    { icon: "✗", color: "error", summary: "Stuck — 4 consecutive error units" },
  ]
  : [{ icon: GLYPH.statusActive, color: "success", summary: "Progressing well" }];

// ── Render helpers ──────────────────────────────────────────────────────

function rightAlign(left: string, right: string, w: number): string {
  const leftVis = visibleWidth(left);
  const rightVis = visibleWidth(right);
  const gap = Math.max(1, w - leftVis - rightVis);
  return truncateToWidth(left + " ".repeat(gap) + right, w);
}

function padToWidth(s: string, colWidth: number): string {
  const vis = visibleWidth(s);
  if (vis >= colWidth) return truncateToWidth(s, colWidth);
  return s + " ".repeat(colWidth - vis);
}

// ── Render ──────────────────────────────────────────────────────────────

function render(w: number, healthState: { icon: string; color: string; summary: string }): string[] {
  const ui = makeUI(theme as any, w);
  const lines: string[] = [];
  const pad = INDENT.base;

  // Top bar
  lines.push(...ui.bar());

  // Header: GSD AUTO ... elapsed
  const dot = theme.fg("accent", GLYPH.statusActive);
  const headerLeft = `${pad}${dot} ${theme.fg("accent", theme.bold("GSD"))}  ${theme.fg("success", modeTag)}`;
  const headerRight = theme.fg("dim", elapsed);
  lines.push(rightAlign(headerLeft, headerRight, w));

  lines.push("");

  // Context section: milestone + slice (only when present)
  if (!noMilestone) {
    lines.push(truncateToWidth(`${pad}${theme.fg("dim", milestoneTitle)}`, w));
    lines.push(truncateToWidth(
      `${pad}${theme.fg("text", theme.bold(`${sliceId}: ${sliceTitle}`))}`,
      w,
    ));
    lines.push("");
  }

  // Action line
  const target = noMilestone ? unitId : `${currentTaskId}: ${mockTasks.find(t => t.id === currentTaskId)!.title}`;
  const actionLeft = `${pad}${theme.fg("accent", "▸")} ${theme.fg("accent", verb)}  ${theme.fg("text", target)}`;
  const phaseBadge = theme.fg("dim", phaseLabel);
  lines.push(rightAlign(actionLeft, phaseBadge, w));

  // Two-column body
  const minTwoColWidth = 100;
  const rightColFixed = 44;
  const colGap = 5;
  const hasTasks = !noMilestone;
  const useTwoCol = w >= minTwoColWidth && hasTasks;
  const rightColWidth = useTwoCol ? rightColFixed : 0;
  const leftColWidth = useTwoCol ? w - rightColWidth - colGap : w;

  // Left column
  const leftLines: string[] = [];

  if (!noMilestone) {
    const barWidth = Math.max(6, Math.min(18, Math.floor(leftColWidth * 0.4)));
    const pct = slicesDone / slicesTotal;
    const filled = Math.round(pct * barWidth);
    const bar = theme.fg("success", "█".repeat(filled))
      + theme.fg("dim", "░".repeat(barWidth - filled));
    const meta = theme.fg("dim", `${slicesDone}/${slicesTotal} slices`)
      + theme.fg("dim", ` · task ${taskNum}/${taskTotal}`);
    leftLines.push(truncateToWidth(`${pad}${bar} ${meta}`, leftColWidth));
    leftLines.push(truncateToWidth(`${pad}${theme.fg("dim", eta)}`, leftColWidth));
  }

  // Health indicator
  leftLines.push(truncateToWidth(
    `${pad}${theme.fg(healthState.color, healthState.icon)} ${theme.fg(healthState.color, healthState.summary)}`,
    leftColWidth,
  ));

  if (nextStep) {
    leftLines.push(truncateToWidth(
      `${pad}${theme.fg("dim", "→")} ${theme.fg("dim", `then ${nextStep}`)}`,
      leftColWidth,
    ));
  }

  // Token stats
  leftLines.push(truncateToWidth(`${pad}${theme.fg("dim", tokenStats)}`, leftColWidth));
  leftLines.push(truncateToWidth(`${pad}${theme.fg("dim", modelDisplay)}`, leftColWidth));

  // Right column: task checklist
  const rightLines: string[] = [];
  const rpad = " ";

  if (useTwoCol) {
    for (const t of mockTasks) {
      const isCurrent = t.id === currentTaskId;
      const glyph = t.done
        ? theme.fg("success", GLYPH.statusDone)
        : isCurrent
          ? theme.fg("accent", "▸")
          : theme.fg("dim", " ");
      const label = isCurrent
        ? theme.fg("text", `${t.id}: ${t.title}`)
        : t.done
          ? theme.fg("dim", `${t.id}: ${t.title}`)
          : theme.fg("text", `${t.id}: ${t.title}`);
      rightLines.push(truncateToWidth(`${rpad}${glyph} ${label}`, rightColWidth));
    }
  } else if (hasTasks) {
    // Narrow: tasks inline
    for (const t of mockTasks) {
      const isCurrent = t.id === currentTaskId;
      const glyph = t.done
        ? theme.fg("success", GLYPH.statusDone)
        : isCurrent
          ? theme.fg("accent", "▸")
          : theme.fg("dim", " ");
      const label = isCurrent
        ? theme.fg("text", `${t.id}: ${t.title}`)
        : t.done
          ? theme.fg("dim", `${t.id}: ${t.title}`)
          : theme.fg("text", `${t.id}: ${t.title}`);
      leftLines.push(truncateToWidth(`${pad}${glyph} ${label}`, leftColWidth));
    }
  }

  // Compose columns
  if (useTwoCol) {
    const divider = theme.fg("dim", "│");
    const maxRows = Math.max(leftLines.length, rightLines.length);
    lines.push("");
    for (let i = 0; i < maxRows; i++) {
      const left = padToWidth(leftLines[i] ?? "", leftColWidth);
      const gap = " ".repeat(colGap - 2);
      const right = rightLines[i] ?? "";
      lines.push(truncateToWidth(`${left}${gap}${divider} ${right}`, w));
    }
  } else {
    lines.push("");
    for (const l of leftLines) lines.push(l);
  }

  // Footer
  lines.push("");
  const hintStr = theme.fg("dim", "esc pause | ⌃⌥G dashboard");
  const pwdStr = theme.fg("dim", pwd);
  lines.push(rightAlign(`${pad}${pwdStr}`, hintStr, w));

  lines.push(...ui.bar());

  return lines;
}

// ── Main ────────────────────────────────────────────────────────────────

for (const healthState of healthStates) {
  const label = noMilestone ? "no-milestone" : `${width} cols`;
  console.log(`\n  Preview: ${label}, health=${healthState.color}\n`);
  for (const line of render(width, healthState)) {
    console.log(line);
  }
}
console.log();
