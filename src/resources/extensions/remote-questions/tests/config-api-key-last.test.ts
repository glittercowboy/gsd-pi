/**
 * Regression test for the remote-questions token rotation bug:
 * when multiple `api_key` credentials are present in auth.json for the same
 * provider, hydrateRemoteTokensFromAuth must use the LAST one (newest token
 * after rotation), not the first. The earlier implementation used `find`,
 * which returned the stale token and silently disabled remote questions
 * after a rotation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { pickLastApiKeyCredential } from "../config.ts";

test("pickLastApiKeyCredential returns the last api_key credential with a key", () => {
  const creds = [
    { type: "api_key", key: "old-token" },
    { type: "oauth", key: "irrelevant" },
    { type: "api_key", key: "new-token" },
  ];
  assert.equal(pickLastApiKeyCredential(creds)?.key, "new-token");
});

test("pickLastApiKeyCredential skips api_key entries without a key", () => {
  const creds = [
    { type: "api_key", key: "valid-token" },
    { type: "api_key" }, // rotated out, no key set
    { type: "api_key", key: "" }, // empty
  ];
  assert.equal(pickLastApiKeyCredential(creds)?.key, "valid-token");
});

test("pickLastApiKeyCredential returns undefined when no api_key has a key", () => {
  const creds = [
    { type: "oauth", key: "x" },
    { type: "api_key" },
  ];
  assert.equal(pickLastApiKeyCredential(creds), undefined);
});

test("pickLastApiKeyCredential returns undefined for empty input", () => {
  assert.equal(pickLastApiKeyCredential([]), undefined);
});

test("pickLastApiKeyCredential differs from Array.prototype.find on rotation case", () => {
  // This guards against a regression where someone "simplifies" the helper
  // back to `creds.find(c => c.type === "api_key" && !!c.key)`, which would
  // return the FIRST (stale) token after a key rotation appends a new entry.
  const creds = [
    { type: "api_key", key: "stale" },
    { type: "api_key", key: "fresh" },
  ];
  const findResult = creds.find((c) => c.type === "api_key" && !!c.key);
  assert.equal(findResult?.key, "stale", "sanity: find returns the first match");
  assert.equal(pickLastApiKeyCredential(creds)?.key, "fresh", "helper must return the last match");
});
