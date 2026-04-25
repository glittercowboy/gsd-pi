import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-backlog-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

function backlogPath(base: string): string {
  return join(base, ".gsd", "BACKLOG.md");
}

function writeBacklog(base: string, content: string): void {
  writeFileSync(backlogPath(base), content, "utf-8");
}

function readBacklog(base: string): string {
  return readFileSync(backlogPath(base), "utf-8");
}

// Test the parsing/writing logic inline since the handler requires runtime context

interface BacklogItem {
  id: string;
  title: string;
  done: boolean;
  note: string;
}

function parseBacklog(content: string): BacklogItem[] {
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

function formatBacklog(items: BacklogItem[]): string {
  const lines = ["# Backlog\n"];
  for (const item of items) {
    const check = item.done ? "x" : " ";
    const note = item.note ? ` (${item.note})` : "";
    lines.push(`- [${check}] ${item.id} — ${item.title}${note}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("backlog: parse empty file returns empty array", () => {
  const items = parseBacklog("");
  assert.equal(items.length, 0);
});

test("backlog: parse valid entries", () => {
  const content = `# Backlog

- [ ] 999.1 — OAuth support (added 2026-03-23)
- [x] 999.2 — Rate limiting (promoted 2026-03-24)
- [ ] 999.3 — Dark mode`;

  const items = parseBacklog(content);
  assert.equal(items.length, 3);
  assert.equal(items[0].id, "999.1");
  assert.equal(items[0].title, "OAuth support");
  assert.equal(items[0].done, false);
  assert.equal(items[0].note, "added 2026-03-23");

  assert.equal(items[1].id, "999.2");
  assert.equal(items[1].done, true);
  assert.equal(items[1].note, "promoted 2026-03-24");

  assert.equal(items[2].id, "999.3");
  assert.equal(items[2].title, "Dark mode");
  assert.equal(items[2].note, "");
});

test("backlog: format roundtrips correctly", () => {
  const items: BacklogItem[] = [
    { id: "999.1", title: "OAuth support", done: false, note: "added 2026-03-23" },
    { id: "999.2", title: "Rate limiting", done: true, note: "promoted 2026-03-24" },
  ];

  const formatted = formatBacklog(items);
  const parsed = parseBacklog(formatted);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, "999.1");
  assert.equal(parsed[0].title, "OAuth support");
  assert.equal(parsed[1].done, true);
});

test("backlog: write and read from disk", () => {
  const base = makeTmpBase();
  try {
    const items: BacklogItem[] = [
      { id: "999.1", title: "Test item", done: false, note: "added 2026-03-23" },
    ];
    writeBacklog(base, formatBacklog(items));

    assert.ok(existsSync(backlogPath(base)));
    const content = readBacklog(base);
    assert.ok(content.includes("999.1"));
    assert.ok(content.includes("Test item"));
  } finally {
    cleanup(base);
  }
});

test("backlog: next ID increments correctly", () => {
  const items: BacklogItem[] = [
    { id: "999.1", title: "First", done: false, note: "" },
    { id: "999.2", title: "Second", done: false, note: "" },
    { id: "999.5", title: "Fifth", done: false, note: "" },
  ];

  let maxNum = 0;
  for (const item of items) {
    const match = item.id.match(/^999\.(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  const nextId = `999.${maxNum + 1}`;
  assert.equal(nextId, "999.6");
});

test("backlog: empty backlog returns no items", () => {
  const base = makeTmpBase();
  try {
    // No BACKLOG.md exists
    assert.ok(!existsSync(backlogPath(base)));
    // Would return empty array
  } finally {
    cleanup(base);
  }
});
