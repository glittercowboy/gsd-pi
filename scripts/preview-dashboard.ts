/**
 * Visual preview of the auto-mode dashboard widget.
 * Run: npx tsx scripts/preview-dashboard.ts [width]
 *
 * Renders the two-column layout with mock data so you can see
 * exactly how it looks at any terminal width.
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
const unitId = "M001-07dqzj/S04";
const verb = "completing";
const phaseLabel = "COMPLETE";
const modeTag = "AUTO";
const elapsed = "1h 23m";
const slicesDone = 3;
const slicesTotal = 6;
const taskNum = 4;
const taskTotal = 6;
const eta = "~1h 47m remaining";
const nextStep = "reassess roadmap";
const pwd = "~/Github/git-patcher/.gsd/worktrees/M001-07dqzj (milestone/M001-07dqzj)";
const tokenStats = "↑22 ↓11k R1.1M W38k ⚡85% $18.668";
const contextStats = "35.2%/200k";
const modelDisplay = "anthropic/claude-opus-4-6";

// ── Render helpers ──────────────────────────────────────────────────────

function rightAlign(left: string, right: string, width: number): string {
  const leftVis = visibleWidth(left);
  const rightVis = visibleWidth(right);
  const gap = Math.max(1, width - leftVis - rightVis);
  return truncateToWidth(left + " ".repeat(gap) + right, width);
}

function padToWidth(s: string, colWidth: number): string {
  const vis = visibleWidth(s);
  if (vis >= colWidth) return truncateToWidth(s, colWidth);
  return s + " ".repeat(colWidth - vis);
}

// ── Render ──────────────────────────────────────────────────────────────

function render(width: number): string[] {
  const ui = makeUI(theme as any, width);
  const lines: string[] = [];
  const pad = INDENT.base;

  // Top bar
  lines.push(...ui.bar());

  // Header: GSD AUTO ... elapsed
  const dot = theme.fg("accent", GLYPH.statusActive);
  const headerLeft = `${pad}${dot} ${theme.fg("accent", theme.bold("GSD"))} ${theme.fg("success", modeTag)}`;
  const headerRight = theme.fg("dim", elapsed);
  lines.push(rightAlign(headerLeft, headerRight, width));

  // Context line: project · slice · action
  const contextParts = [
    theme.fg("dim", milestoneTitle),
    theme.fg("text", theme.bold(`${sliceId}: ${sliceTitle}`)),
    `${theme.fg("accent", "▸")} ${theme.fg("accent", verb)} ${theme.fg("text", unitId)}`,
  ];
  const phaseBadge = theme.fg("dim", phaseLabel);
  const contextLine = contextParts.join(theme.fg("dim", " · "));
  lines.push(rightAlign(`${pad}${contextLine}`, phaseBadge, width));

  // Column sizing: left column fixed (tasks), right column flexes (stats)
  const colGap = 3;
  const minTwoColWidth = 80;
  const leftColFixed = 44;
  const useTwoCol = width >= minTwoColWidth;
  const leftColWidth = useTwoCol ? Math.min(leftColFixed, Math.floor(width * 0.55)) : width;
  const rightColWidth = useTwoCol ? width - leftColWidth - colGap : 0;

  // Left column: task checklist
  const leftLines: string[] = [];

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

  // Right column: progress, ETA, next, stats (only in two-column mode)
  const rightLines: string[] = [];
  const rpad = " ";

  if (useTwoCol) {
    const barWidth = Math.max(6, Math.min(18, Math.floor(rightColWidth * 0.4)));
    const pct = slicesDone / slicesTotal;
    const filled = Math.round(pct * barWidth);
    const bar = theme.fg("success", "█".repeat(filled))
      + theme.fg("dim", "░".repeat(barWidth - filled));
    const meta = theme.fg("dim", `${slicesDone}/${slicesTotal} slices`)
      + theme.fg("dim", ` · task ${taskNum}/${taskTotal}`);
    rightLines.push(truncateToWidth(`${rpad}${bar} ${meta}`, rightColWidth));
    rightLines.push(truncateToWidth(`${rpad}${theme.fg("dim", eta)}`, rightColWidth));
    rightLines.push(truncateToWidth(
      `${rpad}${theme.fg("dim", "→")} ${theme.fg("dim", `then ${nextStep}`)}`,
      rightColWidth,
    ));
    rightLines.push(truncateToWidth(
      `${rpad}${theme.fg("dim", tokenStats)} ${theme.fg("dim", contextStats)}`,
      rightColWidth,
    ));
    rightLines.push(truncateToWidth(`${rpad}${theme.fg("dim", modelDisplay)}`, rightColWidth));
  } else {
    // Narrow: add progress inline below tasks
    const barWidth = Math.max(6, Math.min(18, Math.floor(leftColWidth * 0.4)));
    const pct = slicesDone / slicesTotal;
    const filled = Math.round(pct * barWidth);
    const bar = theme.fg("success", "█".repeat(filled))
      + theme.fg("dim", "░".repeat(barWidth - filled));
    const meta = theme.fg("dim", `${slicesDone}/${slicesTotal} slices · task ${taskNum}/${taskTotal} · ${eta}`);
    leftLines.push(truncateToWidth(`${pad}${bar} ${meta}`, leftColWidth));
    leftLines.push(truncateToWidth(
      `${pad}${theme.fg("dim", "→")} ${theme.fg("dim", `then ${nextStep}`)}`,
      leftColWidth,
    ));
  }

  // Compose columns
  if (useTwoCol) {
    const divider = theme.fg("dim", "│");
    const maxRows = Math.max(leftLines.length, rightLines.length);
    lines.push("");
    for (let i = 0; i < maxRows; i++) {
      const left = padToWidth(leftLines[i] ?? "", leftColWidth);
      const right = rightLines[i] ?? "";
      lines.push(truncateToWidth(`${left} ${divider} ${right}`, width));
    }
  } else {
    lines.push("");
    for (const l of leftLines) lines.push(l);
  }

  // Footer
  lines.push("");
  const hintStr = theme.fg("dim", "esc pause | ⌃⌥G dashboard");
  const pwdStr = theme.fg("dim", pwd);
  lines.push(rightAlign(`${pad}${pwdStr}`, hintStr, width));

  lines.push(...ui.bar());

  return lines;
}

// ── Main ────────────────────────────────────────────────────────────────

const width = parseInt(process.argv[2] ?? "", 10) || process.stdout.columns || 100;
console.log(`\nPreview at width=${width}:\n`);
for (const line of render(width)) {
  console.log(line);
}
console.log();
