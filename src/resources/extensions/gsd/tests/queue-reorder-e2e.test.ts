/**
 * End-to-end integration tests for the Queue Reorder feature.
 *
 * Verifies the full chain: QUEUE-ORDER.json + findMilestoneIds() + deriveState()
 * + depends_on removal from CONTEXT.md files.
 *
 * These tests simulate what happens when a user reorders milestones and confirms:
 * 1. QUEUE-ORDER.json is written with the new order
 * 2. depends_on is removed from CONTEXT.md frontmatter
 * 3. deriveState() picks the correct milestone as active
 * 4. A fresh deriveState() call (simulating new session) also works
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState, invalidateStateCache } from '../state.ts';
import { findMilestoneIds } from '../guided-flow.ts';
import { saveQueueOrder, loadQueueOrder } from '../queue-order.ts';
import { parseContextDependsOn } from '../files.ts';
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-reorder-e2e-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function writeMilestoneDir(base: string, mid: string): void {
  mkdirSync(join(base, '.gsd', 'milestones', mid), { recursive: true });
}

function writeContext(base: string, mid: string, frontmatter: string, body: string = ''): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  const fm = frontmatter ? `---\n${frontmatter}\n---\n\n` : '';
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), `${fm}# ${mid}: Test\n\n${body}`);
}

function writeCompleteMilestone(base: string, mid: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), `# ${mid}: Complete

**Vision:** Done.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), `# ${mid} Summary\n\nComplete.`);
}

function readContextFile(base: string, mid: string): string {
  return readFileSync(join(base, '.gsd', 'milestones', mid, `${mid}-CONTEXT.md`), 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Queue order changes milestone activation
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== E2E: queue-order changes active milestone ===');
{
  const base = createFixtureBase();
  try {
    // Setup: M007 complete, M008 and M009 pending (no context, no roadmap)
    writeCompleteMilestone(base, 'M007');
    writeMilestoneDir(base, 'M008');
    writeContext(base, 'M008', '', 'Multi-Session Parallel Orchestration');
    writeMilestoneDir(base, 'M009');
    writeContext(base, 'M009', '', 'Context-Budget Visibility');

    // Without custom order: M008 comes first (numeric sort)
    invalidateStateCache();
    const stateBefore = await deriveState(base);
    assertEq(stateBefore.activeMilestone?.id, 'M008', 'before reorder: M008 is active');

    // Save custom order: M009 before M008
    saveQueueOrder(base, ['M009', 'M008']);

    // With custom order: M009 should be active
    invalidateStateCache();
    const stateAfter = await deriveState(base);
    assertEq(stateAfter.activeMilestone?.id, 'M009', 'after reorder: M009 is active');

    // findMilestoneIds respects the order
    const ids = findMilestoneIds(base);
    const m008Idx = ids.indexOf('M008');
    const m009Idx = ids.indexOf('M009');
    assertTrue(m009Idx < m008Idx, 'findMilestoneIds: M009 comes before M008');

  } finally {
    cleanup(base);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Reorder + depends_on removal = correct state
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== E2E: reorder with depends_on removal ===');
{
  const base = createFixtureBase();
  try {
    // Setup: M007 complete, M008 depends_on M009, M009 no deps
    writeCompleteMilestone(base, 'M007');
    writeContext(base, 'M008', 'depends_on: [M009]', 'Multi-Session Parallel');
    writeContext(base, 'M009', '', 'Context-Budget Visibility');

    // Before: M008 depends on M009, so deriveState skips M008, M009 is active
    invalidateStateCache();
    const stateBefore = await deriveState(base);
    assertEq(stateBefore.activeMilestone?.id, 'M009', 'before: M009 active (M008 dep-blocked)');

    // Simulate reorder confirm: save order M009→M008, remove depends_on from M008
    saveQueueOrder(base, ['M009', 'M008']);

    // Remove depends_on from M008-CONTEXT.md (simulating what handleQueueReorder does)
    const contextContent = readContextFile(base, 'M008');
    const newContent = contextContent.replace(/---\ndepends_on: \[M009\]\n---\n\n/, '');
    writeFileSync(join(base, '.gsd', 'milestones', 'M008', 'M008-CONTEXT.md'), newContent);

    // Verify: depends_on is gone
    const updatedContent = readContextFile(base, 'M008');
    const deps = parseContextDependsOn(updatedContent);
    assertEq(deps.length, 0, 'depends_on removed from M008-CONTEXT.md');

    // Verify: deriveState still picks M009 (it's first in queue order)
    invalidateStateCache();
    const stateAfter = await deriveState(base);
    assertEq(stateAfter.activeMilestone?.id, 'M009', 'after: M009 still active (first in queue)');

    // Verify: M008 is now pending (not dep-blocked)
    const m008Entry = stateAfter.registry.find(m => m.id === 'M008');
    assertEq(m008Entry?.status, 'pending', 'M008 is pending (not dep-blocked)');
    assertTrue(!m008Entry?.dependsOn || m008Entry.dependsOn.length === 0, 'M008 has no dependsOn');

  } finally {
    cleanup(base);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Fresh deriveState (simulating new session) respects queue order
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== E2E: fresh session respects queue order ===');
{
  const base = createFixtureBase();
  try {
    writeCompleteMilestone(base, 'M007');
    writeContext(base, 'M008', '', 'Parallel Orchestration');
    writeContext(base, 'M009', '', 'Budget Visibility');

    // Save queue order
    saveQueueOrder(base, ['M009', 'M008']);

    // Simulate fresh session — invalidate all caches
    invalidateStateCache();

    // Derive state — should read QUEUE-ORDER.json from disk
    const state = await deriveState(base);
    assertEq(state.activeMilestone?.id, 'M009', 'fresh session: M009 is active');

    // Verify queue order persisted
    const order = loadQueueOrder(base);
    assertEq(order, ['M009', 'M008'], 'QUEUE-ORDER.json persisted correctly');

  } finally {
    cleanup(base);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Queue order with newly added milestones
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== E2E: new milestones appended to queue ===');
{
  const base = createFixtureBase();
  try {
    writeCompleteMilestone(base, 'M007');
    writeContext(base, 'M008', '', 'Parallel');
    writeContext(base, 'M009', '', 'Visibility');

    // Custom order only has M009, M008
    saveQueueOrder(base, ['M009', 'M008']);

    // Add M010 (not in queue order)
    writeContext(base, 'M010', '', 'New feature');

    invalidateStateCache();
    const ids = findMilestoneIds(base);

    // M009 first, M008 second, M010 appended at end
    const m009Idx = ids.indexOf('M009');
    const m008Idx = ids.indexOf('M008');
    const m010Idx = ids.indexOf('M010');
    assertTrue(m009Idx < m008Idx, 'M009 before M008');
    assertTrue(m008Idx < m010Idx, 'M008 before M010 (new milestone appended)');

    // M009 is still active (first non-complete in queue order)
    const state = await deriveState(base);
    assertEq(state.activeMilestone?.id, 'M009', 'M009 still active after M010 added');

  } finally {
    cleanup(base);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: No queue order file = default numeric sort (backward compat)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== E2E: backward compat without QUEUE-ORDER.json ===');
{
  const base = createFixtureBase();
  try {
    writeCompleteMilestone(base, 'M007');
    writeContext(base, 'M008', '', 'Parallel');
    writeContext(base, 'M009', '', 'Visibility');

    // No QUEUE-ORDER.json — default numeric sort
    invalidateStateCache();
    const state = await deriveState(base);
    assertEq(state.activeMilestone?.id, 'M008', 'no queue order: M008 active (numeric)');

    const ids = findMilestoneIds(base);
    assertTrue(ids.indexOf('M008') < ids.indexOf('M009'), 'default sort: M008 before M009');

  } finally {
    cleanup(base);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: depends_on inline array format removal
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== E2E: depends_on inline format preserved after partial removal ===');
{
  const base = createFixtureBase();
  try {
    writeCompleteMilestone(base, 'M007');
    // M008 depends on both M009 and M010
    writeContext(base, 'M008', 'depends_on: [M009, M010]', 'Parallel');
    writeContext(base, 'M009', '', 'Visibility');
    writeContext(base, 'M010', '', 'Other');

    // Verify both deps are parsed
    const contentBefore = readContextFile(base, 'M008');
    const depsBefore = parseContextDependsOn(contentBefore);
    assertEq(depsBefore.length, 2, 'M008 has 2 deps before');

    // Simulate removing only M009 dep (keep M010)
    const content = readContextFile(base, 'M008');
    const updated = content.replace('depends_on: [M009, M010]', 'depends_on: [M010]');
    writeFileSync(join(base, '.gsd', 'milestones', 'M008', 'M008-CONTEXT.md'), updated);

    // Verify only M010 remains
    const contentAfter = readContextFile(base, 'M008');
    const depsAfter = parseContextDependsOn(contentAfter);
    assertEq(depsAfter.length, 1, 'M008 has 1 dep after removal');
    assertEq(depsAfter[0], 'M010', 'remaining dep is M010');

  } finally {
    cleanup(base);
  }
}

report();
