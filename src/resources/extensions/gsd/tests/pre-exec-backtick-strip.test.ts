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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(
  resolve(process.cwd(), 'src', 'resources', 'extensions', 'gsd', 'pre-execution-checks.ts'),
  'utf-8',
)

describe('normalizeFilePath backtick stripping (#3649)', () => {
  it('strips backticks from file paths', () => {
    assert.equal(normalizeFilePath('`src/foo.ts`'), 'src/foo.ts')
  })

  it('strips doubled backticks and trailing notes from file paths', () => {
    assert.equal(normalizeFilePath('``src/foo.ts`` - current state'), 'src/foo.ts')
    assert.equal(normalizeFilePath('``src/foo.ts`` (current state)'), 'src/foo.ts')
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

describe('checkFilePathConsistency handles doubled-backtick annotations (#3892)', () => {
  it('accepts existing files when task.inputs include doubled-backtick notes', () => {
    const task = {
      milestone_id: 'M001',
      slice_id: 'S01',
      id: 'T01',
      title: 'Test Task',
      status: 'pending',
      one_liner: '',
      narrative: '',
      verification_result: '',
      duration: '',
      completed_at: null,
      blocker_discovered: false,
      deviations: '',
      known_issues: '',
      key_files: [],
      key_decisions: [],
      full_summary_md: '',
      description: '',
      estimate: '',
      files: [],
      verify: '',
      inputs: ['``src/foo.ts`` (current state)'],
      expected_output: [],
      observability_impact: '',
      full_plan_md: '',
      sequence: 0,
    }

    const tmp = resolve(process.cwd(), '.tmp-pre-exec-3892')
    try {
      mkdirSync(resolve(tmp, 'src'), { recursive: true })
      writeFileSync(resolve(tmp, 'src', 'foo.ts'), '// ok')
      const results = checkFilePathConsistency([task as any], tmp)
      assert.deepEqual(results, [])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
