import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
	readManifestRuntimeDeps,
	collectRuntimeDependencies,
	verifyRuntimeDependencies,
	resolveLocalSourcePath,
} from "./lifecycle-hooks.js";

function tmpDir(prefix: string, t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-lh-${prefix}-`));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// ─── readManifestRuntimeDeps ──────────────────────────────────────────────────

describe("readManifestRuntimeDeps", () => {
	it("returns empty array when manifest file is missing", (t) => {
		const dir = tmpDir("no-manifest", t);
		assert.deepEqual(readManifestRuntimeDeps(dir), []);
	});

	it("returns empty array for malformed JSON", (t) => {
		const dir = tmpDir("bad-json", t);
		writeFileSync(join(dir, "extension-manifest.json"), "not json{{{", "utf-8");
		assert.deepEqual(readManifestRuntimeDeps(dir), []);
	});

	it("returns runtime deps from valid manifest", (t) => {
		const dir = tmpDir("valid", t);
		writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
			dependencies: { runtime: ["claude", "node"] },
		}), "utf-8");
		assert.deepEqual(readManifestRuntimeDeps(dir), ["claude", "node"]);
	});

	it("returns empty array when dependencies exists but runtime is missing", (t) => {
		const dir = tmpDir("no-runtime", t);
		writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
			dependencies: {},
		}), "utf-8");
		assert.deepEqual(readManifestRuntimeDeps(dir), []);
	});

	it("returns empty array when runtime is empty", (t) => {
		const dir = tmpDir("empty-runtime", t);
		writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
			dependencies: { runtime: [] },
		}), "utf-8");
		assert.deepEqual(readManifestRuntimeDeps(dir), []);
	});

	it("filters out non-string entries in runtime array", (t) => {
		const dir = tmpDir("mixed-types", t);
		writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
			dependencies: { runtime: [123, null, "node", false, "python"] },
		}), "utf-8");
		assert.deepEqual(readManifestRuntimeDeps(dir), ["node", "python"]);
	});

	it("returns empty array when no dependencies field at all", (t) => {
		const dir = tmpDir("no-deps-field", t);
		writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
			id: "test",
			name: "Test",
		}), "utf-8");
		assert.deepEqual(readManifestRuntimeDeps(dir), []);
	});
});

// ─── collectRuntimeDependencies ───────────────────────────────────────────────

describe("collectRuntimeDependencies", () => {
	it("aggregates deps from installedPath manifest", (t) => {
		const dir = tmpDir("collect-installed", t);
		writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
			dependencies: { runtime: ["claude"] },
		}), "utf-8");
		assert.deepEqual(collectRuntimeDependencies(dir, []), ["claude"]);
	});

	it("aggregates deps from entry path directory manifests", (t) => {
		const root = tmpDir("collect-entry", t);
		const installedDir = join(root, "installed");
		const entryDir = join(root, "entry");
		mkdirSync(installedDir, { recursive: true });
		mkdirSync(entryDir, { recursive: true });
		writeFileSync(join(entryDir, "extension-manifest.json"), JSON.stringify({
			dependencies: { runtime: ["python"] },
		}), "utf-8");
		const deps = collectRuntimeDependencies(installedDir, [join(entryDir, "index.ts")]);
		assert.deepEqual(deps, ["python"]);
	});

	it("deduplicates across multiple directories", (t) => {
		const root = tmpDir("collect-dedup", t);
		const dir1 = join(root, "dir1");
		const dir2 = join(root, "dir2");
		mkdirSync(dir1, { recursive: true });
		mkdirSync(dir2, { recursive: true });
		writeFileSync(join(dir1, "extension-manifest.json"), JSON.stringify({
			dependencies: { runtime: ["node", "python"] },
		}), "utf-8");
		writeFileSync(join(dir2, "extension-manifest.json"), JSON.stringify({
			dependencies: { runtime: ["python", "claude"] },
		}), "utf-8");
		const deps = collectRuntimeDependencies(dir1, [join(dir2, "index.ts")]);
		assert.equal(deps.length, 3);
		assert.ok(deps.includes("node"));
		assert.ok(deps.includes("python"));
		assert.ok(deps.includes("claude"));
	});

	it("returns empty when no directories have manifests", (t) => {
		const dir = tmpDir("collect-empty", t);
		assert.deepEqual(collectRuntimeDependencies(dir, []), []);
	});
});

// ─── verifyRuntimeDependencies ────────────────────────────────────────────────

describe("verifyRuntimeDependencies", () => {
	it("does not throw for empty deps array", () => {
		assert.doesNotThrow(() => verifyRuntimeDependencies([], "test-source", "pi"));
	});

	it("does not throw when all deps are present", () => {
		assert.doesNotThrow(() => verifyRuntimeDependencies(["node"], "test-source", "pi"));
	});

	it("throws for missing dep with 'Missing runtime dependencies' message", () => {
		assert.throws(
			() => verifyRuntimeDependencies(["__nonexistent_dep_for_test__"], "test-source", "pi"),
			(err: Error) => {
				assert.ok(err.message.includes("Missing runtime dependencies"));
				assert.ok(err.message.includes("__nonexistent_dep_for_test__"));
				return true;
			},
		);
	});

	it("lists all missing deps in error message", () => {
		assert.throws(
			() => verifyRuntimeDependencies(["__missing_1__", "__missing_2__"], "test-source", "pi"),
			(err: Error) => {
				assert.ok(err.message.includes("__missing_1__"));
				assert.ok(err.message.includes("__missing_2__"));
				return true;
			},
		);
	});

	it("includes appName and source in error for retry hint", () => {
		assert.throws(
			() => verifyRuntimeDependencies(["__missing__"], "github:user/repo", "gsd"),
			(err: Error) => {
				assert.ok(err.message.includes("gsd"));
				assert.ok(err.message.includes("github:user/repo"));
				return true;
			},
		);
	});
});

// ─── resolveLocalSourcePath ───────────────────────────────────────────────────

describe("resolveLocalSourcePath", () => {
	it("returns undefined for empty string", () => {
		assert.equal(resolveLocalSourcePath("", "/tmp"), undefined);
	});

	it("returns undefined for npm: source", () => {
		assert.equal(resolveLocalSourcePath("npm:@foo/bar", "/tmp"), undefined);
	});

	it("returns undefined for git URL", () => {
		assert.equal(resolveLocalSourcePath("git:github.com/user/repo", "/tmp"), undefined);
	});

	it("returns undefined for https git URL", () => {
		assert.equal(resolveLocalSourcePath("https://github.com/user/repo", "/tmp"), undefined);
	});

	it("resolves ~ to homedir", () => {
		const result = resolveLocalSourcePath("~", "/tmp");
		if (existsSync(homedir())) {
			assert.equal(result, homedir());
		} else {
			assert.equal(result, undefined);
		}
	});

	it("resolves ~/path relative to homedir", () => {
		const result = resolveLocalSourcePath("~/", "/tmp");
		if (existsSync(homedir())) {
			assert.equal(result, homedir());
		} else {
			assert.equal(result, undefined);
		}
	});

	it("resolves relative path that exists", (t) => {
		const dir = tmpDir("resolve-rel", t);
		const sub = join(dir, "myext");
		mkdirSync(sub, { recursive: true });
		const result = resolveLocalSourcePath("myext", dir);
		assert.equal(result, resolve(dir, "myext"));
	});

	it("returns undefined for relative path that does not exist", (t) => {
		const dir = tmpDir("resolve-noexist", t);
		assert.equal(resolveLocalSourcePath("nonexistent", dir), undefined);
	});

	it("resolves absolute path that exists", (t) => {
		const dir = tmpDir("resolve-abs", t);
		assert.equal(resolveLocalSourcePath(dir, "/irrelevant"), dir);
	});

	it("returns undefined for absolute path that does not exist", () => {
		assert.equal(resolveLocalSourcePath("/tmp/__nonexistent_path_for_test__", "/tmp"), undefined);
	});
});
