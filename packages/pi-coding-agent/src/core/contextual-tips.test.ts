import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContextualTips } from "./contextual-tips.js";

const baseCtx = {
	input: "hello world",
	isStreaming: false,
	thinkingLevel: "off" as string,
	contextPercent: undefined as number | undefined,
};

describe("ContextualTips", () => {
	describe("shell-command-prefix tip", () => {
		it("fires for bare shell commands", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "ls -la" });
			assert.ok(result);
			assert.ok(result.includes("looks like a shell command"));
			assert.ok(result.includes("!"));
		});

		it("fires for various known commands", () => {
			for (const cmd of ["pwd", "cd src", "cat file.txt", "grep foo bar", "git status", "npm install", "docker ps"]) {
				const tips = new ContextualTips();
				const result = tips.evaluate({ ...baseCtx, input: cmd });
				assert.ok(result, `Expected tip for "${cmd}"`);
				assert.ok(result.includes("looks like a shell command"));
			}
		});

		it("does not fire for commands already prefixed with !", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "!ls -la" });
			assert.equal(result, null);
		});

		it("does not fire for commands prefixed with !!", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "!!ls -la" });
			assert.equal(result, null);
		});

		it("does not fire for slash commands", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "/clear" });
			assert.equal(result, null);
		});

		it("does not fire for unknown commands", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "please help me fix this bug" });
			assert.equal(result, null);
		});

		it("does not fire for very long inputs", () => {
			const tips = new ContextualTips();
			const longInput = "ls " + "a".repeat(200);
			const result = tips.evaluate({ ...baseCtx, input: longInput });
			assert.equal(result, null);
		});

		it("respects maxShows (2)", () => {
			const tips = new ContextualTips();
			tips.evaluate({ ...baseCtx, input: "ls" });
			tips.evaluate({ ...baseCtx, input: "pwd" });
			const third = tips.evaluate({ ...baseCtx, input: "cat foo" });
			assert.equal(third, null);
		});
	});

	describe("large-paste tip", () => {
		it("fires for large inputs", () => {
			const tips = new ContextualTips();
			const largeInput = "a".repeat(2500);
			const result = tips.evaluate({ ...baseCtx, input: largeInput });
			assert.ok(result);
			assert.ok(result.includes("Large inputs"));
		});

		it("does not fire for normal-length inputs", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "fix the login bug" });
			assert.equal(result, null);
		});

		it("does not fire for large bash commands", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "!" + "a".repeat(2500) });
			assert.equal(result, null);
		});

		it("respects maxShows (2)", () => {
			const tips = new ContextualTips();
			const large = "x".repeat(3000);
			tips.evaluate({ ...baseCtx, input: large });
			tips.evaluate({ ...baseCtx, input: large });
			const third = tips.evaluate({ ...baseCtx, input: large });
			assert.equal(third, null);
		});
	});

	describe("thinking-level-high tip", () => {
		it("fires for short inputs with high thinking", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "what is 2+2?", thinkingLevel: "high" });
			assert.ok(result);
			assert.ok(result.includes("Thinking is set to high"));
		});

		it("fires for xhigh thinking", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "what time is it?", thinkingLevel: "xhigh" });
			assert.ok(result);
			assert.ok(result.includes("Thinking is set to xhigh"));
		});

		it("does not fire for low/medium thinking", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "what is 2+2?", thinkingLevel: "medium" });
			assert.equal(result, null);
		});

		it("does not fire for long inputs", () => {
			const tips = new ContextualTips();
			const longInput = "Please help me refactor this entire authentication module to use JWT tokens instead of session cookies. " +
				"I need to update the middleware, the login handler, and the user model.";
			const result = tips.evaluate({ ...baseCtx, input: longInput, thinkingLevel: "high" });
			assert.equal(result, null);
		});

		it("does not fire for slash commands", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "/model", thinkingLevel: "high" });
			assert.equal(result, null);
		});

		it("respects maxShows (1)", () => {
			const tips = new ContextualTips();
			tips.evaluate({ ...baseCtx, input: "hi", thinkingLevel: "high" });
			const second = tips.evaluate({ ...baseCtx, input: "hello", thinkingLevel: "high" });
			assert.equal(second, null);
		});
	});

	describe("double-bang-reminder tip", () => {
		it("fires after 3+ included bash commands", () => {
			const tips = new ContextualTips();
			tips.recordBashIncluded();
			tips.recordBashIncluded();
			tips.recordBashIncluded();
			const result = tips.evaluate({ ...baseCtx, input: "!ls" });
			assert.ok(result);
			assert.ok(result.includes("!!"));
		});

		it("does not fire with fewer than 3 included commands", () => {
			const tips = new ContextualTips();
			tips.recordBashIncluded();
			tips.recordBashIncluded();
			const result = tips.evaluate({ ...baseCtx, input: "!ls" });
			assert.equal(result, null);
		});

		it("does not fire for !! commands", () => {
			const tips = new ContextualTips();
			tips.recordBashIncluded();
			tips.recordBashIncluded();
			tips.recordBashIncluded();
			const result = tips.evaluate({ ...baseCtx, input: "!!ls" });
			assert.equal(result, null);
		});

		it("respects maxShows (2)", () => {
			const tips = new ContextualTips();
			for (let i = 0; i < 5; i++) tips.recordBashIncluded();
			tips.evaluate({ ...baseCtx, input: "!ls" });
			tips.evaluate({ ...baseCtx, input: "!pwd" });
			const third = tips.evaluate({ ...baseCtx, input: "!cat foo" });
			assert.equal(third, null);
		});
	});

	describe("compaction-nudge tip", () => {
		it("fires when context is >= 70%", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "fix the bug", contextPercent: 75 });
			assert.ok(result);
			assert.ok(result.includes("/compact"));
		});

		it("does not fire when context is < 70%", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "fix the bug", contextPercent: 50 });
			assert.equal(result, null);
		});

		it("does not fire when contextPercent is undefined", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "fix the bug", contextPercent: undefined });
			assert.equal(result, null);
		});

		it("does not fire for slash commands", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "/model", contextPercent: 90 });
			assert.equal(result, null);
		});

		it("respects maxShows (1)", () => {
			const tips = new ContextualTips();
			tips.evaluate({ ...baseCtx, input: "hello", contextPercent: 80 });
			const second = tips.evaluate({ ...baseCtx, input: "world", contextPercent: 85 });
			assert.equal(second, null);
		});
	});

	describe("reset", () => {
		it("resets all show counters", () => {
			const tips = new ContextualTips();
			// Exhaust shell-command-prefix tip
			tips.evaluate({ ...baseCtx, input: "ls" });
			tips.evaluate({ ...baseCtx, input: "pwd" });
			assert.equal(tips.evaluate({ ...baseCtx, input: "cat foo" }), null);

			tips.reset();

			// Should fire again after reset
			const result = tips.evaluate({ ...baseCtx, input: "ls" });
			assert.ok(result);
			assert.ok(result.includes("looks like a shell command"));
		});

		it("resets bash included count", () => {
			const tips = new ContextualTips();
			for (let i = 0; i < 5; i++) tips.recordBashIncluded();
			assert.equal(tips.bashIncludedCount, 5);

			tips.reset();
			assert.equal(tips.bashIncludedCount, 0);
		});
	});

	describe("priority — first match wins", () => {
		it("shell-command-prefix takes priority over compaction nudge", () => {
			const tips = new ContextualTips();
			const result = tips.evaluate({ ...baseCtx, input: "ls", contextPercent: 80 });
			assert.ok(result);
			assert.ok(result.includes("looks like a shell command"));
		});

		it("large-paste takes priority over compaction nudge", () => {
			const tips = new ContextualTips();
			const largeInput = "x".repeat(3000);
			const result = tips.evaluate({ ...baseCtx, input: largeInput, contextPercent: 80 });
			assert.ok(result);
			assert.ok(result.includes("Large inputs"));
		});
	});
});
