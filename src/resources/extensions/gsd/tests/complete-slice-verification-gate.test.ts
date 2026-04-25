/**
 * Regression test for #3580 — complete-slice verification gate
 *
 * Without the gate, a prompt regression could silently advance a blocked
 * or failed slice to "complete" status. The fix adds a BLOCKED_SIGNALS
 * regex that rejects completion when verification/UAT content clearly
 * indicates blocked or failed state.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractSourceRegion } from "./test-helpers.ts";

const src = readFileSync(
  resolve(process.cwd(), 'src', 'resources', 'extensions', 'gsd', 'tools', 'complete-slice.ts'),
  'utf-8',
)

describe('complete-slice verification gate (#3580)', () => {
  it('BLOCKED_SIGNALS regex is defined', () => {
    assert.ok(
      src.includes('BLOCKED_SIGNALS'),
      'BLOCKED_SIGNALS constant must be defined in complete-slice.ts',
    )
  })

  it('BLOCKED_SIGNALS is a regex that tests verification content', () => {
    // Extract the BLOCKED_SIGNALS definition line
    const idx = src.indexOf('BLOCKED_SIGNALS')
    assert.ok(idx !== -1)
    const lineEnd = src.indexOf(';', idx)
    const definition = src.slice(idx, lineEnd)

    // Must be a regex (starts with /)
    assert.ok(
      definition.includes('= /'),
      'BLOCKED_SIGNALS must be assigned a regex literal',
    )

    // Must match key blocked/failed signals
    assert.ok(definition.includes('blocked'), 'regex must match "blocked" signals')
    assert.ok(definition.includes('failed'), 'regex must match "failed" signals')
  })

  it('gate checks params.verification and params.uatContent', () => {
    // Find usage of BLOCKED_SIGNALS.test
    const testCalls = src.match(/BLOCKED_SIGNALS\.test\([^)]+\)/g)
    assert.ok(testCalls, 'BLOCKED_SIGNALS.test() must be called')
    assert.ok(testCalls.length >= 2, 'must check at least verification and uatContent')

    const joined = testCalls.join(' ')
    assert.ok(joined.includes('verification'), 'must test params.verification')
    assert.ok(joined.includes('uatContent'), 'must test params.uatContent')
  })

  it('gate returns an error message when blocked signals detected', () => {
    // Find the return statement after BLOCKED_SIGNALS check
    const gateIdx = src.indexOf('BLOCKED_SIGNALS.test(')
    assert.ok(gateIdx !== -1)

    const afterGate = extractSourceRegion(src, 'BLOCKED_SIGNALS.test(')
    assert.ok(
      afterGate.includes('return { error:'),
      'blocked signal detection must return an error',
    )
    assert.ok(
      afterGate.includes('do not complete'),
      'error message must explain why completion is rejected',
    )
  })
})
