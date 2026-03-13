/**
 * Tests for ArtifactManager: sequential ID allocation, save/retrieve,
 * and session resume (ID continuity).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ArtifactManager } from '../../packages/pi-coding-agent/src/core/artifact-manager.ts'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpSession(): { sessionFile: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'artifact-test-'))
	const sessionFile = join(dir, 'session.jsonl')
	return { sessionFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ═══════════════════════════════════════════════════════════════════════════
// save / getPath
// ═══════════════════════════════════════════════════════════════════════════

test('save creates artifact file with sequential ID', () => {
	const { sessionFile, cleanup } = makeTmpSession()
	try {
		const mgr = new ArtifactManager(sessionFile)
		const id0 = mgr.save('output 0', 'bash')
		const id1 = mgr.save('output 1', 'bash')

		assert.equal(id0, '0')
		assert.equal(id1, '1')

		const path0 = mgr.getPath('0')
		assert.ok(path0)
		assert.equal(readFileSync(path0, 'utf-8'), 'output 0')

		const path1 = mgr.getPath('1')
		assert.ok(path1)
		assert.equal(readFileSync(path1, 'utf-8'), 'output 1')
	} finally {
		cleanup()
	}
})

test('artifact directory is named after session file without .jsonl', () => {
	const { sessionFile, cleanup } = makeTmpSession()
	try {
		const mgr = new ArtifactManager(sessionFile)
		const expectedDir = sessionFile.slice(0, -6) // strip .jsonl
		assert.equal(mgr.dir, expectedDir)
	} finally {
		cleanup()
	}
})

test('artifact directory is created lazily on first write', () => {
	const { sessionFile, cleanup } = makeTmpSession()
	try {
		const mgr = new ArtifactManager(sessionFile)
		const artifactDir = mgr.dir

		assert.equal(existsSync(artifactDir), false)
		mgr.save('trigger creation', 'bash')
		assert.ok(existsSync(artifactDir))
	} finally {
		cleanup()
	}
})

// ═══════════════════════════════════════════════════════════════════════════
// exists
// ═══════════════════════════════════════════════════════════════════════════

test('exists returns true for saved artifact', () => {
	const { sessionFile, cleanup } = makeTmpSession()
	try {
		const mgr = new ArtifactManager(sessionFile)
		const id = mgr.save('content', 'bash')
		assert.ok(mgr.exists(id))
	} finally {
		cleanup()
	}
})

test('exists returns false for missing artifact', () => {
	const { sessionFile, cleanup } = makeTmpSession()
	try {
		const mgr = new ArtifactManager(sessionFile)
		assert.equal(mgr.exists('999'), false)
	} finally {
		cleanup()
	}
})

// ═══════════════════════════════════════════════════════════════════════════
// allocatePath
// ═══════════════════════════════════════════════════════════════════════════

test('allocatePath returns path without writing', () => {
	const { sessionFile, cleanup } = makeTmpSession()
	try {
		const mgr = new ArtifactManager(sessionFile)
		const { id, path } = mgr.allocatePath('fetch')

		assert.equal(id, '0')
		assert.ok(path.endsWith('0.fetch.log'))
		// File should not exist yet — allocatePath doesn't write
		assert.equal(existsSync(path), false)
	} finally {
		cleanup()
	}
})

// ═══════════════════════════════════════════════════════════════════════════
// Session resume — ID continuity
// ═══════════════════════════════════════════════════════════════════════════

test('new manager picks up where previous left off', () => {
	const { sessionFile, cleanup } = makeTmpSession()
	try {
		const mgr1 = new ArtifactManager(sessionFile)
		mgr1.save('first', 'bash')
		mgr1.save('second', 'bash')

		// Simulate session resume — new manager for same session file
		const mgr2 = new ArtifactManager(sessionFile)
		const id = mgr2.save('third', 'bash')

		assert.equal(id, '2') // continues from 0, 1 → next is 2
	} finally {
		cleanup()
	}
})

// ═══════════════════════════════════════════════════════════════════════════
// listFiles
// ═══════════════════════════════════════════════════════════════════════════

test('listFiles returns all artifact filenames', () => {
	const { sessionFile, cleanup } = makeTmpSession()
	try {
		const mgr = new ArtifactManager(sessionFile)
		mgr.save('a', 'bash')
		mgr.save('b', 'fetch')

		const files = mgr.listFiles()
		assert.equal(files.length, 2)
		assert.ok(files.some(f => f === '0.bash.log'))
		assert.ok(files.some(f => f === '1.fetch.log'))
	} finally {
		cleanup()
	}
})

test('listFiles returns empty for nonexistent dir', () => {
	const { sessionFile, cleanup } = makeTmpSession()
	try {
		const mgr = new ArtifactManager(sessionFile)
		assert.deepEqual(mgr.listFiles(), [])
	} finally {
		cleanup()
	}
})
