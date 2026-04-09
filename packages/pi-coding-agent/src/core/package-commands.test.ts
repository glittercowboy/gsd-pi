import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import { runPackageCommand } from "./package-commands.js";

function createCaptureStream() {
	let output = "";
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			output += chunk.toString();
			callback();
		},
	}) as unknown as NodeJS.WriteStream;
	return { stream, getOutput: () => output };
}

function writePackage(root: string, files: Record<string, string>): void {
	for (const [relPath, content] of Object.entries(files)) {
		const abs = join(root, relPath);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content, "utf-8");
	}
}

function createTestDirs(prefix: string, t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(tmpdir(), `pi-lifecycle-${prefix}-`));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	const extensionDir = join(root, `ext-${prefix}`);
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extensionDir, { recursive: true });
	return { root, cwd, agentDir, extensionDir };
}

describe("runPackageCommand lifecycle hooks", () => {
	it("executes registered beforeInstall and afterInstall handlers for local packages", async (t) => {
		const { cwd, agentDir, extensionDir } = createTestDirs("install", t);

		writePackage(extensionDir, {
			"package.json": JSON.stringify({
				name: "ext-registered",
				type: "module",
				pi: { extensions: ["./index.js"] },
			}),
			"index.js": [
				'import { writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				"export default function (pi) {",
				"  pi.registerBeforeInstall((ctx) => {",
				'    writeFileSync(join(ctx.installedPath, "before-install-ran.txt"), "ok", "utf-8");',
				"  });",
				"  pi.registerAfterInstall((ctx) => {",
				'    writeFileSync(join(ctx.installedPath, "after-install-ran.txt"), "ok", "utf-8");',
				"  });",
				"}",
			].join("\n"),
		});

		const stdout = createCaptureStream();
		const stderr = createCaptureStream();
		const result = await runPackageCommand({
			appName: "pi",
			args: ["install", extensionDir],
			cwd,
			agentDir,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});

		assert.equal(result.handled, true);
		assert.equal(result.exitCode, 0);
		assert.equal(readFileSync(join(extensionDir, "before-install-ran.txt"), "utf-8"), "ok");
		assert.equal(readFileSync(join(extensionDir, "after-install-ran.txt"), "utf-8"), "ok");
		assert.ok(stdout.getOutput().includes(`Installed ${extensionDir}`));
	});

	it("runs legacy named lifecycle hooks when no registered hooks exist", async (t) => {
		const { cwd, agentDir, extensionDir } = createTestDirs("legacy", t);

		writePackage(extensionDir, {
			"package.json": JSON.stringify({
				name: "ext-legacy",
				type: "module",
				pi: { extensions: ["./index.js"] },
			}),
			"index.js": [
				'import { writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				"export default function () {}",
				"export async function beforeInstall(ctx) {",
				'  writeFileSync(join(ctx.installedPath, "legacy-before-install.txt"), "ok", "utf-8");',
				"}",
				"export async function afterInstall(ctx) {",
				'  writeFileSync(join(ctx.installedPath, "legacy-after-install.txt"), "ok", "utf-8");',
				"}",
				"export async function beforeRemove(ctx) {",
				'  writeFileSync(join(ctx.installedPath, "legacy-before-remove.txt"), "ok", "utf-8");',
				"}",
				"export async function afterRemove(ctx) {",
				'  writeFileSync(join(ctx.installedPath, "legacy-after-remove.txt"), "ok", "utf-8");',
				"}",
			].join("\n"),
		});

		const stdout = createCaptureStream();
		const stderr = createCaptureStream();
		const installResult = await runPackageCommand({
			appName: "pi",
			args: ["install", extensionDir],
			cwd,
			agentDir,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});

		assert.equal(installResult.handled, true);
		assert.equal(installResult.exitCode, 0);
		assert.equal(readFileSync(join(extensionDir, "legacy-before-install.txt"), "utf-8"), "ok");
		assert.equal(readFileSync(join(extensionDir, "legacy-after-install.txt"), "utf-8"), "ok");

		const removeResult = await runPackageCommand({
			appName: "pi",
			args: ["remove", extensionDir],
			cwd,
			agentDir,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});

		assert.equal(removeResult.handled, true);
		assert.equal(removeResult.exitCode, 0);
		assert.equal(readFileSync(join(extensionDir, "legacy-before-remove.txt"), "utf-8"), "ok");
		assert.equal(readFileSync(join(extensionDir, "legacy-after-remove.txt"), "utf-8"), "ok");
	});

	it("skips lifecycle phases with no hooks declared", async (t) => {
		const { cwd, agentDir, extensionDir } = createTestDirs("skip", t);

		writePackage(extensionDir, {
			"package.json": JSON.stringify({
				name: "ext-empty",
				type: "module",
				pi: { extensions: ["./index.js"] },
			}),
			"index.js": "export default function () {}",
		});

		const stdout = createCaptureStream();
		const stderr = createCaptureStream();
		const installResult = await runPackageCommand({
			appName: "pi",
			args: ["install", extensionDir],
			cwd,
			agentDir,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});
		assert.equal(installResult.handled, true);
		assert.equal(installResult.exitCode, 0);

		const removeResult = await runPackageCommand({
			appName: "pi",
			args: ["remove", extensionDir],
			cwd,
			agentDir,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});
		assert.equal(removeResult.handled, true);
		assert.equal(removeResult.exitCode, 0);
		assert.equal(stderr.getOutput().includes("Hook failed"), false);
	});

	it("fails install when manifest runtime dependency is missing", async (t) => {
		const { cwd, agentDir, extensionDir } = createTestDirs("deps", t);

		writePackage(extensionDir, {
			"package.json": JSON.stringify({
				name: "ext-runtime-deps",
				type: "module",
				pi: { extensions: ["./index.js"] },
			}),
			"index.js": "export default function () {}",
			"extension-manifest.json": JSON.stringify({
				id: "ext-runtime-deps",
				name: "Runtime Dep Test",
				version: "1.0.0",
				dependencies: { runtime: ["__definitely_missing_command_for_test__"] },
			}),
		});

		const stdout = createCaptureStream();
		const stderr = createCaptureStream();
		const result = await runPackageCommand({
			appName: "pi",
			args: ["install", extensionDir],
			cwd,
			agentDir,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});

		assert.equal(result.handled, true);
		assert.equal(result.exitCode, 1);
		assert.ok(stderr.getOutput().includes("Missing runtime dependencies"));
	});

	it("afterRemove hook receives installedPath even when directory is deleted", async (t) => {
		const { cwd, agentDir, extensionDir } = createTestDirs("after-remove", t);

		writePackage(extensionDir, {
			"package.json": JSON.stringify({
				name: "ext-after-remove",
				type: "module",
				pi: { extensions: ["./index.js"] },
			}),
			"index.js": [
				'import { writeFileSync, existsSync } from "node:fs";',
				'import { join } from "node:path";',
				"export default function () {}",
				"export async function afterRemove(ctx) {",
				'  const marker = join(ctx.cwd, "after-remove-marker.json");',
				"  writeFileSync(marker, JSON.stringify({",
				"    receivedPath: ctx.installedPath,",
				"    pathExisted: existsSync(ctx.installedPath),",
				'  }), "utf-8");',
				"}",
			].join("\n"),
		});

		const stdout = createCaptureStream();
		const stderr = createCaptureStream();

		await runPackageCommand({
			appName: "pi",
			args: ["install", extensionDir],
			cwd,
			agentDir,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});

		await runPackageCommand({
			appName: "pi",
			args: ["remove", extensionDir],
			cwd,
			agentDir,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});

		const markerPath = join(cwd, "after-remove-marker.json");
		assert.ok(existsSync(markerPath), "afterRemove hook must have executed and written marker");
		const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
		assert.equal(typeof marker.receivedPath, "string", "hook must receive installedPath as string");
	});
});
