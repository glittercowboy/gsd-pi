import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatProgress, formatThinkingLine, formatCostLine, summarizeToolArgs } from '../headless-ui.js'
import type { ProgressContext } from '../headless-ui.js'

// Tests run with NO_COLOR or non-TTY stderr, so ANSI codes are empty strings.
// We test content, not escape sequences.

function ctx(overrides: Partial<ProgressContext> = {}): ProgressContext {
  return { verbose: true, ...overrides }
}

describe('formatProgress', () => {
  describe('tool_execution_start', () => {
    it('shows tool name and summarized args in verbose mode', () => {
      const result = formatProgress({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'npm run build' },
      }, ctx())
      assert.ok(result)
      assert.ok(result.includes('bash'))
      assert.ok(result.includes('npm run build'))
    })

    it('shows Read with file path', () => {
      const result = formatProgress({
        type: 'tool_execution_start',
        toolName: 'Read',
        args: { path: 'src/main.ts' },
      }, ctx())
      assert.ok(result)
      assert.ok(result.includes('Read'))
      assert.ok(result.includes('src/main.ts'))
    })

    it('returns null in non-verbose mode', () => {
      const result = formatProgress({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'npm run build' },
      }, ctx({ verbose: false }))
      assert.equal(result, null)
    })

    it('shows tool name alone when no args', () => {
      const result = formatProgress({
        type: 'tool_execution_start',
        toolName: 'unknown_tool',
      }, ctx())
      assert.ok(result)
      assert.ok(result.includes('unknown_tool'))
    })
  })

  describe('tool_execution_end', () => {
    it('shows error with duration in verbose mode', () => {
      const result = formatProgress({
        type: 'tool_execution_end',
        toolName: 'bash',
      }, ctx({ isError: true, toolDuration: 1500 }))
      assert.ok(result)
      assert.ok(result.includes('bash'))
      assert.ok(result.includes('error'))
      assert.ok(result.includes('1.5s'))
    })

    it('shows done with duration in verbose mode', () => {
      const result = formatProgress({
        type: 'tool_execution_end',
        toolName: 'read',
      }, ctx({ toolDuration: 50 }))
      assert.ok(result)
      assert.ok(result.includes('done'))
      assert.ok(result.includes('50ms'))
    })

    it('returns null in non-verbose mode', () => {
      const result = formatProgress({
        type: 'tool_execution_end',
        toolName: 'bash',
        isError: false,
      }, ctx({ verbose: false }))
      assert.equal(result, null)
    })
  })

  describe('agent lifecycle', () => {
    it('shows agent_start', () => {
      const result = formatProgress({ type: 'agent_start' }, ctx())
      assert.ok(result)
      assert.ok(result.includes('Session started'))
    })

    it('shows agent_end', () => {
      const result = formatProgress({ type: 'agent_end' }, ctx())
      assert.ok(result)
      assert.ok(result.includes('Session ended'))
    })

    it('shows agent_end with cost', () => {
      const result = formatProgress({ type: 'agent_end' }, ctx({
        lastCost: { costUsd: 0.42, inputTokens: 10000, outputTokens: 500 },
      }))
      assert.ok(result)
      assert.ok(result.includes('Session ended'))
      assert.ok(result.includes('$0.42'))
      assert.ok(result.includes('10500 tokens'))
    })
  })

  describe('extension_ui_request', () => {
    it('shows notify with message', () => {
      const result = formatProgress({
        type: 'extension_ui_request',
        method: 'notify',
        message: 'Auto-mode started',
      }, ctx())
      assert.ok(result)
      assert.ok(result.includes('Auto-mode started'))
    })

    it('bolds important notifications', () => {
      const result = formatProgress({
        type: 'extension_ui_request',
        method: 'notify',
        message: 'Committed: fix auth flow',
      }, ctx())
      assert.ok(result)
      assert.ok(result.includes('Committed: fix auth flow'))
    })

    it('suppresses empty notify', () => {
      const result = formatProgress({
        type: 'extension_ui_request',
        method: 'notify',
        message: '',
      }, ctx())
      assert.equal(result, null)
    })

    it('suppresses empty setStatus', () => {
      const result = formatProgress({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: '',
        message: '',
      }, ctx())
      assert.equal(result, null)
    })

    it('shows setStatus with statusKey as phase', () => {
      const result = formatProgress({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'milestone:M001',
        message: 'Hello World CLI',
      }, ctx())
      assert.ok(result)
      assert.ok(result.includes('Milestone'))
      assert.ok(result.includes('M001'))
    })

    it('suppresses setWidget (TUI-only)', () => {
      const result = formatProgress({
        type: 'extension_ui_request',
        method: 'setWidget',
        widgetKey: 'progress',
      }, ctx())
      assert.equal(result, null)
    })
  })

  describe('unknown events', () => {
    it('returns null', () => {
      assert.equal(formatProgress({ type: 'some_random_event' }, ctx()), null)
    })
  })
})

