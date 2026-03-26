/**
 * Edge Case Tests for Park/Discard Milestone Feature
 *
 * Tests critical edge cases:
 * 1. Discard breaks depends_on chain → permanent block
 * 2. Park blocks depends_on chain
 * 3. Discard active, next (no deps) activates
 * 4. Park all + discard all → clean state
 * 5. Discard non-existent → graceful failure
 * 6. Queue order survives discards
 * 7. Circular deps + park interaction
 * 8. Discard milestone that has depends_on on others
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState, invalidateStateCache } from '../state.ts';
import { clearPathCache } from '../paths.ts';
import { parkMilestone, unparkMilestone, discardMilestone } from '../milestone-actions.ts';


function createFixture(): string {
  const b = mkdtempSync(join(tmpdir(), 'gsd-edge-'));
  mkdirSync(join(b, '.gsd', 'milestones'), { recursive: true });
  return b;
}

function createM(b: string, mid: string, opts?: { roadmap?: boolean; summary?: boolean; dependsOn?: string[] }): void {
  const d = join(b, '.gsd', 'milestones', mid);
  mkdirSync(d, { recursive: true });
  if (opts?.dependsOn) {
    writeFileSync(join(d, `${mid}-CONTEXT.md`), `---\ndepends_on: [${opts.dependsOn.join(', ')}]\n---\n# ${mid}`, 'utf-8');
  }
  if (opts?.roadmap) {
    writeFileSync(join(d, `${mid}-ROADMAP.md`), [
      `# ${mid}: Test`,
      '', '## Vision', 'Test',
      '', '## Success Criteria', '- [ ] ok',
      '', '## Slices',
      `- [${opts?.summary ? 'x' : ' '}] **S01: Setup** \`risk:low\` \`depends:[]\``,
      '  - After this: done',
    ].join('\n'), 'utf-8');
  }
  if (opts?.summary) {
    writeFileSync(join(d, `${mid}-SUMMARY.md`), `---\nid: ${mid}\n---\n# Done`, 'utf-8');
  }
}

function clear(): void { clearPathCache(); invalidateStateCache(); }
function cleanup(b: string): void { rmSync(b, { recursive: true, force: true }); }

  // ─── EDGE 1: Discard breaks depends_on → downstream is BLOCKED ────────

describe('park-edge-cases', () => {
test('EDGE 1: Discard breaks depends_on chain', async () => {
    const b = createFixture();
    try {
      createM(b, 'M001', { roadmap: true, summary: true }); // complete
      createM(b, 'M002', { roadmap: true });                 // active
      createM(b, 'M003', { roadmap: true, dependsOn: ['M002'] }); // depends on M002
      clear();

      discardMilestone(b, 'M002');
      const s = await deriveState(b);

      // M003 depends on M002 which no longer exists.
      // M002 is not in completeMilestoneIds → dep is unmet → M003 stays pending
      assert.deepStrictEqual(s.registry.find(e => e.id === 'M003')?.status, 'pending', 'M003 stays pending after dep discarded');
      assert.deepStrictEqual(s.phase, 'blocked', 'system is blocked (unmet dep on deleted milestone)');
      assert.ok(s.blockers.length > 0, 'blockers list is not empty');
    } finally {
      cleanup(b);
    }
});

  // ─── EDGE 2: Park blocks depends_on chain ────────────────────────────
test('EDGE 2: Park blocks depends_on chain', async () => {
    const b = createFixture();
    try {
      createM(b, 'M001', { roadmap: true, summary: true });
      createM(b, 'M002', { roadmap: true });
      createM(b, 'M003', { roadmap: true, dependsOn: ['M002'] });
      clear();

      parkMilestone(b, 'M002', 'testing');
      const s = await deriveState(b);
      assert.deepStrictEqual(s.registry.find(e => e.id === 'M003')?.status, 'pending', 'M003 pending when M002 parked');
      // System should be blocked since M003 deps unmet and M002 is parked
      assert.ok(s.activeMilestone === null, 'no active milestone (M002 parked, M003 dep-blocked)');
    } finally {
      cleanup(b);
    }
});

  // ─── EDGE 3: Discard active, next (no deps) activates ────────────────
test('EDGE 3: Discard active → next activates', async () => {
    const b = createFixture();
    try {
      createM(b, 'M001', { roadmap: true });
      createM(b, 'M002', { roadmap: true }); // no depends_on
      clear();

      discardMilestone(b, 'M001');
      const s = await deriveState(b);
      assert.deepStrictEqual(s.activeMilestone?.id, 'M002', 'M002 becomes active');
      assert.ok(s.phase !== 'blocked', 'not blocked');
    } finally {
      cleanup(b);
    }
});

  // ─── EDGE 4: Park all + discard all → clean pre-planning ─────────────
test('EDGE 4: Park all → discard all → clean state', async () => {
    const b = createFixture();
    try {
      createM(b, 'M001', { roadmap: true });
      createM(b, 'M002', { roadmap: true });
      clear();

      parkMilestone(b, 'M001', 'test');
      parkMilestone(b, 'M002', 'test');
      discardMilestone(b, 'M001');
      discardMilestone(b, 'M002');
      const s = await deriveState(b);
      assert.deepStrictEqual(s.activeMilestone, null, 'no active milestone');
      assert.deepStrictEqual(s.phase, 'pre-planning', 'phase is pre-planning');
      assert.deepStrictEqual(s.registry.length, 0, 'empty registry');
      assert.ok(s.nextAction.includes('No milestones'), 'nextAction mentions no milestones');
    } finally {
      cleanup(b);
    }
});

  // ─── EDGE 5: Discard non-existent → graceful false ───────────────────
test('EDGE 5: Discard non-existent', () => {
    const b = createFixture();
    try {
      const result = discardMilestone(b, 'M999');
      assert.ok(!result, 'returns false for non-existent');
    } finally {
      cleanup(b);
    }
});

  // ─── EDGE 6: Queue order survives discards ───────────────────────────
test('EDGE 6: Queue order after discard', async () => {
    const b = createFixture();
    try {
      createM(b, 'M001', { roadmap: true });
      createM(b, 'M002', { roadmap: true });
      createM(b, 'M003', { roadmap: true });
      writeFileSync(
        join(b, '.gsd', 'QUEUE-ORDER.json'),
        JSON.stringify({ order: ['M003', 'M001', 'M002'], updatedAt: new Date().toISOString() }),
        'utf-8',
      );
      clear();

      // With custom queue order, M003 should be active first
      let s = await deriveState(b);
      assert.deepStrictEqual(s.activeMilestone?.id, 'M003', 'M003 active (custom queue order)');

      // Discard M003 → M001 should be next per queue order
      discardMilestone(b, 'M003');
      s = await deriveState(b);
      assert.deepStrictEqual(s.activeMilestone?.id, 'M001', 'M001 active after M003 discarded');

      // Verify queue order file was updated
      const order = JSON.parse(readFileSync(join(b, '.gsd', 'QUEUE-ORDER.json'), 'utf-8'));
      assert.ok(!order.order.includes('M003'), 'M003 removed from QUEUE-ORDER.json');
    } finally {
      cleanup(b);
    }
});

  // ─── EDGE 7: Discard milestone that has deps on others ───────────────
test('EDGE 7: Discard a milestone that depends on others', async () => {
    const b = createFixture();
    try {
      createM(b, 'M001', { roadmap: true });
      createM(b, 'M002', { roadmap: true, dependsOn: ['M001'] });
      createM(b, 'M003', { roadmap: true }); // no deps
      clear();

      // M002 depends on M001, so M001 is active, M002 is pending
      let s = await deriveState(b);
      assert.deepStrictEqual(s.activeMilestone?.id, 'M001', 'M001 is active');
      assert.deepStrictEqual(s.registry.find(e => e.id === 'M002')?.status, 'pending', 'M002 pending (dep on M001)');

      // Discard M002 (the one WITH deps) — should be fine, M003 becomes pending
      discardMilestone(b, 'M002');
      s = await deriveState(b);
      assert.deepStrictEqual(s.activeMilestone?.id, 'M001', 'M001 still active');
      assert.ok(!s.registry.some(e => e.id === 'M002'), 'M002 gone from registry');
      assert.deepStrictEqual(s.registry.find(e => e.id === 'M003')?.status, 'pending', 'M003 is pending (after M001)');
    } finally {
      cleanup(b);
    }
});

  // ─── EDGE 8: Park → Discard → state transitions ─────────────────────
test('EDGE 8: Park then discard same milestone', async () => {
    const b = createFixture();
    try {
      createM(b, 'M001', { roadmap: true });
      createM(b, 'M002', { roadmap: true });
      clear();

      parkMilestone(b, 'M001', 'temp');
      let s = await deriveState(b);
      assert.deepStrictEqual(s.activeMilestone?.id, 'M002', 'M002 active while M001 parked');

      // Now discard the parked milestone
      discardMilestone(b, 'M001');
      s = await deriveState(b);
      assert.deepStrictEqual(s.activeMilestone?.id, 'M002', 'M002 still active');
      assert.ok(!s.registry.some(e => e.id === 'M001'), 'M001 gone completely');
      assert.deepStrictEqual(s.registry.length, 1, 'only M002 in registry');
    } finally {
      cleanup(b);
    }
});

  // ─── EDGE 9: Complete + parked + pending coexist ─────────────────────
test('EDGE 9: Mixed states — complete + parked + active', async () => {
    const b = createFixture();
    try {
      createM(b, 'M001', { roadmap: true, summary: true }); // complete
      createM(b, 'M002', { roadmap: true });                 // will park
      createM(b, 'M003', { roadmap: true });                 // will be active
      createM(b, 'M004', { roadmap: true });                 // will be pending
      clear();

      parkMilestone(b, 'M002', 'parked');
      const s = await deriveState(b);
      assert.deepStrictEqual(s.registry.find(e => e.id === 'M001')?.status, 'complete', 'M001 complete');
      assert.deepStrictEqual(s.registry.find(e => e.id === 'M002')?.status, 'parked', 'M002 parked');
      assert.deepStrictEqual(s.registry.find(e => e.id === 'M003')?.status, 'active', 'M003 active');
      assert.deepStrictEqual(s.registry.find(e => e.id === 'M004')?.status, 'pending', 'M004 pending');
      assert.deepStrictEqual(s.activeMilestone?.id, 'M003', 'M003 is the active milestone');
      assert.deepStrictEqual(s.progress?.milestones.done, 1, '1 done');
      assert.deepStrictEqual(s.progress?.milestones.total, 4, '4 total');
    } finally {
      cleanup(b);
    }
});

});

