/**
 * Regression test for #3470: DB-backed active milestone selection must not
 * prefer a stale queued shell over the real active milestone.
 *
 * Scenario: M068 is a queued placeholder (DB row, no files, no slices).
 * M070 is the real active milestone (context, roadmap, slices, tasks).
 * deriveStateFromDb() must select M070 as active, not M068.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from "../gsd-db.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-stale-milestone-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("stale queued milestone selection (#3470)", () => {
  let base: string;

  afterEach(() => {
    closeDatabase();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("queued shell with no content does not block real active milestone", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M068: queued shell — DB row exists, no files, no slices
    insertMilestone({ id: "M068", title: "Queued Shell", status: "queued" });

    // M070: real active milestone — context, roadmap, slices, tasks
    insertMilestone({ id: "M070", title: "Real Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M070", title: "Slice One", status: "active", risk: "low", depends: [] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M070", title: "Task One", status: "pending" });

    writeFile(base, "milestones/M070/M070-CONTEXT.md", "# M070: Real Active\n\nThis is the real milestone.");
    writeFile(base, "milestones/M070/M070-ROADMAP.md", "# M070: Real Active\n\n## Slices\n\n- [ ] **S01: Slice One**");
    writeFile(base, "milestones/M070/slices/S01/S01-PLAN.md", "# S01: Slice One\n\n## Tasks\n\n- [ ] **T01: Task One**");

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M070", "Active milestone must be M070, not queued shell M068");

    // M068 should appear as pending in registry, not active
    const m068Entry = state.registry.find((e: any) => e.id === "M068");
    assert.ok(m068Entry, "M068 should still appear in registry");
    assert.equal(m068Entry!.status, "pending", "M068 should be pending, not active");

    // M070 should be active in registry
    const m070Entry = state.registry.find((e: any) => e.id === "M070");
    assert.ok(m070Entry, "M070 should appear in registry");
    assert.equal(m070Entry!.status, "active", "M070 should be active in registry");
  });

  test("queued milestone WITH context file can still be selected as active", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M068: queued but has context (discussion started) — should be activatable
    insertMilestone({ id: "M068", title: "Queued With Context", status: "queued" });
    writeFile(base, "milestones/M068/M068-CONTEXT.md", "# M068: Queued With Context\n\nDiscussion started.");

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M068", "Queued milestone with context should become active");
  });

  test("queued milestone WITH context-draft can still be selected as active", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M068: queued but has draft (discussion in progress)
    insertMilestone({ id: "M068", title: "Queued With Draft", status: "queued" });
    writeFile(base, "milestones/M068/M068-CONTEXT-DRAFT.md", "# M068: Queued With Draft\n\nDraft in progress.");

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M068", "Queued milestone with draft should become active");
  });

  test("queued milestone WITH slices can still be selected as active", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M068: queued but has slices (planning started)
    insertMilestone({ id: "M068", title: "Queued With Slices", status: "queued" });
    insertSlice({ id: "S01", milestoneId: "M068", title: "Slice One", status: "pending", risk: "low", depends: [] });
    writeFile(base, "milestones/M068/M068-ROADMAP.md", "# M068\n\n## Slices\n\n- [ ] **S01: Slice One**");

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M068", "Queued milestone with slices should become active");
  });

  test("multiple queued shells all skipped in favor of real active", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // Three queued shells before the real milestone
    insertMilestone({ id: "M065", title: "Shell 1", status: "queued" });
    insertMilestone({ id: "M066", title: "Shell 2", status: "queued" });
    insertMilestone({ id: "M068", title: "Shell 3", status: "queued" });

    // M070: real active
    insertMilestone({ id: "M070", title: "Real Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M070", title: "Slice One", status: "active", risk: "low", depends: [] });
    writeFile(base, "milestones/M070/M070-CONTEXT.md", "# M070: Real Active");
    writeFile(base, "milestones/M070/M070-ROADMAP.md", "# M070\n\n## Slices\n\n- [ ] **S01: Slice One**");

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M070", "Must skip all queued shells to reach M070");

    // All shells should be pending
    for (const id of ["M065", "M066", "M068"]) {
      const entry = state.registry.find((e: any) => e.id === id);
      assert.ok(entry, `${id} should be in registry`);
      assert.equal(entry!.status, "pending", `${id} should be pending, not active`);
    }
  });
});
