/**
 * Tests for TTSR rule loader: frontmatter parsing, directory scanning,
 * and project-overrides-global merge logic.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { loadRules } from '../../src/resources/extensions/ttsr/index.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpProject(): { cwd: string; globalDir: string; projectDir: string; cleanup: () => void } {
	const cwd = mkdtempSync(join(tmpdir(), 'ttsr-loader-test-'))
	const globalDir = join(cwd, '.gsd-global', 'agent', 'rules')
	const projectDir = join(cwd, '.gsd', 'rules')
	return { cwd, globalDir, projectDir, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}

function writeRule(dir: string, name: string, frontmatter: string, body: string): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`)
}

// loadRules uses homedir() for global dir — we can't easily override that,
// so we test the project-local path and the merge logic by testing with
// a cwd that has .gsd/rules/.

// ═══════════════════════════════════════════════════════════════════════════
// Project-local rule loading
// ═══════════════════════════════════════════════════════════════════════════

test('loads rule from project .gsd/rules/', () => {
	const { cwd, projectDir, cleanup } = makeTmpProject()
	try {
		writeRule(projectDir, 'no-console', 'condition:\n  - "console\\.log"', 'Do not use console.log.')
		const rules = loadRules(cwd)
		const projectRule = rules.find(r => r.name === 'no-console')
		assert.ok(projectRule)
		assert.deepEqual(projectRule.condition, ['console\\.log'])
		assert.equal(projectRule.content, 'Do not use console.log.')
	} finally {
		cleanup()
	}
})

test('parses scope and globs from frontmatter', () => {
	const { cwd, projectDir, cleanup } = makeTmpProject()
	try {
		writeRule(
			projectDir,
			'scoped-rule',
			'condition:\n  - "TODO"\nscope:\n  - "tool:edit"\n  - "text"\nglobs:\n  - "*.ts"',
			'No TODOs allowed.',
		)
		const rules = loadRules(cwd)
		const rule = rules.find(r => r.name === 'scoped-rule')
		assert.ok(rule)
		assert.deepEqual(rule.scope, ['tool:edit', 'text'])
		assert.deepEqual(rule.globs, ['*.ts'])
	} finally {
		cleanup()
	}
})

test('skips files without valid frontmatter', () => {
	const { cwd, projectDir, cleanup } = makeTmpProject()
	try {
		mkdirSync(projectDir, { recursive: true })
		writeFileSync(join(projectDir, 'broken.md'), 'No frontmatter here.')
		const rules = loadRules(cwd)
		assert.equal(rules.filter(r => r.name === 'broken').length, 0)
	} finally {
		cleanup()
	}
})

test('skips rules with no condition', () => {
	const { cwd, projectDir, cleanup } = makeTmpProject()
	try {
		writeRule(projectDir, 'no-condition', 'scope:\n  - "text"', 'Missing condition field.')
		const rules = loadRules(cwd)
		assert.equal(rules.filter(r => r.name === 'no-condition').length, 0)
	} finally {
		cleanup()
	}
})

test('returns empty array when .gsd/rules/ does not exist', () => {
	const { cwd, cleanup } = makeTmpProject()
	try {
		// cwd exists but no .gsd/rules/ dir
		const rules = loadRules(cwd)
		// May include global rules from homedir — just verify no crash
		assert.ok(Array.isArray(rules))
	} finally {
		cleanup()
	}
})

test('loads multiple rules from same directory', () => {
	const { cwd, projectDir, cleanup } = makeTmpProject()
	try {
		writeRule(projectDir, 'rule-a', 'condition:\n  - "alpha"', 'Alpha rule.')
		writeRule(projectDir, 'rule-b', 'condition:\n  - "beta"', 'Beta rule.')
		const rules = loadRules(cwd)
		const names = rules.map(r => r.name)
		assert.ok(names.includes('rule-a'))
		assert.ok(names.includes('rule-b'))
	} finally {
		cleanup()
	}
})

test('handles quoted values in frontmatter', () => {
	const { cwd, projectDir, cleanup } = makeTmpProject()
	try {
		writeRule(projectDir, 'quoted', 'condition:\n  - "console\\.log"\n  - \'debugger\'', 'Quoted values.')
		const rules = loadRules(cwd)
		const rule = rules.find(r => r.name === 'quoted')
		assert.ok(rule)
		assert.deepEqual(rule.condition, ['console\\.log', 'debugger'])
	} finally {
		cleanup()
	}
})
