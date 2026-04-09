/**
 * Tests for read tool offset clamping (#3007).
 *
 * When offset exceeds file length, the read tool should clamp to the
 * last line instead of throwing, preventing downstream JSON parse errors
 * in auto-mode milestone completion.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createReadTool } from "../../packages/pi-coding-agent/src/core/tools/read.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "read-tool-test-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeLines(dir: string, name: string, lineCount: number): string {
	const lines = Array.from({ length: lineCount }, (_, i) => `Line ${i + 1}: content`);
	const filePath = join(dir, name);
	writeFileSync(filePath, lines.join("\n"));
	return filePath;
}

// ═══════════════════════════════════════════════════════════════════════════
// Offset beyond file bounds — should clamp, not throw (#3007)
// ═══════════════════════════════════════════════════════════════════════════

test("read tool: offset exceeding file length should NOT throw (#3007)", async (t) => {
	const { dir, cleanup } = makeTmpDir();
	t.after(cleanup);
	writeLines(dir, "small-artifact.md", 13);

	const readTool = createReadTool(dir);

	// offset 30 on a 13-line file — exact reproduction of #3007
	const result = await readTool.execute("test-call", {
		path: "small-artifact.md",
		offset: 30,
	});

	assert.ok(result, "should return a result, not throw");
	assert.ok(result.content, "should have content");
	assert.ok(result.content.length > 0, "should have at least one content block");

	const text = (result.content[0] as any).text as string;
	assert.ok(typeof text === "string", "first content block should be text");
	// Should include the last line of the file (clamped)
	assert.ok(text.includes("Line 13"), "should include last line of file after clamping");
});

test("read tool: offset 100 on a 5-line file clamps to last line", async (t) => {
	const { dir, cleanup } = makeTmpDir();
	t.after(cleanup);
	writeLines(dir, "tiny-file.txt", 5);

	const readTool = createReadTool(dir);
	const result = await readTool.execute("test-call", {
		path: "tiny-file.txt",
		offset: 100,
	});

	const text = (result.content[0] as any).text as string;
	assert.ok(text.includes("Line 5"), "should include the last line of the file");
});

test("read tool: offset at exact last line works normally", async (t) => {
	const { dir, cleanup } = makeTmpDir();
	t.after(cleanup);
	writeLines(dir, "exact-offset.txt", 5);

	const readTool = createReadTool(dir);
	// offset 5 on a 5-line file — should return line 5 (valid, no clamping needed)
	const result = await readTool.execute("test-call", {
		path: "exact-offset.txt",
		offset: 5,
	});

	const text = (result.content[0] as any).text as string;
	assert.ok(text.includes("Line 5"), "should include line 5");
});

test("read tool: clamped offset includes notice about adjustment", async (t) => {
	const { dir, cleanup } = makeTmpDir();
	t.after(cleanup);
	writeLines(dir, "notice-test.md", 10);

	const readTool = createReadTool(dir);
	const result = await readTool.execute("test-call", {
		path: "notice-test.md",
		offset: 50,
	});

	const text = (result.content[0] as any).text as string;
	// Should contain some notice that the offset was adjusted
	assert.ok(
		text.includes("clamped") || text.includes("adjusted") || text.includes("beyond"),
		`should indicate offset was clamped, got: ${text.slice(0, 200)}`,
	);
});
