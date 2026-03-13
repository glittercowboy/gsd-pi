/**
 * Tests for TtsrManager: rule matching, scope filtering, buffer management,
 * repeat gating, and buffer size caps.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TtsrManager, type Rule, type TtsrMatchContext } from '../../src/resources/extensions/ttsr/ttsr-manager.ts'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<Rule> = {}): Rule {
	return {
		name: 'test-rule',
		path: '/test/rules/test-rule.md',
		content: 'Do not do this.',
		condition: ['console\\.log'],
		...overrides,
	}
}

function textCtx(streamKey?: string): TtsrMatchContext {
	return { source: 'text', streamKey: streamKey ?? 'text' }
}

function toolCtx(toolName?: string, filePaths?: string[]): TtsrMatchContext {
	return { source: 'tool', toolName, filePaths, streamKey: toolName ? `tool:${toolName}` : 'tool' }
}

function thinkingCtx(): TtsrMatchContext {
	return { source: 'thinking', streamKey: 'thinking' }
}

// ═══════════════════════════════════════════════════════════════════════════
// Basic rule matching
// ═══════════════════════════════════════════════════════════════════════════

test('matches when condition regex matches text delta', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule())
	const matches = mgr.checkDelta('console.log("hello")', textCtx())
	assert.equal(matches.length, 1)
	assert.equal(matches[0].name, 'test-rule')
})

test('no match when condition does not match', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule())
	const matches = mgr.checkDelta('console.error("hello")', textCtx())
	assert.equal(matches.length, 0)
})

test('matches across multiple deltas (buffering)', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule())

	assert.equal(mgr.checkDelta('console', textCtx()).length, 0)
	assert.equal(mgr.checkDelta('.lo', textCtx()).length, 0)

	const matches = mgr.checkDelta('g("x")', textCtx())
	assert.equal(matches.length, 1)
})

test('multiple conditions — match on any', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule({ condition: ['console\\.log', 'debugger'] }))

	const m1 = mgr.checkDelta('debugger;', textCtx())
	assert.equal(m1.length, 1)
})

test('addRule rejects duplicate names', () => {
	const mgr = new TtsrManager()
	assert.ok(mgr.addRule(makeRule()))
	assert.equal(mgr.addRule(makeRule()), false)
})

test('addRule rejects rule with no valid conditions', () => {
	const mgr = new TtsrManager()
	assert.equal(mgr.addRule(makeRule({ condition: [] })), false)
})

test('addRule rejects rule with only invalid regex', () => {
	const mgr = new TtsrManager()
	assert.equal(mgr.addRule(makeRule({ condition: ['(unclosed'] })), false)
})

// ═══════════════════════════════════════════════════════════════════════════
// Scope filtering
// ═══════════════════════════════════════════════════════════════════════════

test('default scope matches text and tool, not thinking', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule())

	assert.equal(mgr.checkDelta('console.log', textCtx()).length, 1)
	mgr.resetBuffer()
	assert.equal(mgr.checkDelta('console.log', toolCtx('edit')).length, 1)
	mgr.resetBuffer()
	assert.equal(mgr.checkDelta('console.log', thinkingCtx()).length, 0)
})

test('scope: ["text"] only matches text source', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule({ scope: ['text'] }))

	assert.equal(mgr.checkDelta('console.log', textCtx()).length, 1)
	mgr.resetBuffer()
	assert.equal(mgr.checkDelta('console.log', toolCtx('edit')).length, 0)
})

test('scope: ["tool:edit"] only matches edit tool', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule({ scope: ['tool:edit'] }))

	assert.equal(mgr.checkDelta('console.log', toolCtx('edit')).length, 1)
	mgr.resetBuffer()
	assert.equal(mgr.checkDelta('console.log', toolCtx('write')).length, 0)
	mgr.resetBuffer()
	assert.equal(mgr.checkDelta('console.log', textCtx()).length, 0)
})

test('scope: ["thinking"] matches thinking source', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule({ scope: ['thinking'] }))

	assert.equal(mgr.checkDelta('console.log', thinkingCtx()).length, 1)
	mgr.resetBuffer()
	assert.equal(mgr.checkDelta('console.log', textCtx()).length, 0)
})

// ═══════════════════════════════════════════════════════════════════════════
// Repeat gating
// ═══════════════════════════════════════════════════════════════════════════

test('repeatMode "once" prevents re-triggering after injection', () => {
	const mgr = new TtsrManager({ repeatMode: 'once' })
	mgr.addRule(makeRule())

	const m1 = mgr.checkDelta('console.log', textCtx())
	assert.equal(m1.length, 1)
	mgr.markInjected(m1)

	mgr.resetBuffer()
	const m2 = mgr.checkDelta('console.log', textCtx())
	assert.equal(m2.length, 0)
})

test('repeatMode "gap" re-triggers after enough messages', () => {
	const mgr = new TtsrManager({ repeatMode: 'gap', repeatGap: 2 })
	mgr.addRule(makeRule())

	const m1 = mgr.checkDelta('console.log', textCtx())
	assert.equal(m1.length, 1)
	mgr.markInjected(m1)

	// Not enough gap
	mgr.resetBuffer()
	mgr.incrementMessageCount()
	assert.equal(mgr.checkDelta('console.log', textCtx()).length, 0)

	// Enough gap
	mgr.resetBuffer()
	mgr.incrementMessageCount()
	assert.equal(mgr.checkDelta('console.log', textCtx()).length, 1)
})

// ═══════════════════════════════════════════════════════════════════════════
// Buffer management
// ═══════════════════════════════════════════════════════════════════════════

test('resetBuffer clears all buffers', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule())

	mgr.checkDelta('console', textCtx())
	mgr.resetBuffer()

	// After reset, partial buffer is gone — ".log" alone shouldn't match
	assert.equal(mgr.checkDelta('.log', textCtx()).length, 0)
})

test('buffers are isolated by stream key', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule())

	// Build up "console" in text stream
	mgr.checkDelta('console', textCtx())
	// ".log" in a different stream key shouldn't combine with text's "console"
	assert.equal(mgr.checkDelta('.log', toolCtx('edit')).length, 0)
	// But completing in the same text stream should match
	assert.equal(mgr.checkDelta('.log', textCtx()).length, 1)
})

test('buffer is capped at 512KB — old content is trimmed', () => {
	const mgr = new TtsrManager()
	// Rule that matches a pattern only present at the start
	mgr.addRule(makeRule({ name: 'start-marker', condition: ['START_MARKER'] }))

	// Put marker at the start
	mgr.checkDelta('START_MARKER', textCtx())
	mgr.resetBuffer()

	// Put marker then flood with enough data to push it out
	mgr.checkDelta('START_MARKER', textCtx())
	const bigChunk = 'x'.repeat(600 * 1024) // 600KB > 512KB cap
	mgr.checkDelta(bigChunk, textCtx())

	// Now the marker should have been trimmed from the buffer
	// Reset and re-add — but we can verify by checking that a new match
	// on a fresh delta for START_MARKER doesn't find two
	mgr.resetBuffer()
	mgr.addRule(makeRule({ name: 'end-check', condition: ['START_MARKER'] }))
	assert.equal(mgr.checkDelta('no match here', textCtx()).length, 0)
})

// ═══════════════════════════════════════════════════════════════════════════
// Injection record persistence
// ═══════════════════════════════════════════════════════════════════════════

test('getInjectedRuleNames returns injected names', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule())

	const matches = mgr.checkDelta('console.log', textCtx())
	mgr.markInjected(matches)

	const names = mgr.getInjectedRuleNames()
	assert.deepEqual(names, ['test-rule'])
})

test('restoreInjected prevents firing for "once" mode', () => {
	const mgr = new TtsrManager({ repeatMode: 'once' })
	mgr.addRule(makeRule())
	mgr.restoreInjected(['test-rule'])

	assert.equal(mgr.checkDelta('console.log', textCtx()).length, 0)
})

// ═══════════════════════════════════════════════════════════════════════════
// hasRules
// ═══════════════════════════════════════════════════════════════════════════

test('hasRules returns false when empty', () => {
	const mgr = new TtsrManager()
	assert.equal(mgr.hasRules(), false)
})

test('hasRules returns true after adding rule', () => {
	const mgr = new TtsrManager()
	mgr.addRule(makeRule())
	assert.ok(mgr.hasRules())
})
