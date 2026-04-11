/**
 * Regression test for discuss-slice structured questions availability
 *
 * The guided-discuss-slice.md template must use the structuredQuestionsAvailable
 * template variable to conditionally switch between ask_user_questions tool
 * calls and plain-text questions, so the prompt works correctly when the
 * structured questions tool is not available.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const template = readFileSync(
  resolve(process.cwd(), 'src', 'resources', 'extensions', 'gsd', 'prompts', 'guided-discuss-slice.md'),
  'utf-8',
)

describe('discuss-slice structuredQuestionsAvailable template variable', () => {
  it('template references structuredQuestionsAvailable variable', () => {
    assert.ok(
      template.includes('{{structuredQuestionsAvailable}}'),
      'guided-discuss-slice.md must use {{structuredQuestionsAvailable}} template variable',
    )
  })

  it('template handles both true and false cases', () => {
    const trueCase = template.includes('`{{structuredQuestionsAvailable}}` is `true`')
    const falseCase = template.includes('`{{structuredQuestionsAvailable}}` is `false`')

    assert.ok(trueCase, 'template must have a branch for structuredQuestionsAvailable=true')
    assert.ok(falseCase, 'template must have a branch for structuredQuestionsAvailable=false')
  })

  it('false case instructs plain text questions', () => {
    const falseIdx = template.indexOf('`{{structuredQuestionsAvailable}}` is `false`')
    assert.ok(falseIdx !== -1)

    const afterFalse = template.slice(falseIdx, falseIdx + 300)
    assert.ok(
      afterFalse.includes('plain text'),
      'when structuredQuestionsAvailable is false, questions should be in plain text',
    )
  })
})
