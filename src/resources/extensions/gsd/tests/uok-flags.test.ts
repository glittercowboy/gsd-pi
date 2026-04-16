import test from "node:test";
import assert from "node:assert/strict";

import { resolveUokFlags } from "../uok/flags.ts";

test("uok flags default to enabled when preference is unset", () => {
  const flags = resolveUokFlags(undefined);
  assert.equal(flags.enabled, true);
  assert.equal(flags.legacyFallback, false);
  assert.equal(flags.gates, true);
  assert.equal(flags.modelPolicy, true);
  assert.equal(flags.executionGraph, true);
  assert.equal(flags.gitops, true);
  assert.equal(flags.auditUnified, true);
  assert.equal(flags.planV2, true);
  assert.equal(flags.gitopsTurnAction, "status-only");
  assert.equal(flags.gitopsTurnPush, false);
});

test("uok nested flags support explicit opt-out", () => {
  const flags = resolveUokFlags({
    uok: {
      enabled: true,
      gates: { enabled: false },
      model_policy: { enabled: false },
      execution_graph: { enabled: false },
      gitops: { enabled: false, turn_action: "commit", turn_push: true },
      audit_unified: { enabled: false },
      plan_v2: { enabled: false },
    },
  });
  assert.equal(flags.enabled, true);
  assert.equal(flags.gates, false);
  assert.equal(flags.modelPolicy, false);
  assert.equal(flags.executionGraph, false);
  assert.equal(flags.gitops, false);
  assert.equal(flags.auditUnified, false);
  assert.equal(flags.planV2, false);
  assert.equal(flags.gitopsTurnAction, "commit");
  assert.equal(flags.gitopsTurnPush, true);
});

test("uok legacy fallback preference forces legacy path", () => {
  const flags = resolveUokFlags({
    uok: {
      enabled: true,
      legacy_fallback: { enabled: true },
    },
  });
  assert.equal(flags.enabled, false);
  assert.equal(flags.legacyFallback, true);
});

test("uok legacy fallback env var forces legacy path", () => {
  const previous = process.env.GSD_UOK_FORCE_LEGACY;
  process.env.GSD_UOK_FORCE_LEGACY = "1";
  try {
    const flags = resolveUokFlags({
      uok: {
        enabled: true,
      },
    });
    assert.equal(flags.enabled, false);
    assert.equal(flags.legacyFallback, true);
  } finally {
    if (previous === undefined) delete process.env.GSD_UOK_FORCE_LEGACY;
    else process.env.GSD_UOK_FORCE_LEGACY = previous;
  }
});
