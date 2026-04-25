import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dirname, "anthropic.ts"), "utf-8");

describe("anthropic bearer auth for custom providers (#3874)", () => {
	it("treats Bearer Authorization headers as authToken-capable providers", () => {
		assert.match(
			source,
			/usesAnthropicBearerAuth\(model\.provider\) \|\| hasBearerAuthorizationHeader\(model\)/,
			"custom providers with Authorization headers should opt into bearer auth",
		);
		assert.match(
			source,
			/apiKey: usesBearerAuth \? null : apiKey/,
			"bearer-auth providers should not send x-api-key",
		);
		assert.match(
			source,
			/authToken: usesBearerAuth \? apiKey : undefined/,
			"bearer-auth providers should send authToken instead",
		);
	});
});
