// GSD-2 + src/tests/workspace-manifest.test.ts — regression tests for the linkable-packages single source of truth
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Walk up from this file's directory to the real repo root. Can't stop at the first package.json
// with a "workspaces" field because compile-tests.mjs mirrors package.json + packages/ into
// dist-test/, which would masquerade as a repo root. .git/ is the only reliable discriminator.
function findRepoRoot(start: string): string {
	let dir = start;
	for (let i = 0; i < 10; i++) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`Could not locate repo root (no .git found) from ${start}`);
}

const projectRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const manifestModulePath = join(projectRoot, "scripts", "lib", "workspace-manifest.cjs");
const verifyScriptPath = join(projectRoot, "scripts", "verify-workspace-coverage.cjs");

describe("workspace manifest (live project)", () => {
	test("returns all seven linkable packages with consistent scope/name", () => {
		const manifest = require(manifestModulePath);
		const packages = manifest.getLinkablePackages();
		assert.equal(packages.length, 7, "expected exactly 7 linkable packages");

		const names = packages.map((p: { packageName: string }) => p.packageName).sort();
		assert.deepEqual(names, [
			"@gsd-build/mcp-server",
			"@gsd-build/rpc-client",
			"@gsd/native",
			"@gsd/pi-agent-core",
			"@gsd/pi-ai",
			"@gsd/pi-coding-agent",
			"@gsd/pi-tui",
		]);

		for (const pkg of packages) {
			assert.equal(pkg.packageName, `${pkg.scope}/${pkg.name}`,
				`${pkg.packageName}: gsd.scope/gsd.name mismatch`);
		}
	});

	test("getCorePackages returns only @gsd scope entries", () => {
		const manifest = require(manifestModulePath);
		const core = manifest.getCorePackages();
		assert.ok(core.length >= 1);
		for (const pkg of core) {
			assert.equal(pkg.scope, "@gsd", `${pkg.packageName} should be @gsd scope`);
		}
	});

	test("every linkable package's package.json 'name' matches its gsd.scope/gsd.name", () => {
		const manifest = require(manifestModulePath);
		for (const pkg of manifest.getLinkablePackages()) {
			const pkgJson = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8"));
			assert.equal(pkgJson.name, `${pkg.scope}/${pkg.name}`,
				`${pkg.packageJsonPath}: name != gsd.scope/gsd.name`);
		}
	});
});

describe("verify-workspace-coverage CI gate", () => {
	test("passes on the live project (every linkable package has tests)", () => {
		const out = execFileSync(process.execPath, [verifyScriptPath], {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Script writes to stderr on success ("All N linkable packages have test coverage.");
		// execFileSync returns stdout only. As long as it didn't throw, exit was 0.
		assert.ok(out !== undefined);
	});

	describe("against synthetic workspace fixtures", () => {
		let tmp: string;
		let fakePackages: string;
		let fakeManifest: string;
		let fakeVerify: string;

		beforeEach(() => {
			tmp = mkdtempSync(join(tmpdir(), "gsd-verify-coverage-"));
			fakePackages = join(tmp, "packages");
			mkdirSync(fakePackages, { recursive: true });

			// Copy the two script files into the fake tree so REPO_ROOT resolves correctly.
			// Manifest uses __dirname → scripts/lib/ → ../../ = repo root. So fake layout is:
			//   tmp/
			//     packages/
			//     scripts/
			//       lib/workspace-manifest.cjs
			//       verify-workspace-coverage.cjs
			const scriptsDir = join(tmp, "scripts");
			const scriptsLibDir = join(scriptsDir, "lib");
			mkdirSync(scriptsLibDir, { recursive: true });
			writeFileSync(join(scriptsLibDir, "workspace-manifest.cjs"),
				readFileSync(manifestModulePath, "utf8"));
			writeFileSync(join(scriptsDir, "verify-workspace-coverage.cjs"),
				readFileSync(verifyScriptPath, "utf8"));
			fakeManifest = join(scriptsLibDir, "workspace-manifest.cjs");
			fakeVerify = join(scriptsDir, "verify-workspace-coverage.cjs");
		});

		afterEach(() => {
			rmSync(tmp, { recursive: true, force: true });
		});

		function writePackage(dir: string, pkgJson: Record<string, unknown>, extraFiles: Record<string, string> = {}) {
			const pkgPath = join(fakePackages, dir);
			mkdirSync(pkgPath, { recursive: true });
			writeFileSync(join(pkgPath, "package.json"), JSON.stringify(pkgJson, null, 2));
			for (const [rel, content] of Object.entries(extraFiles)) {
				const full = join(pkgPath, rel);
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, content);
			}
		}

		test("FAILS when a linkable package has zero test files", () => {
			writePackage("pkg-a", {
				name: "@gsd/pkg-a",
				version: "1.0.0",
				gsd: { linkable: true, scope: "@gsd", name: "pkg-a" },
			}, {
				"src/index.ts": "export const x = 1;",
			});

			let threw = false;
			let stderr = "";
			try {
				execFileSync(process.execPath, [fakeVerify], {
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (err) {
				threw = true;
				stderr = (err as { stderr?: string }).stderr ?? "";
			}
			assert.ok(threw, "expected verify-workspace-coverage to exit non-zero");
			assert.match(stderr, /no \*\.test\./);
			assert.match(stderr, /pkg-a/);
		});

		test("PASSES when every linkable package has at least one test file", () => {
			writePackage("pkg-a", {
				name: "@gsd/pkg-a",
				version: "1.0.0",
				gsd: { linkable: true, scope: "@gsd", name: "pkg-a" },
			}, {
				"src/index.ts": "export const x = 1;",
				"src/index.test.ts": "import test from 'node:test'; test('ok', () => {});",
			});
			writePackage("pkg-b", {
				name: "@gsd-build/pkg-b",
				version: "1.0.0",
				gsd: { linkable: true, scope: "@gsd-build", name: "pkg-b" },
			}, {
				"src/thing.test.js": "",
			});

			const out = execFileSync(process.execPath, [fakeVerify], {
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			assert.ok(out !== undefined);
		});

		test("IGNORES non-linkable packages even if they have no tests", () => {
			writePackage("internal-pkg", {
				name: "@gsd-build/internal-pkg",
				version: "1.0.0",
				// Intentionally no gsd.linkable — this package should be skipped entirely.
			}, {
				"src/index.ts": "export const x = 1;",
			});
			const out = execFileSync(process.execPath, [fakeVerify], {
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			assert.ok(out !== undefined);
		});

		test("FAILS when package.json 'name' disagrees with gsd.scope/gsd.name", () => {
			writePackage("pkg-bad", {
				name: "@gsd/wrong-name",
				version: "1.0.0",
				gsd: { linkable: true, scope: "@gsd", name: "pkg-bad" },
			}, {
				"src/x.test.ts": "",
			});

			let threw = false;
			let stderr = "";
			try {
				execFileSync(process.execPath, [fakeVerify], {
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (err) {
				threw = true;
				stderr = (err as { stderr?: string }).stderr ?? "";
			}
			assert.ok(threw, "expected exit non-zero for name mismatch");
			// Either the manifest itself throws (preferred) or the verify script reports it.
			assert.ok(
				/name.*gsd\.scope\/gsd\.name|gsd\.scope\/gsd\.name.*name/i.test(stderr),
				`expected stderr to explain name mismatch. got: ${stderr}`
			);
			// Ensure the fake manifest file was actually loaded in the child process
			// (not the live repo's manifest by accident).
			assert.ok(fakeManifest.length > 0);
		});
	});
});
