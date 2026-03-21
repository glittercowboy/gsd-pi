/**
 * Tests for BlobStore: content-addressed storage, path traversal protection,
 * and blob ref parsing/externalization.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

import {
	BlobStore,
	isBlobRef,
	parseBlobRef,
	externalizeImageData,
	resolveImageData,
} from '../../packages/pi-coding-agent/src/core/blob-store.ts'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'blob-test-'))
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function sha256(data: Buffer): string {
	return createHash('sha256').update(data).digest('hex')
}

// ═══════════════════════════════════════════════════════════════════════════
// BlobStore.put / get / has
// ═══════════════════════════════════════════════════════════════════════════

test('put stores data and returns correct hash', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		const data = Buffer.from('hello world')
		const result = store.put(data)

		assert.equal(result.hash, sha256(data))
		assert.ok(existsSync(result.path))
		assert.deepEqual(readFileSync(result.path), data)
	} finally {
		cleanup()
	}
})

test('put is idempotent — same data returns same hash, no duplicate write', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		const data = Buffer.from('duplicate test')
		const r1 = store.put(data)
		const r2 = store.put(data)

		assert.equal(r1.hash, r2.hash)
		assert.equal(r1.path, r2.path)
	} finally {
		cleanup()
	}
})

test('get retrieves stored data', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		const data = Buffer.from('retrieve me')
		const { hash } = store.put(data)
		const retrieved = store.get(hash)

		assert.deepEqual(retrieved, data)
	} finally {
		cleanup()
	}
})

test('get returns null for nonexistent hash', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		const fakeHash = 'a'.repeat(64)
		assert.equal(store.get(fakeHash), null)
	} finally {
		cleanup()
	}
})

test('has returns true for stored blob', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		const { hash } = store.put(Buffer.from('exists'))
		assert.ok(store.has(hash))
	} finally {
		cleanup()
	}
})

test('has returns false for missing blob', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		assert.equal(store.has('b'.repeat(64)), false)
	} finally {
		cleanup()
	}
})

test('ref property returns correct blob: URI', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		const data = Buffer.from('ref test')
		const result = store.put(data)
		assert.equal(result.ref, `blob:sha256:${result.hash}`)
	} finally {
		cleanup()
	}
})

// ═══════════════════════════════════════════════════════════════════════════
// Path traversal protection
// ═══════════════════════════════════════════════════════════════════════════

test('get rejects non-hex hash (path traversal attempt)', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		assert.equal(store.get('../../etc/passwd'), null)
		assert.equal(store.get('../../../foo'), null)
		assert.equal(store.get('not-a-valid-hash'), null)
	} finally {
		cleanup()
	}
})

test('has rejects non-hex hash', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		assert.equal(store.has('../../etc/passwd'), false)
		assert.equal(store.has('short'), false)
		assert.equal(store.has('Z'.repeat(64)), false) // uppercase not valid
	} finally {
		cleanup()
	}
})

test('get rejects hash with wrong length', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		assert.equal(store.get('a'.repeat(63)), null) // too short
		assert.equal(store.get('a'.repeat(65)), null) // too long
	} finally {
		cleanup()
	}
})

// ═══════════════════════════════════════════════════════════════════════════
// parseBlobRef / isBlobRef
// ═══════════════════════════════════════════════════════════════════════════

test('isBlobRef identifies valid refs', () => {
	assert.ok(isBlobRef(`blob:sha256:${'a'.repeat(64)}`))
	assert.equal(isBlobRef('not-a-ref'), false)
	// isBlobRef is a cheap prefix check — parseBlobRef does full validation
	assert.ok(isBlobRef('blob:sha256:'))
})

test('parseBlobRef extracts valid hash', () => {
	const hash = 'abcdef0123456789'.repeat(4)
	assert.equal(parseBlobRef(`blob:sha256:${hash}`), hash)
})

test('parseBlobRef rejects non-blob string', () => {
	assert.equal(parseBlobRef('not-a-ref'), null)
})

test('parseBlobRef rejects invalid hash format', () => {
	assert.equal(parseBlobRef('blob:sha256:../../etc/passwd'), null)
	assert.equal(parseBlobRef('blob:sha256:too-short'), null)
	assert.equal(parseBlobRef(`blob:sha256:${'G'.repeat(64)}`), null)
})

// ═══════════════════════════════════════════════════════════════════════════
// externalizeImageData / resolveImageData
// ═══════════════════════════════════════════════════════════════════════════

test('externalizeImageData stores base64 and returns blob ref', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		const base64 = Buffer.from('image bytes').toString('base64')
		const ref = externalizeImageData(store, base64)

		assert.ok(ref.startsWith('blob:sha256:'))
		assert.ok(store.has(parseBlobRef(ref)!))
	} finally {
		cleanup()
	}
})

test('externalizeImageData passes through existing blob refs', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		const existingRef = `blob:sha256:${'c'.repeat(64)}`
		assert.equal(externalizeImageData(store, existingRef), existingRef)
	} finally {
		cleanup()
	}
})

test('resolveImageData round-trips with externalizeImageData', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		const base64 = Buffer.from('round trip test').toString('base64')
		const ref = externalizeImageData(store, base64)
		const resolved = resolveImageData(store, ref)

		assert.equal(resolved, base64)
	} finally {
		cleanup()
	}
})

test('resolveImageData returns non-ref strings unchanged', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		assert.equal(resolveImageData(store, 'plain text'), 'plain text')
	} finally {
		cleanup()
	}
})

test('resolveImageData returns ref unchanged when blob is missing', () => {
	const { dir, cleanup } = makeTmpDir()
	try {
		const store = new BlobStore(join(dir, 'blobs'))
		const missingRef = `blob:sha256:${'d'.repeat(64)}`
		assert.equal(resolveImageData(store, missingRef), missingRef)
	} finally {
		cleanup()
	}
})
