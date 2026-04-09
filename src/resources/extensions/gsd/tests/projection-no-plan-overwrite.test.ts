/**
 * Regression test for #3651 — renderAllProjections must NOT call renderPlanProjection
 *
 * renderAllProjections previously called renderPlanProjection inside the slice
 * loop, which overwrote the authoritative PLAN.md (produced by markdown-renderer.js
 * in plan-slice/replan-slice tools) with a simplified projection that was missing
 * key sections (Must-Haves, Verification, Files Likely Touched) and corrupted
 * multi-line task descriptions.
 *
 * The fix removes the renderPlanProjection call from the renderAllProjections
 * loop. The renderIfMissing recovery path is preserved.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Use process.cwd() based resolution instead of import.meta.url
// to avoid tsx test runner path resolution issues
const src = readFileSync(
  resolve(process.cwd(), 'src', 'resources', 'extensions', 'gsd', 'workflow-projections.ts'),
  'utf-8',
)

describe('renderAllProjections must not overwrite PLAN.md (#3651)', () => {
  it('renderAllProjections function body does NOT invoke renderPlanProjection', () => {
    // Extract the renderAllProjections function body
    const fnStart = src.indexOf('export async function renderAllProjections(')
    assert.ok(fnStart !== -1, 'renderAllProjections function must exist')

    // Find the for-loop over sliceRows inside renderAllProjections
    const loopStart = src.indexOf('for (const slice of sliceRows)', fnStart)
    assert.ok(loopStart !== -1, 'slice loop must exist in renderAllProjections')

    // Find the closing of renderAllProjections (next section marker)
    const fnEnd = src.indexOf('\n// ─── ', fnStart + 1)
    assert.ok(fnEnd !== -1, 'section delimiter after renderAllProjections must exist')

    const fnBody = src.slice(loopStart, fnEnd)

    // The fix: renderPlanProjection must NOT appear as a function call.
    // Strip comment lines before checking (comments may mention the function name).
    const codeOnly = fnBody
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n')

    const hasPlanCall = /renderPlanProjection\s*\(/.test(codeOnly)
    assert.equal(
      hasPlanCall,
      false,
      'renderPlanProjection must not be called inside the renderAllProjections slice loop — ' +
        'authoritative PLAN.md is rendered only by plan-slice/replan-slice tools',
    )
  })

  it('renderPlanProjection is still defined (available for regenerateIfMissing)', () => {
    assert.ok(
      src.includes('function renderPlanProjection('),
      'renderPlanProjection function definition must still exist for on-demand recovery',
    )
  })

  it('renderAllProjections still renders ROADMAP, SUMMARY, and STATE projections', () => {
    const fnStart = src.indexOf('export async function renderAllProjections(')
    const fnEnd = src.indexOf('\n// ─── ', fnStart + 1)
    const fnBody = src.slice(fnStart, fnEnd)

    assert.ok(
      fnBody.includes('renderRoadmapProjection('),
      'renderRoadmapProjection must still be called',
    )
    assert.ok(
      fnBody.includes('renderSummaryProjection('),
      'renderSummaryProjection must still be called',
    )
    assert.ok(
      fnBody.includes('renderStateProjection('),
      'renderStateProjection must still be called',
    )
  })
})
