import test from "node:test";
import assert from "node:assert/strict";

const { getProviderSetupAction } = await import(
	"../../packages/pi-coding-agent/src/modes/interactive/provider-auth-setup.ts"
);

test("routes OAuth providers to the login dialog", () => {
	const action = getProviderSetupAction({
		provider: "github-copilot",
		authMode: "oauth",
		hasAuth: false,
	});

	assert.deepEqual(action, { kind: "oauth-login" });
});

test("keeps API-key providers out of the OAuth login flow", () => {
	for (const provider of ["alibaba-coding-plan", "zai", "xai"]) {
		const action = getProviderSetupAction({
			provider,
			authMode: "apiKey",
			hasAuth: false,
		});

		assert.equal(action.kind, "status");
		assert.match(action.message, /API-key auth, not OAuth/);
		assert.match(action.message, new RegExp(provider));
	}
});

test("tells already-configured API-key providers to use model selection", () => {
	const action = getProviderSetupAction({
		provider: "xai",
		authMode: "apiKey",
		hasAuth: true,
	});

	assert.deepEqual(action, {
		kind: "status",
		message: "xai already has credentials configured. Use /model to select it.",
	});
});
