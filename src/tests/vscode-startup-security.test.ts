/**
 * Trust-boundary regression for the VS Code extension startup. A workspace
 * is potentially attacker-controlled: a malicious `.vscode/settings.json`
 * could redirect `gsd.binaryPath` to `/tmp/pwn` and flip `gsd.autoStart`
 * to `true`. The extension only trusts user-scope (`globalValue`) and the
 * default declared in package.json (`defaultValue`); workspace and
 * workspace-folder values are silently ignored.
 *
 * Previously this test grep'd `extension.ts` for the literal regex
 * `globalValue ?? inspected?.defaultValue` — any rewording of the trust
 * helper would fail the test even when the security guarantee was intact,
 * and any drift that swapped `globalValue` for `workspaceValue` could
 * still pass if the literal text remained somewhere in the file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { pickTrustedConfigurationValue } from "../../vscode-extension/src/trusted-config.ts";

test("workspace-scope value is rejected even when supplied", () => {
	const result = pickTrustedConfigurationValue<string>(
		{
			defaultValue: "gsd",
			globalValue: undefined,
			workspaceValue: "/tmp/attacker-binary",
			workspaceFolderValue: "/tmp/attacker-binary-folder",
		},
		"fallback",
	);
	assert.equal(result, "gsd", "workspace-scope binaryPath must not override defaultValue");
});

test("workspace-folder-scope value is rejected even when supplied", () => {
	const result = pickTrustedConfigurationValue<boolean>(
		{
			defaultValue: false,
			globalValue: undefined,
			workspaceValue: undefined,
			workspaceFolderValue: true,
		},
		false,
	);
	assert.equal(result, false, "workspace-folder autoStart=true must not enable auto-start");
});

test("globalValue (user settings) is honored over defaultValue", () => {
	const result = pickTrustedConfigurationValue<string>(
		{ defaultValue: "gsd", globalValue: "/Users/me/bin/gsd-dev" },
		"fallback",
	);
	assert.equal(result, "/Users/me/bin/gsd-dev");
});

test("defaultValue (extension manifest) wins when no global override", () => {
	const result = pickTrustedConfigurationValue<string>(
		{ defaultValue: "gsd", workspaceValue: "/tmp/pwn" },
		"fallback",
	);
	assert.equal(result, "gsd");
});

test("fallback applies only when both globalValue and defaultValue are absent", () => {
	assert.equal(pickTrustedConfigurationValue<string>(undefined, "fallback"), "fallback");
	assert.equal(
		pickTrustedConfigurationValue<string>({ workspaceValue: "/tmp/pwn" }, "fallback"),
		"fallback",
		"untrusted workspace value cannot satisfy the lookup",
	);
});

test("globalValue=false is honored (not skipped as falsy)", () => {
	// Regression guard: a careless `||` instead of `??` would silently
	// promote workspaceValue when the user explicitly disabled autoStart.
	const result = pickTrustedConfigurationValue<boolean>(
		{ globalValue: false, workspaceValue: true, defaultValue: false },
		false,
	);
	assert.equal(result, false, "user-set autoStart=false must beat workspaceValue=true");
});
