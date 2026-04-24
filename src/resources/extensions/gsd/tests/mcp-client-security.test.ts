import test from "node:test";
import assert from "node:assert/strict";

import {
  _buildMcpChildEnvForTest,
  _buildMcpTrustConfirmOptionsForTest,
} from "../../mcp-client/index.ts";

// Note: four source-grep tests that scanned `mcp-client/index.ts` for
// Map<> shapes, catch-block structure, and closeAll body were removed
// under #4827. They encoded implementation shape rather than behaviour —
// any refactor (extracted helper, different Map key type, rearranged
// cleanup order) broke the greps without a real regression. Runtime
// coverage of connectServer/closeAll with a mocked failing transport
// is tracked as a follow-up.

test("MCP stdio child env only includes safe inherited keys plus explicit config env", () => {
  const previousSecret = process.env.SECRET_MCP_TEST_TOKEN;
  const previousPath = process.env.PATH;
  try {
    process.env.SECRET_MCP_TEST_TOKEN = "should-not-leak";
    process.env.PATH = "/usr/bin";

    const env = _buildMcpChildEnvForTest({
      EXPLICIT_TOKEN: "${SECRET_MCP_TEST_TOKEN}",
      PLAIN_VALUE: "ok",
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.SECRET_MCP_TEST_TOKEN, undefined);
    assert.equal(env.EXPLICIT_TOKEN, "should-not-leak");
    assert.equal(env.PLAIN_VALUE, "ok");
  } finally {
    if (previousSecret === undefined) delete process.env.SECRET_MCP_TEST_TOKEN;
    else process.env.SECRET_MCP_TEST_TOKEN = previousSecret;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("MCP stdio trust confirmation is abort-aware", () => {
  const controller = new AbortController();
  const options = _buildMcpTrustConfirmOptionsForTest(controller.signal);

  assert.equal(options.timeout, 120_000);
  assert.equal(options.signal, controller.signal);
});