describe('summarizeToolArgs', () => {
  it('extracts path for Read', () => {
    assert.equal(summarizeToolArgs('Read', { path: 'src/index.ts' }), 'src/index.ts')
  })

  it('extracts path for write', () => {
    assert.equal(summarizeToolArgs('write', { path: '/tmp/out.json' }), '/tmp/out.json')
  })

  it('extracts file_path for legacy compatibility', () => {
    assert.equal(summarizeToolArgs('read', { file_path: 'src/foo.ts' }), 'src/foo.ts')
  })

  it('prefers path over file_path when both present', () => {
    assert.equal(summarizeToolArgs('read', { path: 'real.ts', file_path: 'legacy.ts' }), 'real.ts')
  })

  it('extracts command for bash', () => {
    assert.equal(summarizeToolArgs('bash', { command: 'ls -la' }), 'ls -la')
  })

  it('truncates long bash commands', () => {
    const longCmd = 'a'.repeat(100)
    const result = summarizeToolArgs('bash', { command: longCmd })
    assert.ok(result.endsWith('...'))
    assert.ok(result.length < 100)
  })

  it('extracts command for async_bash', () => {
    assert.equal(summarizeToolArgs('async_bash', { command: 'npm run build' }), 'npm run build')
  })

  it('extracts jobs for await_job', () => {
    assert.equal(summarizeToolArgs('await_job', { jobs: ['bg_abc', 'bg_def'] }), 'bg_abc, bg_def')
  })

  it('extracts pattern for grep', () => {
    const result = summarizeToolArgs('grep', { pattern: 'TODO', glob: '*.ts' })
    assert.equal(result, 'TODO *.ts')
  })

  it('extracts pattern and path for find', () => {
    assert.equal(summarizeToolArgs('find', { pattern: '*.ts', path: 'src' }), '*.ts in src')
  })

  it('extracts action and file for lsp', () => {
    const result = summarizeToolArgs('lsp', { action: 'definition', file: 'src/main.ts', symbol: 'foo' })
    assert.equal(result, 'definition src/main.ts foo')
  })

  it('extracts path for ls', () => {
    assert.equal(summarizeToolArgs('ls', { path: 'src/utils' }), 'src/utils')
  })

  it('summarizes gsd tool with milestone/slice/task IDs', () => {
    assert.equal(summarizeToolArgs('gsd_task_complete', {
      milestoneId: 'M001', sliceId: 'S01', taskId: 'T01', oneLiner: 'Built the thing',
    }), 'M001/S01/T01 Built the thing')
  })

  it('summarizes gsd_plan_milestone with milestone ID', () => {
    assert.equal(summarizeToolArgs('gsd_plan_milestone', { milestoneId: 'M002' }), 'M002')
  })

  it('summarizes gsd_decision_save with decision text', () => {
    const result = summarizeToolArgs('gsd_decision_save', { decision: 'Use SQLite for persistence' })
    assert.equal(result, 'Use SQLite for persistence')
  })

  it('returns first string value for unknown tools', () => {
    assert.equal(summarizeToolArgs('custom_tool', { someKey: 'hello' }), 'hello')
  })

  it('returns empty string for no args', () => {
    assert.equal(summarizeToolArgs('unknown', {}), '')
  })

  it('extracts path for edit', () => {
    assert.equal(summarizeToolArgs('edit', { path: 'src/config.ts' }), 'src/config.ts')
  })

  it('extracts path for hashline_edit', () => {
    assert.equal(summarizeToolArgs('hashline_edit', { path: 'src/main.ts' }), 'src/main.ts')
  })

  it('extracts agent and task for subagent', () => {
    assert.equal(summarizeToolArgs('subagent', { agent: 'scout', task: 'Find auth patterns' }), 'scout: Find auth patterns')
  })

  it('extracts url for browser_navigate', () => {
    assert.equal(summarizeToolArgs('browser_navigate', { url: 'http://localhost:3000' }), 'http://localhost:3000')
  })
})

describe('formatThinkingLine', () => {
  it('formats short text', () => {
    const result = formatThinkingLine('Analyzing the codebase')
    assert.ok(result.includes('[thinking]'))
    assert.ok(result.includes('Analyzing the codebase'))
  })

  it('truncates long text to ~120 chars', () => {
    const longText = 'word '.repeat(50) // 250 chars
    const result = formatThinkingLine(longText)
    assert.ok(result.includes('...'))
  })

  it('collapses whitespace', () => {
    const result = formatThinkingLine('line one\n\nline   two\ttab')
    assert.ok(result.includes('line one line two tab'))
  })
})

describe('formatCostLine', () => {
  it('formats cost with token count', () => {
    const result = formatCostLine(0.0523, 4200, 1100)
    assert.ok(result.includes('$0.0523'))
    assert.ok(result.includes('5300 tokens'))
  })
})
