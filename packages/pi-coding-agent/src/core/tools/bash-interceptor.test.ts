import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	checkBashInterception,
	compileInterceptor,
	DEFAULT_BASH_INTERCEPTOR_RULES,
	type BashInterceptorRule,
} from "./bash-interceptor.js";

const ALL_TOOLS = ["read", "grep", "find", "edit", "write"];
const NO_TOOLS: string[] = [];

describe("checkBashInterception", () => {
	describe("read rule (cat/head/tail/less/more)", () => {
		it("blocks cat with a file argument", () => {
			const r = checkBashInterception("cat README.md", ALL_TOOLS);
			assert.equal(r.block, true);
			assert.equal(r.suggestedTool, "read");
		});

		it("blocks head and tail", () => {
			assert.equal(checkBashInterception("head -n 20 file.ts", ALL_TOOLS).block, true);
			assert.equal(checkBashInterception("tail -f app.log", ALL_TOOLS).block, true);
		});

		it("does NOT block cat used as heredoc (cat <<EOF)", () => {
			const r = checkBashInterception("cat <<EOF > file.txt", ALL_TOOLS);
			assert.notEqual(r.suggestedTool, "read");
		});

		it("does NOT block when read tool is absent", () => {
			assert.equal(checkBashInterception("cat README.md", NO_TOOLS).block, false);
			assert.equal(checkBashInterception("cat README.md", ["grep"]).block, false);
		});
	});

	describe("grep rule", () => {
		it("blocks grep and rg", () => {
			assert.equal(checkBashInterception("grep foo bar.ts", ALL_TOOLS).block, true);
			assert.equal(checkBashInterception("rg -r pattern .", ALL_TOOLS).block, true);
		});

		it("blocks grep with leading whitespace", () => {
			assert.equal(checkBashInterception("  grep -r foo .", ALL_TOOLS).block, true);
		});

		it("does NOT block when grep tool is absent", () => {
			assert.equal(checkBashInterception("grep foo bar", ["read", "edit"]).block, false);
		});
	});

	describe("find rule", () => {
		it("blocks find with -name flag", () => {
			assert.equal(checkBashInterception('find . -name "*.ts"', ALL_TOOLS).block, true);
		});

		it("blocks find with -type flag", () => {
			assert.equal(checkBashInterception("find /tmp -maxdepth 1 -type f", ALL_TOOLS).block, true);
		});

		it("does NOT block find without name/type flags", () => {
			assert.equal(checkBashInterception("find /tmp -maxdepth 1", ALL_TOOLS).block, false);
		});

		it("does NOT block when find tool is absent", () => {
			assert.equal(checkBashInterception('find . -name "*.ts"', ["read", "grep"]).block, false);
		});
	});

	describe("edit rule (sed/perl/awk)", () => {
		it("blocks sed -i", () => {
			assert.equal(checkBashInterception("sed -i 's/foo/bar/' file.ts", ALL_TOOLS).block, true);
			assert.equal(checkBashInterception("sed --in-place 's/x/y/' f", ALL_TOOLS).block, true);
		});

		it("does NOT block sed without -i (read-only)", () => {
			assert.equal(checkBashInterception("sed 's/foo/bar/' file.ts", ALL_TOOLS).block, false);
		});

		it("blocks perl -pi and perl -p -i", () => {
			assert.equal(checkBashInterception("perl -pi -e 's/foo/bar/' file", ALL_TOOLS).block, true);
			assert.equal(checkBashInterception("perl -p -i -e 's/x/y/' f", ALL_TOOLS).block, true);
		});

		it("blocks awk -i inplace", () => {
			assert.equal(checkBashInterception("awk -i inplace '{print}' file", ALL_TOOLS).block, true);
		});

		it("does NOT block when edit tool is absent", () => {
			assert.equal(checkBashInterception("sed -i 's/a/b/' f", ["read", "grep"]).block, false);
		});
	});

	describe("write rule (echo/printf/heredoc redirect)", () => {
		it("blocks echo with > redirect", () => {
			assert.equal(checkBashInterception("echo hello > file.txt", ALL_TOOLS).block, true);
		});

		it("blocks printf with > redirect", () => {
			assert.equal(checkBashInterception('printf "%s" content > out.txt', ALL_TOOLS).block, true);
		});

		it("does NOT block echo without redirect", () => {
			assert.equal(checkBashInterception("echo hello", ALL_TOOLS).block, false);
		});

		it("does NOT block >> append redirect (write tool does not support appending)", () => {
			assert.equal(checkBashInterception("echo hello >> file.txt", ALL_TOOLS).block, false);
		});

		it("does NOT block stderr redirect (2>)", () => {
			assert.equal(checkBashInterception("echo test 2> /dev/null", ALL_TOOLS).block, false);
		});

		it("does NOT block pipe (echo foo | grep bar)", () => {
			assert.equal(checkBashInterception("echo foo | grep bar", ALL_TOOLS).block, false);
		});

		it("does NOT block when write tool is absent", () => {
			assert.equal(checkBashInterception("echo hello > file.txt", ["read", "grep"]).block, false);
		});
	});

	describe("pass-through commands", () => {
		it("passes npm install", () => {
			assert.equal(checkBashInterception("npm install", ALL_TOOLS).block, false);
		});

		it("passes ls > output.txt (not an echo/printf/cat)", () => {
			assert.equal(checkBashInterception("ls > output.txt", ALL_TOOLS).block, false);
		});

		it("passes tee file.txt", () => {
			assert.equal(checkBashInterception("tee file.txt", ALL_TOOLS).block, false);
		});

		it("passes git log", () => {
			assert.equal(checkBashInterception("git log --oneline", ALL_TOOLS).block, false);
		});
	});

	describe("block message content", () => {
		it("includes the original command in the block message", () => {
			const r = checkBashInterception("cat README.md", ALL_TOOLS);
			assert.ok(r.message?.includes("cat README.md"), "message should contain original command");
		});

		it("returns block:false with no message when not blocked", () => {
			const r = checkBashInterception("npm install", ALL_TOOLS);
			assert.equal(r.block, false);
			assert.equal(r.message, undefined);
		});
	});
});

