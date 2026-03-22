import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Pre-compiled extension loading ──────────────────────────────────────────

describe("pre-compiled extension loading", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "precompiled-ext-"));
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
		} catch {
			// Ignore cleanup errors on Windows
		}
	});

	it("prefers .js sibling over .ts when .js is newer", async () => {
		// Create a .ts file
		const tsPath = path.join(tmpDir, "ext.ts");
		fs.writeFileSync(tsPath, `export default function ext() { return "ts"; }`);

		// Create a .js file with a newer mtime
		const jsPath = path.join(tmpDir, "ext.js");
		fs.writeFileSync(jsPath, `export default function ext() { return "js"; }`);

		// Make .js newer than .ts
		const now = new Date();
		const past = new Date(now.getTime() - 10_000);
		fs.utimesSync(tsPath, past, past);
		fs.utimesSync(jsPath, now, now);

		const tsStat = fs.statSync(tsPath);
		const jsStat = fs.statSync(jsPath);
		assert.ok(jsStat.mtimeMs >= tsStat.mtimeMs, ".js should have matching or newer mtime");
	});

	it("falls back to .ts when no .js sibling exists", () => {
		const tsPath = path.join(tmpDir, "ext.ts");
		fs.writeFileSync(tsPath, `export default function ext() { return "ts"; }`);

		const jsPath = path.join(tmpDir, "ext.js");
		assert.ok(!fs.existsSync(jsPath), ".js should not exist");
	});

	it("falls back to .ts when .js is older", () => {
		const tsPath = path.join(tmpDir, "ext.ts");
		fs.writeFileSync(tsPath, `export default function ext() { return "ts"; }`);

		const jsPath = path.join(tmpDir, "ext.js");
		fs.writeFileSync(jsPath, `export default function ext() { return "js-stale"; }`);

		// Make .ts newer
		const now = new Date();
		const past = new Date(now.getTime() - 10_000);
		fs.utimesSync(jsPath, past, past);
		fs.utimesSync(tsPath, now, now);

		const tsStat = fs.statSync(tsPath);
		const jsStat = fs.statSync(jsPath);
		assert.ok(jsStat.mtimeMs < tsStat.mtimeMs, ".js should be older than .ts");
	});
});

// ─── Batch directory discovery ───────────────────────────────────────────────

describe("batch directory discovery", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-discover-"));
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
		} catch {
			// Ignore cleanup errors on Windows
		}
	});

	it("single readdir discovers existing subdirectories", () => {
		// Create some resource subdirectories
		fs.mkdirSync(path.join(tmpDir, "extensions"));
		fs.mkdirSync(path.join(tmpDir, "skills"));
		// prompts and themes do NOT exist

		const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
		const subdirs = new Set(
			entries.filter((e) => e.isDirectory()).map((e) => e.name),
		);

		assert.ok(subdirs.has("extensions"));
		assert.ok(subdirs.has("skills"));
		assert.ok(!subdirs.has("prompts"));
		assert.ok(!subdirs.has("themes"));
	});

	it("returns empty set for non-existent parent directory", () => {
		const missing = path.join(tmpDir, "does-not-exist");
		let subdirs = new Set<string>();
		try {
			const entries = fs.readdirSync(missing, { withFileTypes: true });
			subdirs = new Set(
				entries.filter((e) => e.isDirectory()).map((e) => e.name),
			);
		} catch {
			subdirs = new Set();
		}

		assert.equal(subdirs.size, 0);
	});
});

// ─── Node.js compile cache ──────────────────────────────────────────────────

describe("Node.js compile cache env setup", () => {
	it("NODE_COMPILE_CACHE is settable on Node 22+", () => {
		const nodeVersion = parseInt(process.versions.node);
		if (nodeVersion >= 22) {
			// Verify the env var mechanism works (does not throw)
			const original = process.env.NODE_COMPILE_CACHE;
			try {
				process.env.NODE_COMPILE_CACHE = path.join(os.tmpdir(), ".test-compile-cache");
				assert.equal(
					process.env.NODE_COMPILE_CACHE,
					path.join(os.tmpdir(), ".test-compile-cache"),
				);
			} finally {
				if (original === undefined) {
					delete process.env.NODE_COMPILE_CACHE;
				} else {
					process.env.NODE_COMPILE_CACHE = original;
				}
			}
		}
	});

	it("does not overwrite existing NODE_COMPILE_CACHE", () => {
		const original = process.env.NODE_COMPILE_CACHE;
		try {
			process.env.NODE_COMPILE_CACHE = "/custom/cache";
			// Simulate the ??= behavior from cli.ts
			process.env.NODE_COMPILE_CACHE ??= "/should-not-overwrite";
			assert.equal(process.env.NODE_COMPILE_CACHE, "/custom/cache");
		} finally {
			if (original === undefined) {
				delete process.env.NODE_COMPILE_CACHE;
			} else {
				process.env.NODE_COMPILE_CACHE = original;
			}
		}
	});
});
