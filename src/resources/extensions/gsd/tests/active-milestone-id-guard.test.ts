/**
 * Regression test for #2773 — activeMilestone.id guard
 *
 * When activeMilestone is a non-null object with `id: undefined` (corrupted
 * state), the old `!state.activeMilestone` truthiness check passed through,
 * causing a downstream crash when code assumed `.id` was a valid string.
 *
 * The fix uses optional chaining (`!state.activeMilestone?.id`) so all three
 * "no usable milestone" shapes are caught:
 *   1. activeMilestone === null
 *   2. activeMilestone === undefined
 *   3. activeMilestone === { id: undefined, title: "..." }
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { GSDState, ActiveRef } from '../types.ts'

// ─── Guard Under Test ────────────────────────────────────────────────────────
// Extracted guard logic identical to headless-query.ts (line 74) and
// guided-flow.ts (lines 522, 1047).

function activeMilestoneIsUsable(activeMilestone: ActiveRef | null | undefined): boolean {
  return !!activeMilestone?.id
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('activeMilestone?.id guard (#2773)', () => {
  it('rejects null activeMilestone', () => {
    assert.equal(activeMilestoneIsUsable(null), false)
  })

  it('rejects undefined activeMilestone', () => {
    assert.equal(activeMilestoneIsUsable(undefined), false)
  })

  it('rejects malformed activeMilestone with id: undefined', () => {
    // This is the crash case from #2773 — object exists but id is undefined
    const malformed = { id: undefined, title: 'Ghost Milestone' } as unknown as ActiveRef
    assert.equal(activeMilestoneIsUsable(malformed), false)
  })

  it('rejects malformed activeMilestone with id: empty string', () => {
    const malformed = { id: '', title: 'Empty ID Milestone' } as unknown as ActiveRef
    assert.equal(activeMilestoneIsUsable(malformed), false)
  })

  it('accepts valid activeMilestone with a real id', () => {
    const valid: ActiveRef = { id: 'M001', title: 'Real Milestone' }
    assert.equal(activeMilestoneIsUsable(valid), true)
  })
})

describe('headless-query stop behavior with corrupted milestone', () => {
  // Simulates the decision logic from handleQuery (headless-query.ts:74-78)
  function deriveNextAction(activeMilestone: ActiveRef | null | undefined, phase: string) {
    if (!activeMilestone?.id) {
      return {
        action: 'stop' as const,
        reason: phase === 'complete' ? 'All milestones complete.' : 'No active milestone.',
      }
    }
    return { action: 'dispatch' as const, unitId: activeMilestone.id }
  }

  it('returns stop when activeMilestone is null', () => {
    const result = deriveNextAction(null, 'pre-planning')
    assert.equal(result.action, 'stop')
  })

  it('returns stop when activeMilestone has undefined id', () => {
    const corrupted = { id: undefined, title: 'Corrupted' } as unknown as ActiveRef
    const result = deriveNextAction(corrupted, 'executing')
    assert.equal(result.action, 'stop')
    assert.equal(result.reason, 'No active milestone.')
  })

  it('returns dispatch with valid milestone id', () => {
    const valid: ActiveRef = { id: 'M001', title: 'Valid' }
    const result = deriveNextAction(valid, 'executing')
    assert.equal(result.action, 'dispatch')
  })

  it('returns correct stop reason when phase is complete', () => {
    const result = deriveNextAction(null, 'complete')
    assert.equal(result.action, 'stop')
    assert.equal(result.reason, 'All milestones complete.')
  })
})