describe("compileInterceptor", () => {
	it("produces same results as checkBashInterception", () => {
		const interceptor = compileInterceptor(DEFAULT_BASH_INTERCEPTOR_RULES);
		const cases: [string, string[], boolean][] = [
			["cat README.md", ALL_TOOLS, true],
			["npm install", ALL_TOOLS, false],
			["grep foo bar", ALL_TOOLS, true],
			["echo hello >> file", ALL_TOOLS, false],
			["echo test 2> /dev/null", ALL_TOOLS, false],
		];
		for (const [cmd, tools, expected] of cases) {
			assert.equal(
				interceptor.check(cmd, tools).block,
				expected,
				`pre-compiled: "${cmd}" expected block=${expected}`,
			);
		}
	});

	it("silently skips rules with invalid regex patterns", () => {
		const rules: BashInterceptorRule[] = [
			{ pattern: "[invalid(", tool: "read", message: "broken" },
			{ pattern: "^\\s*cat\\s+", tool: "read", message: "valid" },
		];
		const interceptor = compileInterceptor(rules);
		assert.equal(interceptor.check("cat file.txt", ["read"]).block, true);
	});

	it("returns block:false when available tools list is empty", () => {
		const interceptor = compileInterceptor(DEFAULT_BASH_INTERCEPTOR_RULES);
		assert.equal(interceptor.check("cat README.md", []).block, false);
	});

	it("allows custom rule override", () => {
		const customRules: BashInterceptorRule[] = [
			{ pattern: "^\\s*curl\\s+", tool: "fetch", message: "Use fetch tool instead." },
		];
		const interceptor = compileInterceptor(customRules);
		assert.equal(interceptor.check("curl https://example.com", ["fetch"]).block, true);
		// default rules not active
		assert.equal(interceptor.check("cat file.txt", ["read"]).block, false);
	});
});
