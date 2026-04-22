import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolveBuiltEntryPath(): string {
	const runtimePackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const distTestMarker = `${sep}dist-test${sep}packages${sep}`;
	const workspacePackageRoot = runtimePackageRoot.includes(distTestMarker)
		? runtimePackageRoot.replace(distTestMarker, `${sep}packages${sep}`)
		: runtimePackageRoot;
	return join(workspacePackageRoot, "dist", "index.js");
}

test("@gsd/agent-modes resolves through its built dist entrypoint", async () => {
	const entryPath = resolveBuiltEntryPath();
	assert.equal(existsSync(entryPath), true, `missing built entrypoint: ${entryPath}`);
	const mod = await import(pathToFileURL(entryPath).href);
	assert.equal(mod.AGENT_MODES_SHELL_VERSION, "0.0.0-shell");
});
