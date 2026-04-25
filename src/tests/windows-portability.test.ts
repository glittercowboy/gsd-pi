import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveLocalBinaryPath } from "../../packages/pi-coding-agent/src/core/lsp/config.ts";
import { encodeCwd } from "../resources/extensions/subagent/isolation.ts";

function makeTempDir(prefix: string): string {
	const dir = path.join(
		os.tmpdir(),
		`gsd-windows-portability-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("resolveLocalBinaryPath finds Windows npm shims", () => {
	const dir = makeTempDir("lsp-shim");
	try {
		writeFileSync(path.join(dir, "package.json"), "{}");
		mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
		const shimPath = path.join(dir, "node_modules", ".bin", "tsc.cmd");
		writeFileSync(shimPath, "@echo off\r\n");

		const resolved = resolveLocalBinaryPath("tsc", dir, true);
		assert.equal(resolved, shimPath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveLocalBinaryPath finds Windows venv Scripts executables", () => {
	const dir = makeTempDir("lsp-scripts");
	try {
		writeFileSync(path.join(dir, "pyproject.toml"), "");
		mkdirSync(path.join(dir, "venv", "Scripts"), { recursive: true });
		const exePath = path.join(dir, "venv", "Scripts", "python.exe");
		writeFileSync(exePath, "");

		const resolved = resolveLocalBinaryPath("python", dir, true);
		assert.equal(resolved, exePath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("encodeCwd produces a filesystem-safe token for Windows paths", () => {
	const encoded = encodeCwd("C:\\Users\\Alice\\repo");
	assert.match(encoded, /^[A-Za-z0-9_-]+$/);
	assert.ok(!encoded.includes(":"));
	assert.ok(!encoded.includes("\\"));
	assert.ok(!encoded.includes("/"));
});

test("Windows launch points use shell-safe shims", () => {
	const gsdClient = readFileSync(
		path.join(process.cwd(), "vscode-extension", "src", "gsd-client.ts"),
		"utf8",
	);
	const updateService = readFileSync(
		path.join(process.cwd(), "src", "web", "update-service.ts"),
		"utf8",
	);
	const preExecution = readFileSync(
		path.join(process.cwd(), "src", "resources", "extensions", "gsd", "pre-execution-checks.ts"),
		"utf8",
	);
	const validatePack = readFileSync(
		path.join(process.cwd(), "scripts", "validate-pack.js"),
		"utf8",
	);

	assert.match(gsdClient, /shell:\s*process\.platform === "win32"/);
	assert.match(updateService, /npm\.cmd/);
	assert.match(preExecution, /npm\.cmd/);
	assert.match(validatePack, /shell:\s*process\.platform === 'win32'/);
});
