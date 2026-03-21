// milestone-id-reservation — Verifies that preview IDs from guided-flow
// match the IDs claimed by gsd_generate_milestone_id via the shared
// reservation mechanism in milestone-ids.ts.
//
// Regression test for #1569.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextMilestoneId,
  reserveMilestoneId,
  claimReservedId,
  getReservedMilestoneIds,
  clearReservedMilestoneIds,
} from '../milestone-ids.ts';

describe('milestone ID reservation (#1569)', () => {
  beforeEach(() => {
    clearReservedMilestoneIds();
  });

  it('claimReservedId returns undefined when nothing is reserved', () => {
    assert.equal(claimReservedId(), undefined);
  });

  it('reserved ID is returned by claimReservedId and removed from the set', () => {
    const id = nextMilestoneId([], true);
    reserveMilestoneId(id);

    assert.equal(getReservedMilestoneIds().size, 1);
    assert.equal(claimReservedId(), id);
    assert.equal(getReservedMilestoneIds().size, 0);
    // Second claim returns undefined
    assert.equal(claimReservedId(), undefined);
  });

  it('reserved IDs are visible in getReservedMilestoneIds', () => {
    reserveMilestoneId('M001-abc123');
    reserveMilestoneId('M002-def456');
    const reserved = getReservedMilestoneIds();
    assert.equal(reserved.size, 2);
    assert.ok(reserved.has('M001-abc123'));
    assert.ok(reserved.has('M002-def456'));
  });

  it('clearReservedMilestoneIds empties the set', () => {
    reserveMilestoneId('M001-abc123');
    clearReservedMilestoneIds();
    assert.equal(getReservedMilestoneIds().size, 0);
  });

  it('nextMilestoneId accounts for reserved IDs in sequence numbering', () => {
    // Simulate: guided-flow previews M001, reserves it
    const existing: string[] = [];
    const preview = nextMilestoneId(existing, true);
    assert.match(preview, /^M001-/);
    reserveMilestoneId(preview);

    // Now generate the next one accounting for reservations
    const allIds = [...new Set([...existing, ...getReservedMilestoneIds()])];
    const second = nextMilestoneId(allIds, true);
    assert.match(second, /^M002-/);
  });

  it('claim returns IDs in insertion order (FIFO)', () => {
    reserveMilestoneId('M001-aaa111');
    reserveMilestoneId('M002-bbb222');
    assert.equal(claimReservedId(), 'M001-aaa111');
    assert.equal(claimReservedId(), 'M002-bbb222');
    assert.equal(claimReservedId(), undefined);
  });
});
