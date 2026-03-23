/**
 * Tests for `gsd headless query` — single JSON snapshot command.
 *
 * Validates that the snapshot contains state, next dispatch preview,
 * and parallel worker costs in one response.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { handleQuery } from '../../../../headless-query.ts'
import type { QuerySnapshot } from '../../../../headless-query.ts'
import { invalidateStateCache } from '../state.ts'

// ─── Fixture Helpers ────────────────────────────────────────────────────────

function createFixture(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-query-test-'))
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true })
  return base
}

function writeRoadmap(base: string, mid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content)
}

function writeContext(base: string, mid: string): void {
  const dir = join(base, '.gsd', 'milestones', mid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), `---\ntitle: Test Milestone\n---\n\n# Context\nTest.`)
}

function writeSlicePlan(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid)
  mkdirSync(join(dir, 'tasks'), { recursive: true })
  writeFileSync(join(dir, `${sid}-PLAN.md`), content)
}

function writeTaskPlan(base: string, mid: string, sid: string, tid: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid, 'tasks')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${tid}-PLAN.md`), `---\nestimated_steps: 3\nestimated_files: 2\n---\n\n# ${tid}: Test Task\nDo something.`)
}

function writeParallelStatus(base: string, mid: string, cost: number): void {
  const dir = join(base, '.gsd', 'parallel')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${mid}.status.json`), JSON.stringify({
    milestoneId: mid,
    pid: process.pid,
    state: 'running',
    currentUnit: { type: 'execute-task', id: `${mid}/S01/T01`, startedAt: Date.now() },
    cost,
    lastHeartbeat: Date.now(),
    startedAt: Date.now() - 60_000,
    worktreePath: `/tmp/worktrees/${mid}`,
  }))
}

function createExecutingFixture(base: string): void {
  writeContext(base, 'M001')
  writeRoadmap(base, 'M001', `# M001: Test Milestone

**Vision:** Build something.

## Slices

- [ ] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > After this: The first slice works.
`)
  writeSlicePlan(base, 'M001', 'S01', `# S01: First Slice

**Goal:** Implement something.
**Demo:** It works.

## Tasks

- [ ] **T01: First Task** — Do the first thing
  - Files: foo.ts
  - Verify: run tests
- [ ] **T02: Second Task** — Do the second thing
  - Files: bar.ts
`)
  writeTaskPlan(base, 'M001', 'S01', 'T01')
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('headless query', () => {
  let base: string

  beforeEach(() => {
    base = createFixture()
    invalidateStateCache()
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('returns snapshot with state, next, and cost', async () => {
    createExecutingFixture(base)
    const result = await handleQuery(base)
    const snap = result.data as QuerySnapshot

    assert.equal(result.exitCode, 0)
    // state
    assert.equal(snap.state.phase, 'executing')
    assert.equal(snap.state.activeMilestone!.id, 'M001')
    assert.equal(snap.state.activeSlice!.id, 'S01')
    assert.equal(snap.state.activeTask!.id, 'T01')
    assert.ok(Array.isArray(snap.state.registry))
    assert.ok(snap.state.progress)
    // next
    assert.equal(snap.next.action, 'dispatch')
    assert.equal(snap.next.unitType, 'execute-task')
    assert.ok(snap.next.unitId)
    // cost (no parallel workers)
    assert.equal(snap.cost.workers.length, 0)
    assert.equal(snap.cost.total, 0)
  })

  it('returns stop when no milestones exist', async () => {
    const result = await handleQuery(base)
    const snap = result.data as QuerySnapshot

    assert.equal(result.exitCode, 0)
    assert.equal(snap.state.phase, 'pre-planning')
    assert.equal(snap.state.activeMilestone, null)
    assert.equal(snap.next.action, 'stop')
    assert.ok(snap.next.reason)
  })

  it('aggregates parallel worker costs', async () => {
    createExecutingFixture(base)
    writeParallelStatus(base, 'M001', 1.50)
    writeParallelStatus(base, 'M002', 2.75)
    const result = await handleQuery(base)
    const snap = result.data as QuerySnapshot

    assert.equal(snap.cost.workers.length, 2)
    assert.equal(snap.cost.total, 4.25)
    assert.ok(snap.cost.workers.some(w => w.milestoneId === 'M001' && w.cost === 1.50))
    assert.ok(snap.cost.workers.some(w => w.milestoneId === 'M002' && w.cost === 2.75))
  })

  it('shows dispatch preview for pre-planning with context', async () => {
    writeContext(base, 'M001')
    const result = await handleQuery(base)
    const snap = result.data as QuerySnapshot

    assert.equal(snap.state.phase, 'pre-planning')
    assert.equal(snap.state.activeMilestone!.id, 'M001')
    assert.equal(snap.next.action, 'dispatch')
  })

  it('reports all milestones complete with a clean stop reason', async () => {
    writeRoadmap(base, 'M001', `# M001: Test Milestone

## Slices

- [x] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > Done.
`)
    writeFileSync(
      join(base, '.gsd', 'milestones', 'M001', 'M001-SUMMARY.md'),
      '# M001 Summary\n\nComplete.',
    )

    const result = await handleQuery(base)
    const snap = result.data as QuerySnapshot

    assert.equal(result.exitCode, 0)
    assert.equal(snap.state.phase, 'complete')
    assert.equal(snap.next.action, 'stop')
    assert.equal(snap.next.reason, 'All milestones complete.')
  })
})
