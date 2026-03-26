import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isProjectTrusted, trustProject, getUntrustedExtensionPaths } from "./project-trust.js";
import { containsTypeScriptSyntax, loadExtensions } from "./loader.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "loader-test-"));
}

function cleanDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

// ─── isProjectTrusted ─────────────────────────────────────────────────────────

describe("isProjectTrusted", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = makeTempDir();
	});

	afterEach(() => {
		cleanDir(agentDir);
	});

	it("returns false when no trusted-projects.json exists", () => {
		assert.equal(isProjectTrusted("/some/project", agentDir), false);
	});

	it("returns false for an untrusted project path", () => {
		trustProject("/trusted/project", agentDir);
		assert.equal(isProjectTrusted("/other/project", agentDir), false);
	});

	it("returns true after trustProject is called for that path", () => {
		trustProject("/trusted/project", agentDir);
		assert.equal(isProjectTrusted("/trusted/project", agentDir), true);
	});

	it("canonicalizes paths before comparison (trailing slash)", () => {
		trustProject("/my/project/", agentDir);
		assert.equal(isProjectTrusted("/my/project", agentDir), true);
	});

	it("returns false when trusted-projects.json is malformed JSON", () => {
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "trusted-projects.json"), "not json");
		assert.equal(isProjectTrusted("/any/project", agentDir), false);
	});

	it("returns false when trusted-projects.json contains non-array", () => {
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "trusted-projects.json"), JSON.stringify({ foo: "bar" }));
		assert.equal(isProjectTrusted("/any/project", agentDir), false);
	});
});

// ─── trustProject ─────────────────────────────────────────────────────────────

describe("trustProject", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = makeTempDir();
	});

	afterEach(() => {
		cleanDir(agentDir);
	});

	it("creates agentDir if it does not exist", () => {
		const nested = path.join(agentDir, "deeply", "nested");
		trustProject("/a/project", nested);
		assert.ok(fs.existsSync(nested));
	});

	it("persists the trusted path to trusted-projects.json", () => {
		trustProject("/a/project", agentDir);
		const content = JSON.parse(fs.readFileSync(path.join(agentDir, "trusted-projects.json"), "utf-8"));
		assert.ok(Array.isArray(content));
		assert.ok(content.includes(path.resolve("/a/project")));
	});

	it("accumulates multiple trusted projects", () => {
		trustProject("/project/one", agentDir);
		trustProject("/project/two", agentDir);
		const content = JSON.parse(fs.readFileSync(path.join(agentDir, "trusted-projects.json"), "utf-8"));
		assert.equal(content.length, 2);
	});

	it("does not duplicate already-trusted paths", () => {
		trustProject("/project/one", agentDir);
		trustProject("/project/one", agentDir);
		const content = JSON.parse(fs.readFileSync(path.join(agentDir, "trusted-projects.json"), "utf-8"));
		assert.equal(content.length, 1);
	});
});

// ─── getUntrustedExtensionPaths ───────────────────────────────────────────────

describe("getUntrustedExtensionPaths", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = makeTempDir();
	});

	afterEach(() => {
		cleanDir(agentDir);
	});

	it("returns all paths when project is not trusted", () => {
		const paths = ["/proj/.pi/extensions/a.ts", "/proj/.pi/extensions/b.ts"];
		const result = getUntrustedExtensionPaths("/proj", paths, agentDir);
		assert.deepEqual(result, paths);
	});

	it("returns empty array when project is trusted", () => {
		trustProject("/proj", agentDir);
		const paths = ["/proj/.pi/extensions/a.ts", "/proj/.pi/extensions/b.ts"];
		const result = getUntrustedExtensionPaths("/proj", paths, agentDir);
		assert.deepEqual(result, []);
	});

	it("returns empty array when extension paths list is empty regardless of trust", () => {
		const result = getUntrustedExtensionPaths("/proj", [], agentDir);
		assert.deepEqual(result, []);
	});

	it("trusting one project does not affect another", () => {
		trustProject("/project/a", agentDir);
		const paths = ["/project/b/.pi/extensions/evil.ts"];
		const result = getUntrustedExtensionPaths("/project/b", paths, agentDir);
		assert.deepEqual(result, paths);
	});
});

// ─── containsTypeScriptSyntax ─────────────────────────────────────────────────

describe("containsTypeScriptSyntax", () => {
	it("detects parameter type annotations", () => {
		assert.ok(containsTypeScriptSyntax(`export default function activate(api: ExtensionAPI) {}`));
	});

	it("detects interface declarations", () => {
		assert.ok(containsTypeScriptSyntax(`interface Config { name: string; }`));
	});

	it("detects type alias declarations", () => {
		assert.ok(containsTypeScriptSyntax(`type Handler = (event: string) => void;`));
	});

	it("detects enum declarations", () => {
		assert.ok(containsTypeScriptSyntax(`enum Direction { Up, Down, Left, Right }`));
	});

	it("detects return type annotations", () => {
		assert.ok(containsTypeScriptSyntax(`function foo(): Promise<void> {}`));
	});

	it("detects generic type parameters on functions", () => {
		assert.ok(containsTypeScriptSyntax(`function identity<T>(arg) { return arg; }`));
	});

	it("detects variable type annotations", () => {
		assert.ok(containsTypeScriptSyntax(`const name: string = "hello";`));
	});

	it("returns false for plain JavaScript", () => {
		assert.equal(containsTypeScriptSyntax(`export default function activate(api) { api.on("init", () => {}); }`), false);
	});

	it("returns false for empty string", () => {
		assert.equal(containsTypeScriptSyntax(""), false);
	});

	it("returns false for JSDoc comments with type-like syntax", () => {
		// JSDoc uses different syntax: @param {string} name
		assert.equal(containsTypeScriptSyntax(`/** @param {string} name */\nexport default function activate(api) {}`), false);
	});
});

// ─── loadExtensions: TypeScript syntax in .js files ───────────────────────────

describe("loadExtensions", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
	});

	afterEach(() => {
		cleanDir(tmpDir);
	});

	it("reports helpful error when .js file contains TypeScript syntax", async () => {
		// Create a .js file that uses TypeScript type annotations
		const extPath = path.join(tmpDir, "my-extension.js");
		fs.writeFileSync(
			extPath,
			`export default function activate(api: ExtensionAPI) {\n  api.on("init", async () => {});\n}\n`,
		);

		const result = await loadExtensions([extPath], tmpDir);

		assert.equal(result.errors.length, 1);
		const errorMsg = result.errors[0].error;
		// The error should mention TypeScript syntax and suggest .ts extension
		assert.ok(
			/TypeScript/.test(errorMsg) && /\.ts\b/.test(errorMsg),
			`Expected error to mention TypeScript syntax and .ts extension, got: ${errorMsg}`,
		);
	});

	it("reports helpful error when .js file contains TS interface declaration", async () => {
		const extPath = path.join(tmpDir, "typed-ext.js");
		fs.writeFileSync(
			extPath,
			`interface Config { name: string; }\nexport default function activate(api) { return; }\n`,
		);

		const result = await loadExtensions([extPath], tmpDir);

		assert.equal(result.errors.length, 1);
		const errorMsg = result.errors[0].error;
		assert.ok(
			/TypeScript/.test(errorMsg) && /\.ts\b/.test(errorMsg),
			`Expected error to mention TypeScript syntax and .ts extension, got: ${errorMsg}`,
		);
	});
});
