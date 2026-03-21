import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { registerJournalTools } from "../bootstrap/journal-tools.ts";
import { emitJournalEvent, type JournalEntry } from "../journal.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockPi() {
  const tools: any[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    tools,
  } as any;
}

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-journal-tool-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* */
  }
}

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ts: "2025-03-21T10:00:00.000Z",
    flowId: "flow-aaa",
    seq: 0,
    eventType: "iteration-start",
    ...overrides,
  };
}

async function executeToolInDir(tool: any, params: Record<string, unknown>, dir: string) {
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    return await tool.execute("test-call-id", params, undefined, undefined, undefined);
  } finally {
    process.chdir(originalCwd);
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

test("registerJournalTools registers gsd_journal_query tool", () => {
  const pi = makeMockPi();
  registerJournalTools(pi);
  assert.equal(pi.tools.length, 1, "Should register exactly one tool");
  assert.equal(pi.tools[0].name, "gsd_journal_query");
});

// ─── Filtering ────────────────────────────────────────────────────────────────

test("gsd_journal_query returns filtered entries", async () => {
  const base = makeTmpBase();
  try {
    emitJournalEvent(base, makeEntry({ seq: 0, flowId: "flow-aaa", data: { unitId: "M001/S01/T01" } }));
    emitJournalEvent(base, makeEntry({ seq: 1, flowId: "flow-bbb", data: { unitId: "M001/S01/T02" } }));
    emitJournalEvent(base, makeEntry({ seq: 2, flowId: "flow-aaa", data: { unitId: "M001/S01/T01" } }));

    const pi = makeMockPi();
    registerJournalTools(pi);
    const tool = pi.tools[0];

    const result = await executeToolInDir(tool, { unitId: "M001/S01/T01" }, base);
    const entries = JSON.parse(result.content[0].text) as JournalEntry[];

    assert.equal(entries.length, 2, "Should return 2 entries matching unitId");
    assert.ok(
      entries.every((e: any) => e.data?.unitId === "M001/S01/T01"),
      "All entries should have matching unitId",
    );
  } finally {
    cleanup(base);
  }
});

// ─── Empty Results ────────────────────────────────────────────────────────────

test("gsd_journal_query returns 'no entries' message for empty results", async () => {
  const base = makeTmpBase();
  try {
    emitJournalEvent(base, makeEntry({ seq: 0, flowId: "flow-aaa" }));

    const pi = makeMockPi();
    registerJournalTools(pi);
    const tool = pi.tools[0];

    const result = await executeToolInDir(tool, { flowId: "nonexistent-flow" }, base);
    assert.equal(result.content[0].text, "No matching journal entries found.");
  } finally {
    cleanup(base);
  }
});

// ─── Limit ────────────────────────────────────────────────────────────────────

test("gsd_journal_query respects limit parameter", async () => {
  const base = makeTmpBase();
  try {
    for (let i = 0; i < 5; i++) {
      emitJournalEvent(base, makeEntry({ seq: i }));
    }

    const pi = makeMockPi();
    registerJournalTools(pi);
    const tool = pi.tools[0];

    const result = await executeToolInDir(tool, { limit: 2 }, base);
    const entries = JSON.parse(result.content[0].text) as JournalEntry[];
    assert.equal(entries.length, 2, "Should return only 2 entries");
  } finally {
    cleanup(base);
  }
});

// ─── Error Handling ───────────────────────────────────────────────────────────

test("gsd_journal_query handles errors gracefully", async () => {
  const pi = makeMockPi();
  registerJournalTools(pi);
  const tool = pi.tools[0];

  // queryJournal returns [] for missing journal dirs (never throws), so empty
  // result is the expected behavior. This confirms the tool doesn't crash and
  // returns the "no entries" message when there's no journal data.
  const base = join(tmpdir(), `gsd-journal-tool-test-${randomUUID()}`);
  mkdirSync(base, { recursive: true }); // dir must exist for process.chdir
  try {
    const result = await executeToolInDir(tool, {}, base);
    assert.equal(result.content[0].text, "No matching journal entries found.");
  } finally {
    cleanup(base);
  }
});
