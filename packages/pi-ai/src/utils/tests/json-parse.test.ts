import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamingJson } from "../json-parse.js";

describe("parseStreamingJson — XML parameter recovery (#3751)", () => {
	test("promotes XML parameters trapped inside valid JSON string values", () => {
		const malformed =
			'{"narrative":"text.</narrative>\\n<parameter name=\\"verification\\">all tests pass</parameter>\\n<parameter name=\\"verificationEvidence\\">[\\"npm test\\"]</parameter>","oneLiner":"done"}';

		const parsed = parseStreamingJson<Record<string, unknown>>(malformed);

		assert.equal(parsed.narrative, "text.");
		assert.equal(parsed.verification, "all tests pass");
		assert.deepEqual(parsed.verificationEvidence, ["npm test"]);
		assert.equal(parsed.oneLiner, "done");
	});
});
