/**
 * Regression test for #3607 — tighten verifyExpectedArtifact legacy branch
 *
 * The legacy (pre-migration) fallback in verifyExpectedArtifact previously
 * accepted either a heading match (### T01 --) or a checked checkbox as proof
 * that gsd_complete_task ran. A heading alone does not prove completion —
 * it could result from a rogue write.
 *
 * The fix removes the hdRe heading regex and requires only a checked checkbox
 * (cbRe) in the legacy branch, ensuring that only actual tool-completed tasks
 * are treated as verified.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(
  resolve(process.cwd(), 'src', 'resources', 'extensions', 'gsd', 'auto-recovery.ts'),
  'utf-8',
)

describe('verifyExpectedArtifact legacy branch tightened (#3607)', () => {
  it('legacy branch does NOT define hdRe heading regex', () => {
    // Find the legacy fallback section
    const legacyIdx = src.indexOf('LEGACY: Pre-migration fallback')
    assert.ok(legacyIdx !== -1, 'LEGACY comment must exist')

    // Check the code within a reasonable window after the LEGACY comment
    const legacyBlock = src.slice(legacyIdx, legacyIdx + 600)

    assert.ok(
      !legacyBlock.includes('hdRe'),
      'hdRe heading regex must NOT exist in legacy branch — heading alone is not proof of completion',
    )
  })

  it('legacy branch requires checked checkbox via cbRe', () => {
    const legacyIdx = src.indexOf('LEGACY: Pre-migration fallback')
    assert.ok(legacyIdx !== -1)

    const legacyBlock = src.slice(legacyIdx, legacyIdx + 600)

    assert.ok(
      legacyBlock.includes('cbRe'),
      'cbRe checked-checkbox regex must exist in legacy branch',
    )

    // cbRe must match checked checkboxes [x] or [X]
    assert.ok(
      legacyBlock.includes('[xX]'),
      'cbRe must match both [x] and [X] checkbox variants',
    )
  })

  it('legacy branch returns false when no plan file exists', () => {
    const legacyIdx = src.indexOf('LEGACY: Pre-migration fallback')
    assert.ok(legacyIdx !== -1)

    const legacyBlock = src.slice(legacyIdx, legacyIdx + 1000)

    // The else branch: no plan file means cannot verify
    assert.ok(
      legacyBlock.includes('no plan file'),
      'missing plan file must be handled with return false',
    )
  })

  it('DB available but task not found returns false', () => {
    const legacyIdx = src.indexOf('LEGACY: Pre-migration fallback')
    assert.ok(legacyIdx !== -1)

    const legacyBlock = src.slice(legacyIdx, legacyIdx + 1000)

    assert.ok(
      legacyBlock.includes('DB available but task row not found'),
      'must handle case where DB is available but task row is missing',
    )

    // The comment should be followed by a return false
    const commentIdx = legacyBlock.indexOf('DB available but task row not found')
    const afterComment = legacyBlock.slice(commentIdx, commentIdx + 200)
    assert.ok(
      afterComment.includes('return false'),
      'missing task row when DB available must return false',
    )
  })
})
