import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorktreeResolver,
  type WorktreeResolverDeps,
  type NotifyCtx,
} from "../worktree-resolver.js";
import { AutoSession } from "../auto/session.js";
import type { JournalEntry } from "../journal.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(
  overrides?: Partial<{ basePath: string; originalBasePath: string }>,
): AutoSession {
  const s = new AutoSession();
  s.basePath = overrides?.basePath ?? "/project";
  s.originalBasePath = overrides?.originalBasePath ?? "/project";
  return s;
}

function makeDeps(
  overrides?: Partial<WorktreeResolverDeps>,
): WorktreeResolverDeps {
  const deps: WorktreeResolverDeps = {
    isInAutoWorktree: () => false,
    shouldUseWorktreeIsolation: () => true,
    getIsolationMode: () => "worktree",
    mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: true }),
    syncWorktreeStateBack: () => ({ synced: [] }),
    teardownAutoWorktree: () => {},
    createAutoWorktree: (_basePath: string, milestoneId: string) =>
      `/project/.gsd/worktrees/${milestoneId}`,
    enterAutoWorktree: (_basePath: string, milestoneId: string) =>
      `/project/.gsd/worktrees/${milestoneId}`,
    getAutoWorktreePath: () => null,
    autoCommitCurrentBranch: () => {},
    getCurrentBranch: () => "main",
    autoWorktreeBranch: (milestoneId: string) => `milestone/${milestoneId}`,
    resolveMilestoneFile: (_basePath: string, milestoneId: string) =>
      `/project/.gsd/milestones/${milestoneId}/${milestoneId}-ROADMAP.md`,
    readFileSync: () => "# Roadmap\n- [x] S01: Slice one\n",
    GitServiceImpl: class {
      constructor() {}
    } as unknown as WorktreeResolverDeps["GitServiceImpl"],
    loadEffectiveGSDPreferences: () => ({ preferences: { git: {} } }),
    invalidateAllCaches: () => {},
    captureIntegrationBranch: () => {},
    enterBranchModeForMilestone: () => {},
    ...overrides,
  };
  return deps;
}

function makeNotifyCtx(): NotifyCtx {
  return {
    notify: () => {},
  };
}

