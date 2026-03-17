import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteFileSync } from "./fs-utils.js";

describe("atomicWriteFileSync", () => {
	it("writes file content atomically", () => {
		const dir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
		try {
			const filePath = join(dir, "test.txt");
			atomicWriteFileSync(filePath, "hello world");
			assert.equal(readFileSync(filePath, "utf-8"), "hello world");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("overwrites existing file atomically", () => {
		const dir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
		try {
			const filePath = join(dir, "test.txt");
			atomicWriteFileSync(filePath, "first");
			atomicWriteFileSync(filePath, "second");
			assert.equal(readFileSync(filePath, "utf-8"), "second");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not leave .tmp file after successful write", () => {
		const dir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
		try {
			const filePath = join(dir, "test.txt");
			atomicWriteFileSync(filePath, "content");
			assert.equal(existsSync(filePath + ".tmp"), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("supports Buffer content", () => {
		const dir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
		try {
			const filePath = join(dir, "test.bin");
			const buf = Buffer.from([0x00, 0x01, 0x02, 0xff]);
			atomicWriteFileSync(filePath, buf);
			const result = readFileSync(filePath);
			assert.deepEqual(result, buf);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("supports encoding parameter", () => {
		const dir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
		try {
			const filePath = join(dir, "test.txt");
			atomicWriteFileSync(filePath, "utf8 content", "utf-8");
			assert.equal(readFileSync(filePath, "utf-8"), "utf8 content");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
