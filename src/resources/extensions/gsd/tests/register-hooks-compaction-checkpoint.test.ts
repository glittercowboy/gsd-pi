import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import { parseContinue } from "../files.ts";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { autoSession } from "../auto-runtime-state.ts";

function createPlanningFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-compact-checkpoint-"));
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });

  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    `# M001: Test Milestone

**Vision:** Validate compaction checkpointing.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice is done.
`,
  );

  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    `# S01: Test Slice

**Goal:** Validate planning checkpoint.
**Demo:** Checkpoint exists after compaction.

## Tasks
`,
  );

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active", risk: "low", depends: [] });
  closeDatabase();

  return base;
}

test("register-hooks writes CONTINUE checkpoint during planning phase without active task (#4258)", async (t) => {
  const base = createPlanningFixtureBase();
  const originalCwd = process.cwd();
  process.chdir(base);
  invalidateStateCache();
  closeDatabase();

  t.after(() => {
    invalidateStateCache();
    closeDatabase();
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });

  const state = await deriveState(base);
  assert.equal(state.phase, "planning", "fixture should derive planning phase");
  assert.equal(state.activeMilestone?.id, "M001", "fixture should have active milestone");
  assert.equal(state.activeSlice?.id, "S01", "fixture should have active slice");
  assert.equal(state.activeTask, null, "fixture should have no active task");

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  const compactHandlers = handlers.get("session_before_compact");
  assert.ok(compactHandlers && compactHandlers.length > 0, "session_before_compact handler should be registered");

  for (const handler of compactHandlers ?? []) {
    await handler({});
  }

  const continuePath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-CONTINUE.md");
  assert.ok(existsSync(continuePath), "compaction should create slice CONTINUE checkpoint");

  const parsed = parseContinue(readFileSync(continuePath, "utf-8"));
  assert.equal(parsed.frontmatter.milestone, "M001");
  assert.equal(parsed.frontmatter.slice, "S01");
  assert.equal(parsed.frontmatter.task, "none", "planning checkpoint should use non-task placeholder");
  assert.equal(parsed.frontmatter.status, "compacted");
  assert.match(parsed.completedWork, /planning phase/i, "completed-work should capture non-executing phase context");
  assert.match(parsed.nextAction, /slice S01/i, "next action should route resume to the active slice");
});

test("register-hooks writes CONTINUE checkpoint AND allows compaction while auto-mode is active", async (t) => {
  const base = createPlanningFixtureBase();
  const originalCwd = process.cwd();
  process.chdir(base);
  invalidateStateCache();
  closeDatabase();

  const wasActive = autoSession.active;
  autoSession.active = true;

  t.after(() => {
    autoSession.active = wasActive;
    invalidateStateCache();
    closeDatabase();
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  const compactHandlers = handlers.get("session_before_compact");
  assert.ok(compactHandlers && compactHandlers.length > 0, "session_before_compact handler should be registered");

  const results: Array<unknown> = [];
  for (const handler of compactHandlers ?? []) {
    results.push(await handler({}));
  }

  for (const r of results) {
    assert.notDeepStrictEqual(
      r,
      { cancel: true },
      "auto-mode must NOT cancel compaction — that path causes silent session death",
    );
    if (r && typeof r === "object" && "cancel" in (r as Record<string, unknown>)) {
      assert.notEqual((r as { cancel?: unknown }).cancel, true, "no handler may return cancel:true under auto-mode");
    }
  }

  const continuePath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-CONTINUE.md");
  assert.ok(existsSync(continuePath), "auto-active compaction must still write the CONTINUE checkpoint");

  const parsed = parseContinue(readFileSync(continuePath, "utf-8"));
  assert.equal(parsed.frontmatter.status, "compacted");
  assert.equal(parsed.frontmatter.milestone, "M001");
  assert.equal(parsed.frontmatter.slice, "S01");
});
