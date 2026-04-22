/**
 * Content-addressed blob store for externalizing large binary data (images) from session JSONL files.
 *
 * Files are stored at `<dir>/<sha256-hex>` with no extension. The SHA-256 hash is computed
 * over the raw binary data (not base64). Content-addressing makes writes idempotent and
 * provides automatic deduplication across sessions.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, accessSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

const BLOB_PREFIX = "blob:sha256:";
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export interface BlobPutResult {
	hash: string;
	path: string;
	get ref(): string;
}

export class BlobStore {
	readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
	}

	/** Write binary data to the blob store. Idempotent — same content → same hash. */
	put(data: Buffer): BlobPutResult {
		const hash = createHash("sha256").update(data).digest("hex");
		const blobPath = join(this.dir, hash);
		const result: BlobPutResult = {
			hash,
			path: blobPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};

		try {
			writeFileSync(blobPath, data, { flag: "wx" }); // Atomic: fails if file exists
		} catch (err: unknown) {
			if (typeof err !== "object" || err === null || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// File already exists — expected for content-addressed storage
		}
		return result;
	}

	/** Read blob by hash, returns Buffer or null if not found. */
	get(hash: string): Buffer | null {
		if (!SHA256_HEX_RE.test(hash)) return null;
		const blobPath = join(this.dir, hash);
		try {
			return readFileSync(blobPath);
		} catch {
			return null;
		}
	}

	/** Check if a blob exists. */
	has(hash: string): boolean {
		if (!SHA256_HEX_RE.test(hash)) return false;
		try {
			accessSync(join(this.dir, hash));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Remove blobs not referenced by any session file.
	 * @param referencedHashes Set of SHA-256 hashes still referenced in session files.
	 * @returns Number of orphaned blobs removed.
	 */
	gc(referencedHashes: Set<string>): number {
		let removed = 0;
		try {
			const entries = readdirSync(this.dir);
			for (const entry of entries) {
				if (!SHA256_HEX_RE.test(entry)) continue;
				if (!referencedHashes.has(entry)) {
					try {
						unlinkSync(join(this.dir, entry));
						removed++;
					} catch {
						// Best-effort removal
					}
				}
			}
		} catch {
			// Blob dir may not exist or be unreadable
		}
		return removed;
	}

	/** Get total size of all blobs in bytes, or 0 if the directory is empty/unreadable. */
	totalSize(): number {
		try {
			const entries = readdirSync(this.dir);
			let total = 0;
			for (const entry of entries) {
				if (!SHA256_HEX_RE.test(entry)) continue;
				try {
					total += statSync(join(this.dir, entry)).size;
				} catch {
					// Skip unreadable files
				}
			}
			return total;
		} catch {
			return 0;
		}
	}
}

/** Check if a data string is a blob reference. */
export function isBlobRef(data: string): boolean {
	return data.startsWith(BLOB_PREFIX);
}

/** Extract the SHA-256 hash from a blob reference string. Returns null if format is invalid. */
export function parseBlobRef(data: string): string | null {
	if (!data.startsWith(BLOB_PREFIX)) return null;
	const hash = data.slice(BLOB_PREFIX.length);
	if (!SHA256_HEX_RE.test(hash)) return null;
	return hash;
}

/**
 * Externalize an image's base64 data to the blob store, returning a blob reference.
 * If the data is already a blob reference, returns it unchanged.
 */
export function externalizeImageData(blobStore: BlobStore, base64Data: string): string {
	if (isBlobRef(base64Data)) return base64Data;
	const buffer = Buffer.from(base64Data, "base64");
	const { ref } = blobStore.put(buffer);
	return ref;
}

/**
 * Resolve a blob reference back to base64 data.
 * If the data is not a blob reference, returns it unchanged.
 * If the blob is missing, returns the ref unchanged.
 */
export function resolveImageData(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = blobStore.get(hash);
	if (!buffer) return data; // Missing blob — return ref as-is

	return buffer.toString("base64");
}
