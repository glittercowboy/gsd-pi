/**
 * GSD Command — /gsd backlog
 *
 * Structured backlog management with 999.x numbering.
 * Items stored in .gsd/BACKLOG.md as markdown checklist.
 * Items can be promoted to active slices via add-slice.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import { gsdRoot } from "./paths.js";

interface BacklogItem {
  id: string;
  title: string;
  done: boolean;
  note: string;
}

function backlogPath(basePath: string): string {
  return join(gsdRoot(basePath), "BACKLOG.md");
}

function parseBacklog(basePath: string): BacklogItem[] {
  const filePath = backlogPath(basePath);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const items: BacklogItem[] = [];

  for (const line of content.split("\n")) {
    const match = line.match(/^- \[([ x])\] (999\.\d+) — (.+?)(?:\s*\((.+)\))?$/);
    if (match) {
      items.push({
        id: match[2],
        title: match[3].trim(),
        done: match[1] === "x",
        note: match[4] ?? "",
      });
    }
  }

  return items;
}

function writeBacklog(basePath: string, items: BacklogItem[]): void {
  const filePath = backlogPath(basePath);
  mkdirSync(dirname(filePath), { recursive: true });
  const lines = ["# Backlog\n"];
  for (const item of items) {
    const check = item.done ? "x" : " ";
    const note = item.note ? ` (${item.note})` : "";
    lines.push(`- [${check}] ${item.id} — ${item.title}${note}`);
  }
  lines.push(""); // trailing newline
  writeFileSync(filePath, lines.join("\n"), "utf-8");
}

function nextBacklogId(items: BacklogItem[]): string {
  let maxNum = 0;
  for (const item of items) {
    const match = item.id.match(/^999\.(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `999.${maxNum + 1}`;
}

async function listBacklog(basePath: string, ctx: ExtensionCommandContext): Promise<void> {
  const items = parseBacklog(basePath);
  if (items.length === 0) {
    ctx.ui.notify("Backlog is empty. Add items with /gsd backlog add <title>", "info");
    return;
  }

  const lines = ["Backlog:\n"];
  for (const item of items) {
    const status = item.done ? "✓" : "○";
    const note = item.note ? ` (${item.note})` : "";
    lines.push(`  ${status} ${item.id} — ${item.title}${note}`);
  }
  const pending = items.filter((i) => !i.done).length;
  lines.push(`\n${pending} pending, ${items.length - pending} promoted/done`);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function addBacklogItem(basePath: string, title: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!title) {
    ctx.ui.notify("Usage: /gsd backlog add <title>", "warning");
    return;
  }

  const items = parseBacklog(basePath);
  const id = nextBacklogId(items);
  const date = new Date().toISOString().slice(0, 10);

  items.push({ id, title: title.replace(/^['"]|['"]$/g, ""), done: false, note: `added ${date}` });
  writeBacklog(basePath, items);

  ctx.ui.notify(`Added ${id}: "${title}"`, "success");
}

async function promoteBacklogItem(
  basePath: string,
  itemId: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!itemId) {
    ctx.ui.notify("Usage: /gsd backlog promote <id>\nExample: /gsd backlog promote 999.1", "warning");
    return;
  }

  const items = parseBacklog(basePath);
  const item = items.find((i) => i.id === itemId);

  if (!item) {
    ctx.ui.notify(`Backlog item ${itemId} not found.`, "warning");
    return;
  }

  if (item.done) {
    ctx.ui.notify(`${itemId} is already promoted/done.`, "info");
    return;
  }

  // Promote — currently requires single-writer engine (not yet available)
  // Mark as promoted in backlog for now; slice creation will be available with the engine.
  item.done = true;
  item.note = `promoted ${new Date().toISOString().slice(0, 10)}`;
  writeBacklog(basePath, items);
  ctx.ui.notify(`Promoted ${itemId}: "${item.title}" — add it to the roadmap manually or wait for engine slice commands.`, "info");
}

async function removeBacklogItem(basePath: string, itemId: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!itemId) {
    ctx.ui.notify("Usage: /gsd backlog remove <id>", "warning");
    return;
  }

  const items = parseBacklog(basePath);
  const idx = items.findIndex((i) => i.id === itemId);

  if (idx === -1) {
    ctx.ui.notify(`Backlog item ${itemId} not found.`, "warning");
    return;
  }

  const removed = items.splice(idx, 1)[0];
  writeBacklog(basePath, items);
  ctx.ui.notify(`Removed ${removed.id}: "${removed.title}"`, "success");
}

export async function handleBacklog(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const basePath = process.cwd();
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? "";
  const rest = parts.slice(1).join(" ");

  switch (sub) {
    case "":
      return listBacklog(basePath, ctx);
    case "add":
      return addBacklogItem(basePath, rest, ctx);
    case "promote":
      return promoteBacklogItem(basePath, rest.trim(), ctx, pi);
    case "remove":
      return removeBacklogItem(basePath, rest.trim(), ctx);
    default:
      // Treat as implicit add
      return addBacklogItem(basePath, args, ctx);
  }
}
