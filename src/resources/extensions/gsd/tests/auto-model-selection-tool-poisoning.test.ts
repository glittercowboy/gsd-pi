/**
 * Regression coverage for the model-policy dispatch bugs (#4959, #4681, #4850).
 *
 * The five tests here pin the four fix layers documented in the RCA on #4959:
 *
 *   1. Vacuous-truth guard: with an empty unit-required tool subset and an
 *      otherwise-permitted model, dispatch must succeed.  Without this test,
 *      an over-aggressive Change 1 (e.g. always denying) would still pass any
 *      "no longer throws" assertion trivially.
 *   2. Cross-unit poisoning: per-unit narrowing at the bottom of
 *      `selectAndApplyModel` must NOT bleed into the next unit's policy
 *      evaluation.  The baseline-restore path (Change 2) must restore the
 *      pre-dispatch active-tool set before policy runs.
 *   3. Genuinely-impossible negative: when the workflow REQUIRES a tool no
 *      candidate model can carry, dispatch must throw
 *      `ModelPolicyDispatchBlockedError` — proving Change 1 didn't accidentally
 *      remove gating, and Change 3 wired the typed error.
 *   4. Restore happened: assert call ordering on a recording fake — the
 *      baseline `setActiveTools` call must precede the next `selectAndApplyModel`
 *      reading the active set.
 *   5. Error message carries reason: the throw must include the per-model
 *      `tool policy denied (...)` reason fragment from `applyModelPolicyFilter`,
 *      so users can act on the failure without digging through audit events.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  selectAndApplyModel,
  ModelPolicyDispatchBlockedError,
  clearToolBaseline,
} from "../auto-model-selection.js";
import {
  registerToolCompatibility,
  resetToolCompatibilityRegistry,
} from "@gsd/pi-coding-agent";

function makeTempProject(): { dir: string; cleanup: () => void; restoreEnv: () => void } {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const dir = mkdtempSync(join(tmpdir(), "gsd-policy-poison-"));
  const home = mkdtempSync(join(tmpdir(), "gsd-policy-home-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  // Empty PREFERENCES so default uok.model_policy.enabled = true applies.
  writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), "---\n---\n", "utf-8");
  process.env.GSD_HOME = home;
  process.chdir(dir);
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
    restoreEnv: () => {
      process.chdir(originalCwd);
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
    },
  };
}

interface RecordingPi {
  setModel: (m: { provider: string; id: string }) => Promise<boolean>;
  emitBeforeModelSelect: () => Promise<undefined>;
  getActiveTools: () => string[];
  emitAdjustToolSet: () => Promise<undefined>;
  setActiveTools: (names: string[]) => void;
  setThinkingLevel: () => void;
  __calls: Array<{ kind: string; payload: unknown }>;
  __activeTools: string[];
}

function makeRecordingPi(initialActiveTools: string[]): RecordingPi {
  const calls: Array<{ kind: string; payload: unknown }> = [];
  let active = [...initialActiveTools];
  return {
    __calls: calls,
    get __activeTools() { return active; },
    setModel: async (m) => {
      calls.push({ kind: "setModel", payload: `${m.provider}/${m.id}` });
      return true;
    },
    emitBeforeModelSelect: async () => {
      calls.push({ kind: "emitBeforeModelSelect", payload: null });
      return undefined;
    },
    getActiveTools: () => {
      calls.push({ kind: "getActiveTools", payload: [...active] });
      return [...active];
    },
    emitAdjustToolSet: async () => {
      calls.push({ kind: "emitAdjustToolSet", payload: null });
      return undefined;
    },
    setActiveTools: (names) => {
      active = [...names];
      calls.push({ kind: "setActiveTools", payload: [...names] });
    },
    setThinkingLevel: () => {},
  } as RecordingPi;
}

function makeCtx(availableModels: Array<{ id: string; provider: string; api: string }>) {
  return {
    modelRegistry: {
      getAvailable: () => availableModels,
      getProviderAuthMode: () => "apiKey",
    },
    sessionManager: { getSessionId: () => "test-session" },
    ui: { notify: () => {} },
    model: { provider: availableModels[0]?.provider, id: availableModels[0]?.id, api: availableModels[0]?.api },
  } as any;
}

// ─── 1. Vacuous-truth guard ──────────────────────────────────────────────────
//
// Two scenarios pin the empty-requiredTools branch and a permitted-tool branch.
// Without the empty-list scenario, a regression that mishandles `requiredTools = []`
// (e.g. by treating an empty array as "deny all" or by null-derefing the helper
// return) would still pass.

test("vacuous-truth (a): unit type with empty workflow-required tools → dispatch succeeds", async () => {
  const env = makeTempProject();
  try {
    // `refine-slice` is not in the getRequiredWorkflowToolsForAutoUnit switch
    // → returns []. Exercises the empty-requiredTools branch in
    // applyModelPolicyFilter (CodeRabbit Minor: existing test used
    // gate-evaluate which has non-empty required tools and never hit this path).
    //
    // PREFERENCES with tier_models is required so resolvePreferredModelConfig
    // returns a non-undefined modelConfig — only then does selectAndApplyModel
    // run the policy filter we want to exercise.
    writeFileSync(
      join(env.dir, ".gsd", "PREFERENCES.md"),
      ["---", "dynamic_routing:", "  enabled: true", "  tier_models:", "    heavy: anthropic/claude-sonnet-4-6", "---"].join("\n"),
      "utf-8",
    );
    const availableModels = [
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
    ];
    const pi = makeRecordingPi([]);
    clearToolBaseline(pi as unknown as object);

    const result = await selectAndApplyModel(
      makeCtx(availableModels),
      pi as any,
      "refine-slice",
      "x1",
      env.dir,
      undefined,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      undefined,
      true,
    );

    assert.equal(result.appliedModel?.id, "claude-sonnet-4-6", "empty requiredTools must not deny dispatch");
    const setModelCalls = pi.__calls.filter(c => c.kind === "setModel");
    assert.equal(setModelCalls.length, 1, "setModel should have been called exactly once");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});

test("vacuous-truth (b): non-empty workflow tool requirement that the model carries → dispatch succeeds", async () => {
  const env = makeTempProject();
  try {
    // gate-evaluate has tool requirement ["gsd_save_gate_result"]; if the
    // model's API can carry it, policy must still allow dispatch. Counter-test
    // to (a): proves the path with a non-empty requirement isn't denying
    // legitimate dispatches.
    const availableModels = [
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
    ];
    const pi = makeRecordingPi(["gsd_save_gate_result"]);
    clearToolBaseline(pi as unknown as object);

    const result = await selectAndApplyModel(
      makeCtx(availableModels),
      pi as any,
      "gate-evaluate",
      "g1",
      env.dir,
      undefined,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      undefined,
      true,
    );

    assert.equal(result.appliedModel?.id, "claude-sonnet-4-6", "compat-required dispatch must succeed");
    const setModelCalls = pi.__calls.filter(c => c.kind === "setModel");
    assert.equal(setModelCalls.length, 1, "setModel should have been called exactly once");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});

// ─── 2. Cross-unit poisoning ─────────────────────────────────────────────────
test("cross-unit poisoning: prior unit narrowing must not deny next unit's eligible model", async () => {
  const env = makeTempProject();
  try {
    // Unit-N runs against an `openai-completions` provider that strips a tool
    // (e.g. "thinking_partner") via adjustToolSet's hard filter.  Without the
    // baseline-restore (Change 2), pi.getActiveTools() afterward is missing
    // that tool, but if we used it as the policy required-set we'd erroneously
    // deny the next unit.  With Change 1+2, policy uses the workflow-required
    // subset (NOT the live snapshot), and baseline restoration re-seeds the
    // active set before the next unit.
    const availableModels = [
      { id: "openai-narrow", provider: "openai", api: "openai-completions" },
      { id: "claude-wide", provider: "anthropic", api: "anthropic-messages" },
    ];
    // The baseline contains a synthetic "thinking_partner" that openai-completions
    // does not support.
    const pi = makeRecordingPi(["gsd_save_gate_result", "thinking_partner"]);
    clearToolBaseline(pi as unknown as object);

    // Unit-N: dispatch on openai/openai-narrow.  Soft adjustToolSet will narrow
    // the active set, simulating production poisoning.
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi as any,
      "gate-evaluate",
      "n",
      env.dir,
      undefined,
      false,
      { provider: "openai", id: "openai-narrow" },
      undefined,
      true,
    );

    const setModelCallsAfterUnitN = pi.__calls.filter(c => c.kind === "setModel").length;
    assert.ok(setModelCallsAfterUnitN >= 1, "unit-N should have dispatched");

    // Unit-N+1: now dispatch with claude-wide.  If active-tool snapshot were
    // still the policy required-set, the previous narrowing wouldn't matter
    // (anthropic-messages can carry both tools), so we instead simulate the
    // 4959 path: a second unit whose workflow requires "gsd_save_gate_result"
    // (small) — must succeed reaching pi.setModel for claude-wide.
    const beforeCount = pi.__calls.filter(c => c.kind === "setModel").length;
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi as any,
      "gate-evaluate",
      "n+1",
      env.dir,
      undefined,
      false,
      { provider: "anthropic", id: "claude-wide" },
      undefined,
      true,
    );
    const afterCount = pi.__calls.filter(c => c.kind === "setModel").length;
    assert.ok(afterCount > beforeCount, "unit-N+1 should reach pi.setModel — cross-unit narrowing must not block dispatch");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});

// ─── 3a. Genuinely-impossible: tool-compatibility denial path ────────────────
//
// Exercises the real `getRequiredWorkflowToolsForAutoUnit` →
// `filterToolsForProvider` path that #4959 was about (CodeRabbit Minor:
// existing 3b test used cross-provider denial which never hit this path).
// Registers `gsd_plan_slice` as `producesImages: true`, then offers only an
// `ollama-chat` candidate (which has `imageToolResults: false`) — the
// workflow-required tool is incompatible with the candidate's API, so the
// policy filter denies the model with a `tool policy denied (...)` reason.
test("genuinely-impossible (a): workflow tool incompatible with candidate API → typed error names tool + api", async () => {
  const env = makeTempProject();
  try {
    // Register the workflow tool as image-producing for the duration of this
    // test. afterEach() resets the registry below.
    registerToolCompatibility("gsd_plan_slice", { producesImages: true });

    // PREFERENCES needs tier_models so resolvePreferredModelConfig returns a
    // non-undefined modelConfig — without that, selectAndApplyModel skips the
    // entire policy block and we never reach the tool-compat denial path.
    writeFileSync(
      join(env.dir, ".gsd", "PREFERENCES.md"),
      ["---", "dynamic_routing:", "  enabled: true", "  tier_models:", "    heavy: ollama/ollama-llama-3", "---"].join("\n"),
      "utf-8",
    );

    const availableModels = [
      { id: "ollama-llama-3", provider: "ollama", api: "ollama-chat" },
    ];
    const pi = makeRecordingPi(["gsd_plan_slice"]);
    clearToolBaseline(pi as unknown as object);

    const ctx = makeCtx(availableModels);
    // Same provider as candidate so the cross-provider gate doesn't fire —
    // we want this denial to come from tool-compatibility, not provider mismatch.
    ctx.model = { provider: "ollama", id: "ollama-llama-3", api: "ollama-chat" };

    let thrown: unknown;
    try {
      await selectAndApplyModel(
        ctx,
        pi as any,
        "plan-slice",
        "s1",
        env.dir,
        undefined,
        false,
        { provider: "ollama", id: "ollama-llama-3" },
        undefined,
        true,
      );
    } catch (e) {
      thrown = e;
    }

    assert.ok(thrown instanceof ModelPolicyDispatchBlockedError, "should throw ModelPolicyDispatchBlockedError");
    const err = thrown as ModelPolicyDispatchBlockedError;
    assert.equal(err.unitType, "plan-slice");
    assert.match(err.message, /tool policy denied/, "throw must surface the tool-compatibility deny reason");
    assert.match(err.message, /gsd_plan_slice/, "throw must name the incompatible tool");
    assert.match(err.message, /ollama-chat/, "throw must name the api for which the tool was filtered");
  } finally {
    resetToolCompatibilityRegistry();
    env.restoreEnv();
    env.cleanup();
  }
});

// ─── 3b. Genuinely-impossible: cross-provider denial path ────────────────────
test("genuinely-impossible (b): cross-provider routing disabled + provider mismatch → typed error", async () => {
  const env = makeTempProject();
  try {
    // Use plan-slice (workflow-required: ["gsd_plan_slice"]) but pretend no
    // candidate model can carry it.  The simplest way: provide a model whose
    // api is a fictitious "no-tools" string — `filterToolsForProvider` returns
    // every tool as filtered for an unknown api with toolCalling=false, OR we
    // can pick a real api that also denies the tool.  We use an api that
    // exists but has known incompatibility — no such case is portable, so we
    // fall back to a model whose api is recognized to deny `gsd_plan_slice`.
    //
    // Pragmatic approach: monkey the policy via `allowCrossProvider=false` +
    // a single candidate model on a *different* provider than current, which
    // makes EVERY candidate denied for cross-provider-routing reasons.  This
    // exercises the same throw path with a deterministic deny reason.
    const availableModels = [
      { id: "other-model", provider: "other-provider", api: "anthropic-messages" },
    ];
    const pi = makeRecordingPi([]);
    clearToolBaseline(pi as unknown as object);

    const ctx = makeCtx(availableModels);
    // currentProvider mismatches → cross-provider denial when disabled.
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" };

    // Set dynamic_routing.cross_provider=false via PREFERENCES so the policy
    // disables cross-provider routing.
    writeFileSync(
      join(env.dir, ".gsd", "PREFERENCES.md"),
      ["---", "dynamic_routing:", "  enabled: true", "  cross_provider: false", "  tier_models:", "    heavy: other-provider/other-model", "---"].join("\n"),
      "utf-8",
    );

    let thrown: unknown;
    try {
      await selectAndApplyModel(
        ctx,
        pi as any,
        "plan-slice",
        "s1",
        env.dir,
        undefined,
        false,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        undefined,
        true,
      );
    } catch (e) {
      thrown = e;
    }

    assert.ok(thrown instanceof ModelPolicyDispatchBlockedError, "should throw ModelPolicyDispatchBlockedError");
    const err = thrown as ModelPolicyDispatchBlockedError;
    assert.equal(err.unitType, "plan-slice");
    assert.equal(err.unitId, "s1");
    assert.ok(err.reasons.length > 0, "deny reasons should be captured");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});

// ─── 4. Restore happened ─────────────────────────────────────────────────────
test("restore baseline: setActiveTools(BASELINE) called between units before next dispatch", async () => {
  const env = makeTempProject();
  try {
    const availableModels = [
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
    ];
    const baselineTools = ["gsd_save_gate_result", "tool_a", "tool_b"];
    const pi = makeRecordingPi(baselineTools);
    clearToolBaseline(pi as unknown as object);

    // First call captures the baseline.
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi as any,
      "gate-evaluate",
      "u1",
      env.dir,
      undefined,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      undefined,
      true,
    );

    // Simulate a downstream caller narrowing the tool set (post-unit poisoning).
    pi.setActiveTools(["gsd_save_gate_result"]);
    const callsBeforeU2 = pi.__calls.length;

    // Second call should restore the baseline before reading anything.
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi as any,
      "gate-evaluate",
      "u2",
      env.dir,
      undefined,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      undefined,
      true,
    );

    const u2Calls = pi.__calls.slice(callsBeforeU2);
    const restoreCall = u2Calls.find(
      c => c.kind === "setActiveTools"
        && Array.isArray(c.payload)
        && (c.payload as string[]).length === baselineTools.length
        && baselineTools.every(t => (c.payload as string[]).includes(t)),
    );
    assert.ok(restoreCall, "setActiveTools(BASELINE) must be called during u2's selectAndApplyModel before dispatch");

    const restoreIdx = u2Calls.indexOf(restoreCall!);
    const setModelIdx = u2Calls.findIndex(c => c.kind === "setModel");
    assert.ok(setModelIdx > restoreIdx, "baseline restore must precede setModel dispatch");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});

// ─── 5. Error message carries reason ─────────────────────────────────────────
test("error carries deny reason fragment from applyModelPolicyFilter", async () => {
  const env = makeTempProject();
  try {
    writeFileSync(
      join(env.dir, ".gsd", "PREFERENCES.md"),
      ["---", "dynamic_routing:", "  enabled: true", "  cross_provider: false", "  tier_models:", "    heavy: other-provider/other-model", "---"].join("\n"),
      "utf-8",
    );

    const availableModels = [
      { id: "other-model", provider: "other-provider", api: "anthropic-messages" },
    ];
    const pi = makeRecordingPi([]);
    clearToolBaseline(pi as unknown as object);

    const ctx = makeCtx(availableModels);
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" };

    let thrown: Error | undefined;
    try {
      await selectAndApplyModel(
        ctx,
        pi as any,
        "plan-slice",
        "s1",
        env.dir,
        undefined,
        false,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        undefined,
        true,
      );
    } catch (e) {
      thrown = e as Error;
    }

    assert.ok(thrown, "should throw");
    // The cross-provider denial path produces:
    //   "cross-provider routing disabled (other-provider != anthropic)"
    assert.match(
      thrown!.message,
      /cross-provider routing disabled/,
      "thrown error message should include the per-model deny reason",
    );
    assert.match(thrown!.message, /other-provider\/other-model/, "should name the rejected model");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});

// ─── 6. Lifecycle: clearToolBaseline forces recapture (CodeRabbit Major) ─────
//
// The WeakMap baseline is keyed per `pi` instance, but auto sessions are NOT
// 1:1 with `pi` instances — a single `pi` can host multiple `/gsd auto` runs
// separated by stops, manual tool edits, or extension toggles.  Without
// `clearToolBaseline(pi)` at session boundaries, the SECOND auto run on the
// same `pi` would silently restore the FIRST run's snapshot and undo whatever
// tool changes the user made between sessions.  This test pins the contract
// that `clearToolBaseline` causes the next dispatch to RECAPTURE from the
// live active set rather than restoring the prior snapshot.
test("lifecycle: clearToolBaseline forces recapture; subsequent runs respect intervening tool edits", async () => {
  const env = makeTempProject();
  try {
    const availableModels = [
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
    ];
    const pi = makeRecordingPi(["A", "B", "C"]);
    clearToolBaseline(pi as unknown as object);

    // ── Run 1: captures baseline [A, B, C] ──
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi as any,
      "gate-evaluate",
      "u1",
      env.dir,
      undefined,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      undefined,
      true,
    );

    // ── Simulate `/gsd auto` stop + intervening user tool edit ──
    // (auto.ts calls clearToolBaseline in stopAuto; the user then mutates
    // tools while auto is paused.)
    clearToolBaseline(pi as unknown as object);
    pi.setActiveTools(["A", "B"]); // user removed C between sessions

    // ── Run 2: must capture [A, B] as the NEW baseline, not restore [A, B, C] ──
    const callsBeforeU2 = pi.__calls.length;
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi as any,
      "gate-evaluate",
      "u2",
      env.dir,
      undefined,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      undefined,
      true,
    );
    const u2Calls = pi.__calls.slice(callsBeforeU2);
    // No setActiveTools(["A", "B", "C"]) call should appear during u2 — that
    // would be the bug (restoring the run-1 snapshot over the user's edit).
    const staleRestore = u2Calls.find(
      c => c.kind === "setActiveTools"
        && Array.isArray(c.payload)
        && (c.payload as string[]).includes("C"),
    );
    assert.equal(
      staleRestore,
      undefined,
      "after clearToolBaseline, run 2 must NOT restore the run-1 snapshot containing tool C",
    );

    // ── Run 3 (no clear): mutate to [A], expect restore to [A, B] (run-2 baseline) ──
    pi.setActiveTools(["A"]);
    const callsBeforeU3 = pi.__calls.length;
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi as any,
      "gate-evaluate",
      "u3",
      env.dir,
      undefined,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      undefined,
      true,
    );
    const u3Calls = pi.__calls.slice(callsBeforeU3);
    const restoreToRun2Baseline = u3Calls.find(
      c => c.kind === "setActiveTools"
        && Array.isArray(c.payload)
        && (c.payload as string[]).length === 2
        && (c.payload as string[]).includes("A")
        && (c.payload as string[]).includes("B")
        && !(c.payload as string[]).includes("C"),
    );
    assert.ok(
      restoreToRun2Baseline,
      "run 3 must restore the run-2 baseline [A, B] — proves the recaptured baseline is in use, not the run-1 snapshot",
    );
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});
