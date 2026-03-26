import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MemoryStorage } from "./storage.js";

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "gsd-memory-storage-test-"));
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("MemoryStorage debounced persistence", () => {
	let dir: string;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("multiple rapid mutations only trigger one persist write", async () => {
		dir = makeTmpDir();
		const dbPath = join(dir, "test.db");
		const storage = await MemoryStorage.create(dbPath);

		const initialStat = readFileSync(dbPath);
		const initialMtime = initialStat.length;

		storage.upsertThreads([
			{ threadId: "t1", filePath: "/a.txt", fileSize: 100, fileMtime: 1000, cwd: "/proj" },
		]);
		storage.upsertThreads([
			{ threadId: "t2", filePath: "/b.txt", fileSize: 200, fileMtime: 2000, cwd: "/proj" },
		]);
		storage.upsertThreads([
			{ threadId: "t3", filePath: "/c.txt", fileSize: 300, fileMtime: 3000, cwd: "/proj" },
		]);

		const afterMutationsBuf = readFileSync(dbPath);
		assert.deepEqual(
			afterMutationsBuf,
			initialStat,
			"File should not have been written yet (debounce window has not elapsed)",
		);

		await wait(700);

		const afterDebounceBuf = readFileSync(dbPath);
		assert.notDeepEqual(
			afterDebounceBuf,
			initialStat,
			"File should have been written after debounce window elapsed",
		);

		const stats = storage.getStats();
		assert.equal(stats.totalThreads, 3);

		storage.close();
	});

	it("close() flushes pending changes immediately without waiting for debounce", async () => {
		dir = makeTmpDir();
		const dbPath = join(dir, "test.db");
		const storage = await MemoryStorage.create(dbPath);

		const initialBuf = readFileSync(dbPath);

		storage.upsertThreads([
			{ threadId: "t1", filePath: "/a.txt", fileSize: 100, fileMtime: 1000, cwd: "/proj" },
		]);

		const beforeCloseBuf = readFileSync(dbPath);
		assert.deepEqual(
			beforeCloseBuf,
			initialBuf,
			"File should not have been written yet (debounce window has not elapsed)",
		);

		storage.close();

		const afterCloseBuf = readFileSync(dbPath);
		assert.notDeepEqual(
			afterCloseBuf,
			initialBuf,
			"File should have been written immediately on close()",
		);

		const reopened = await MemoryStorage.create(dbPath);
		const stats = reopened.getStats();
		assert.equal(stats.totalThreads, 1, "Data should be persisted and readable after close");
		reopened.close();
	});
});
