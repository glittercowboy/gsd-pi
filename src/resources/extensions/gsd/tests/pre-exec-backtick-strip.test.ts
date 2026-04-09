/**
 * Regression test for #3626 / #3649 — pre-execution-checks false positives
 *
 * Two sources of false positives were fixed:
 *   1. normalizeFilePath did not strip backtick wrapping from LLM-generated
 *      paths like `src/foo.ts`, causing file-existence checks to fail (#3649).
 *   2. checkFilePathConsistency checked both task.files and task.inputs, but
 *      task.files ("files likely touched") intentionally includes files that
 *      will be created by the task, so they don't need to pre-exist (#3626).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFilePath, checkFilePathConsistency } from '../pre-execution-checks.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(
  resolve(process.cwd(), 'src', 'resources', 'extensions', 'gsd', 'pre-execution-checks.ts'),
  'utf-8',
)

describe('normalizeFilePath backtick stripping (#3649)', () => {
  it('strips backticks from file paths', () => {
    assert.equal(normalizeFilePath('`src/foo.ts`'), 'src/foo.ts')
  })

  it('strips backticks even when mixed with other normalization', () => {
    assert.equal(normalizeFilePath('`./src//bar.ts`'), 'src/bar.ts')
  })

  it('leaves normal paths unchanged', () => {
    assert.equal(normalizeFilePath('src/foo.ts'), 'src/foo.ts')
  })

  it('handles empty string', () => {
    assert.equal(normalizeFilePath(''), '')
  })
})

describe('checkFilePathConsistency checks task.inputs not task.files (#3626)', () => {
  it('source uses only task.inputs in filesToCheck', () => {
    // Verify the fix structurally: the spread should be [...task.inputs] only
    const fnStart = src.indexOf('export function checkFilePathConsistency(')
    assert.ok(fnStart !== -1, 'checkFilePathConsistency function must exist')

    // Find the filesToCheck assignment
    const filesToCheckLine = src.indexOf('filesToCheck', fnStart)
    assert.ok(filesToCheckLine !== -1, 'filesToCheck assignment must exist')

    // Extract the line
    const lineEnd = src.indexOf('\n', filesToCheckLine)
    const line = src.slice(filesToCheckLine, lineEnd)

    // Must include task.inputs
    assert.ok(
      line.includes('task.inputs'),
      'filesToCheck must reference task.inputs',
    )

    // Must NOT include task.files
    assert.ok(
      !line.includes('task.files'),
      'filesToCheck must NOT reference task.files — files likely touched include ' +
        'files the task will create, so they do not need to pre-exist',
    )
  })
})
