import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SessionManager } from "./session-manager.js";

function makeAssistantMessage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
			total: input + output + cacheRead + cacheWrite,
			cost: { total: cost },
		},
	} as any;
}

describe("SessionManager usage totals", () => {
	let dir: string;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tracks assistant usage incrementally without rescanning entries", () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-session-manager-test-"));
		const manager = SessionManager.create(dir, dir);

		manager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] } as any);
		manager.appendMessage(makeAssistantMessage(10, 5, 3, 2, 0.25));
		manager.appendMessage(makeAssistantMessage(7, 4, 1, 0, 0.1));

		assert.deepEqual(manager.getUsageTotals(), {
			input: 17,
			output: 9,
			cacheRead: 4,
			cacheWrite: 2,
			cost: 0.35,
		});
	});

	it("resets totals when starting a new session", () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-session-manager-test-"));
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(makeAssistantMessage(5, 5, 0, 0, 0.05));
		assert.equal(manager.getUsageTotals().input, 5);

		manager.newSession();
		assert.deepEqual(manager.getUsageTotals(), {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		});
	});
});

describe("SessionManager secret redaction on persistence", () => {
	let dir: string;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("scrubs known secret shapes from JSONL on disk", () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-session-redact-test-"));
		const manager = SessionManager.create(dir, dir);

		const leakedKey = "llx-abcDEF1234567890abcDEF1234567890";
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `here is my key: ${leakedKey}` }],
		} as any);
		// Persistence is gated on an assistant message being present.
		manager.appendMessage(makeAssistantMessage(1, 1, 0, 0, 0));

		const sessionFile = manager.getSessionFile();
		assert.ok(sessionFile, "session file should be set");
		const contents = readFileSync(sessionFile!, "utf8");
		assert.ok(
			!contents.includes(leakedKey),
			"raw secret must not appear in persisted JSONL",
		);
		assert.ok(
			contents.includes("[REDACTED:llamacloud]"),
			"redaction placeholder must appear in persisted JSONL",
		);
	});

	it("scrubs secrets from JSONL rewritten by _rewriteFile() during migration", () => {
		// Write a v1 session file (no id/parentId on entries) containing a secret.
		// setSessionFile() will detect version < 3, run migration, and call _rewriteFile()
		// which previously serialised entries without passing them through redaction.
		dir = mkdtempSync(join(tmpdir(), "gsd-session-rewrite-redact-test-"));
		const leakedKey = "sk-ant-api03-abcDEF1234567890abcDEF1234567890xYz";
		const v1Header = JSON.stringify({ type: "session", version: 1, id: "test-session-id", timestamp: new Date().toISOString(), cwd: dir });
		const v1UserMsg = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `secret: ${leakedKey}` }] } });
		const v1AssistantMsg = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: { total: 0 } } } });
		const sessionFile = join(dir, "test-session.jsonl");
		writeFileSync(sessionFile, [v1Header, v1UserMsg, v1AssistantMsg].join("\n") + "\n", "utf8");

		// Loading this file triggers migrateToCurrentVersion() which returns true (v1 → v3),
		// causing _rewriteFile() to rewrite the file. The bug: _rewriteFile() called
		// JSON.stringify(e) without redaction, so the secret would survive on disk.
		const manager = SessionManager.create(dir, dir);
		manager.setSessionFile(sessionFile);

		const contents = readFileSync(sessionFile, "utf8");
		assert.ok(
			!contents.includes(leakedKey),
			"raw secret must not appear in JSONL rewritten by _rewriteFile()",
		);
		assert.ok(
			contents.includes("[REDACTED:anthropic]"),
			"redaction placeholder must appear in JSONL rewritten by _rewriteFile()",
		);
	});
});
