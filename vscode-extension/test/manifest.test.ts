import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readText(relativePath: string): string {
	return readFileSync(join(root, relativePath), "utf8");
}

function readPackage(): {
	contributes: {
		commands: Array<{ command: string }>;
		views: Record<string, Array<{ id: string }>>;
		configuration: {
			properties: Record<string, unknown>;
		};
	};
	scripts: Record<string, string>;
} {
	return JSON.parse(readText("package.json"));
}

test("contributed commands are registered by the extension entrypoint", () => {
	const pkg = readPackage();
	const extensionSource = readText("src/extension.ts");
	const contributed = pkg.contributes.commands.map((entry) => entry.command);
	const registered = new Set(
		[...extensionSource.matchAll(/registerCommand\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
	);

	for (const command of contributed) {
		assert.ok(registered.has(command), `${command} must be registered in src/extension.ts`);
	}
});

test("GSDClient launches the configured binary in RPC mode with a controlled cwd", () => {
	const clientSource = readText("src/gsd-client.ts");

	assert.match(clientSource, /spawn\(this\.binaryPath,\s*\[\s*["']--mode["'],\s*["']rpc["']\s*\]/);
	assert.match(clientSource, /cwd:\s*this\.cwd/);
});

test("approval mode contributes settings and executable commands", () => {
	const pkg = readPackage();
	const extensionSource = readText("src/extension.ts");
	const permissionsSource = readText("src/permissions.ts");

	assert.ok(pkg.contributes.configuration.properties["gsd.approvalMode"]);
	assert.match(extensionSource, /registerCommand\(\s*["']gsd\.cycleApprovalMode["']/);
	assert.match(extensionSource, /registerCommand\(\s*["']gsd\.selectApprovalMode["']/);
	assert.match(permissionsSource, /getConfiguration\(["']gsd["']\)\.get<ApprovalMode>\(["']approvalMode["']/);
	assert.match(permissionsSource, /update\(["']approvalMode["']/);
});

test("checkpoint view is contributed and registered", () => {
	const pkg = readPackage();
	const extensionSource = readText("src/extension.ts");

	assert.ok(pkg.contributes.views.gsd.some((view) => view.id === "gsd-checkpoints"));
	assert.match(extensionSource, /registerTreeDataProvider\(GsdCheckpointProvider\.viewId, checkpointProvider\)/);
});

test("agent diff command scopes git output to tracked agent files", () => {
	const gitIntegrationSource = readText("src/git-integration.ts");

	assert.match(gitIntegrationSource, /\["diff", "--", \.\.\.files\]/);
	assert.match(gitIntegrationSource, /\["status", "--short", "--", \.\.\.files\]/);
	assert.doesNotMatch(gitIntegrationSource, /\["diff"\]/);
});