/** Read all journal entries from a temp .gsd/journal directory. */
function readJournalEntries(basePath: string): JournalEntry[] {
  const journalDir = join(basePath, ".gsd", "journal");
  try {
    const files = readdirSync(journalDir).filter(f => f.endsWith(".jsonl")).sort();
    const entries: JournalEntry[] = [];
    for (const file of files) {
      const raw = readFileSync(join(journalDir, file), "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        entries.push(JSON.parse(line) as JournalEntry);
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("worktree journal events", () => {
  let tmp: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "wt-journal-"));
  });
  afterEach(() => {
    // Restore cwd before cleanup — on Windows, rmSync fails with EPERM
    // if the process cwd is inside the directory being deleted.
    try { process.chdir(originalCwd); } catch { /* best-effort */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  test("enterMilestone emits worktree-enter on success (new worktree)", () => {
    const s = makeSession({ basePath: tmp, originalBasePath: tmp });
    const deps = makeDeps({ getAutoWorktreePath: () => null });
    const resolver = new WorktreeResolver(s, deps);

    resolver.enterMilestone("M001", makeNotifyCtx());

    const entries = readJournalEntries(tmp);
    const enter = entries.find(e => e.eventType === "worktree-enter");
    assert.ok(enter, "worktree-enter event should be emitted");
    assert.equal(enter!.data?.milestoneId, "M001");
    assert.equal(enter!.data?.created, true);
    assert.ok(enter!.data?.wtPath);
  });

  test("enterMilestone emits worktree-enter with created=false for existing worktree", () => {
    const s = makeSession({ basePath: tmp, originalBasePath: tmp });
    const deps = makeDeps({
      getAutoWorktreePath: () => "/project/.gsd/worktrees/M001",
    });
    const resolver = new WorktreeResolver(s, deps);

    resolver.enterMilestone("M001", makeNotifyCtx());

    const entries = readJournalEntries(tmp);
    const enter = entries.find(e => e.eventType === "worktree-enter");
    assert.ok(enter, "worktree-enter event should be emitted");
    assert.equal(enter!.data?.created, false);
  });

  test("enterMilestone emits worktree-skip when isolation disabled", () => {
    const s = makeSession({ basePath: tmp, originalBasePath: tmp });
    const deps = makeDeps({ shouldUseWorktreeIsolation: () => false, getIsolationMode: () => "none" });
    const resolver = new WorktreeResolver(s, deps);

    resolver.enterMilestone("M001", makeNotifyCtx());

    const entries = readJournalEntries(tmp);
    const skip = entries.find(e => e.eventType === "worktree-skip");
    assert.ok(skip, "worktree-skip event should be emitted");
    assert.equal(skip!.data?.milestoneId, "M001");
    assert.equal(skip!.data?.reason, "isolation-disabled");
  });

  test("enterMilestone emits worktree-create-failed on error", () => {
    const s = makeSession({ basePath: tmp, originalBasePath: tmp });
    const deps = makeDeps({
      getAutoWorktreePath: () => null,
      createAutoWorktree: () => { throw new Error("disk full"); },
    });
    const resolver = new WorktreeResolver(s, deps);

    resolver.enterMilestone("M001", makeNotifyCtx());

    const entries = readJournalEntries(tmp);
    const failed = entries.find(e => e.eventType === "worktree-create-failed");
    assert.ok(failed, "worktree-create-failed event should be emitted");
    assert.equal(failed!.data?.milestoneId, "M001");
    assert.equal(failed!.data?.error, "disk full");
    assert.equal(failed!.data?.fallback, "project-root");
  });

  test("mergeAndExit emits worktree-merge-start", () => {
    const s = makeSession({
      basePath: join(tmp, "worktree"),
      originalBasePath: tmp,
    });
    const deps = makeDeps({
      isInAutoWorktree: () => true,
      getIsolationMode: () => "worktree",
    });
    const resolver = new WorktreeResolver(s, deps);

    resolver.mergeAndExit("M001", makeNotifyCtx());

    const entries = readJournalEntries(tmp);
    const start = entries.find(e => e.eventType === "worktree-merge-start");
    assert.ok(start, "worktree-merge-start event should be emitted");
    assert.equal(start!.data?.milestoneId, "M001");
    assert.equal(start!.data?.mode, "worktree");
  });

  test("mergeAndExit emits worktree-merge-failed on error", () => {
    const s = makeSession({
      basePath: join(tmp, "worktree"),
      originalBasePath: tmp,
    });
    const deps = makeDeps({
      isInAutoWorktree: () => true,
      getIsolationMode: () => "worktree",
      mergeMilestoneToMain: () => { throw new Error("conflict in main"); },
    });
    const resolver = new WorktreeResolver(s, deps);

    // Since #4380, mergeAndExit re-throws all errors after emitting the journal
    // event and restoring state — callers must handle the throw.
    assert.throws(
      () => resolver.mergeAndExit("M001", makeNotifyCtx()),
      /conflict in main/,
    );

    const entries = readJournalEntries(tmp);
    const failed = entries.find(e => e.eventType === "worktree-merge-failed");
    assert.ok(failed, "worktree-merge-failed event should be emitted");
    assert.equal(failed!.data?.milestoneId, "M001");
    assert.equal(failed!.data?.error, "conflict in main");
  });

  test("journal entries have valid flowId, seq, and ts fields", () => {
    const s = makeSession({ basePath: tmp, originalBasePath: tmp });
    const deps = makeDeps({ shouldUseWorktreeIsolation: () => false });
    const resolver = new WorktreeResolver(s, deps);

    resolver.enterMilestone("M001", makeNotifyCtx());

    const entries = readJournalEntries(tmp);
    assert.ok(entries.length > 0, "at least one entry should exist");
    const entry = entries[0];
    assert.ok(entry.flowId, "flowId should be set");
    assert.ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.flowId),
      "flowId should be a valid UUID",
    );
    assert.equal(entry.seq, 0);
    assert.ok(entry.ts, "ts should be set");
    assert.ok(!isNaN(Date.parse(entry.ts)), "ts should be a valid ISO date");
  });
});
