/**
 * Regression test for #3641 — syncWorktreeStateBack skips current milestone
 *
 * When syncing worktree state back to main, the current milestone being
 * merged should be skipped. Its files are already in the milestone branch
 * and copying them back would conflict with the squash merge.
 *
 * The fix adds a `mid === milestoneId` skip guard inside the milestone
 * iteration loop in syncWorktreeStateBack.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractSourceRegion } from "./test-helpers.ts";

const src = readFileSync(
  resolve(process.cwd(), 'src', 'resources', 'extensions', 'gsd', 'auto-worktree.ts'),
  'utf-8',
)

describe('syncWorktreeStateBack skips current milestone (#3641)', () => {
  it('syncWorktreeStateBack function exists', () => {
    assert.ok(
      src.includes('function syncWorktreeStateBack('),
      'syncWorktreeStateBack function must be defined',
    )
  })

  it('mid === milestoneId skip guard exists in the milestone loop', () => {
    // Find syncWorktreeStateBack
    const fnStart = src.indexOf('function syncWorktreeStateBack(')
    assert.ok(fnStart !== -1)

    // Get a reasonable portion of the function
    const fnBlock = extractSourceRegion(src, 'function syncWorktreeStateBack(', { fromIdx: fnStart })

    // Find the for loop iterating milestones
    const loopIdx = fnBlock.indexOf('for (const mid of wtMilestones)')
    assert.ok(loopIdx !== -1, 'milestone iteration loop must exist')

    // After the loop, there should be the skip guard
    const loopBody = extractSourceRegion(fnBlock, 'for (const mid of wtMilestones)', { fromIdx: loopIdx })
    assert.ok(
      loopBody.includes('mid === milestoneId'),
      'mid === milestoneId skip guard must exist inside the milestone loop',
    )
    assert.ok(
      loopBody.includes('continue'),
      'skip guard must use continue to skip the current milestone',
    )
  })

  it('syncMilestoneDir is still called for non-current milestones', () => {
    const fnStart = src.indexOf('function syncWorktreeStateBack(')
    assert.ok(fnStart !== -1)

    const fnBlock = extractSourceRegion(src, 'function syncWorktreeStateBack(', { fromIdx: fnStart })

    assert.ok(
      fnBlock.includes('syncMilestoneDir('),
      'syncMilestoneDir must still be called for other milestones',
    )
  })
})
