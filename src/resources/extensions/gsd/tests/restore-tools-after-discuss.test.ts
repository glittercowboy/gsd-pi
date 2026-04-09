/**
 * Regression test for #3628 — restore tool set after discuss flow scoping
 *
 * The discuss flow narrows the active tool set to avoid "grammar too complex"
 * errors. Without restoring after sendMessage, the narrowed tools leaked into
 * subsequent dispatches, breaking plan/execute flows.
 *
 * The fix saves the full tool set before scoping and restores it after
 * sendMessage returns.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(
  resolve(process.cwd(), 'src', 'resources', 'extensions', 'gsd', 'guided-flow.ts'),
  'utf-8',
)

describe('restore tools after discuss flow scoping (#3628)', () => {
  it('savedTools is declared before the discuss scoping block', () => {
    // savedTools must be declared before the discuss-* check
    const savedToolsDecl = src.indexOf('let savedTools')
    const discussCheck = src.indexOf('if (unitType?.startsWith("discuss-"))')
    assert.ok(savedToolsDecl !== -1, 'savedTools variable must be declared')
    assert.ok(discussCheck !== -1, 'discuss-* type check must exist')
    assert.ok(
      savedToolsDecl < discussCheck,
      'savedTools must be declared before the discuss scoping block',
    )
  })

  it('savedTools captures current tools inside the discuss block', () => {
    const discussCheck = src.indexOf('if (unitType?.startsWith("discuss-"))')
    assert.ok(discussCheck !== -1)

    // Look for savedTools assignment within the discuss block
    const blockAfter = src.slice(discussCheck, discussCheck + 500)
    assert.ok(
      blockAfter.includes('savedTools = currentTools'),
      'savedTools must be assigned from currentTools inside the discuss block',
    )
  })

  it('savedTools is restored after sendMessage', () => {
    // Find the sendMessage call
    const sendMsg = src.indexOf('triggerTurn: true')
    assert.ok(sendMsg !== -1, 'sendMessage with triggerTurn must exist')

    // After sendMessage, savedTools should be restored via setActiveTools
    const afterSend = src.slice(sendMsg, sendMsg + 500)
    assert.ok(
      afterSend.includes('if (savedTools)'),
      'savedTools restoration guard must exist after sendMessage',
    )
    assert.ok(
      afterSend.includes('setActiveTools(savedTools)'),
      'setActiveTools(savedTools) must be called to restore the full tool set',
    )
  })
})
