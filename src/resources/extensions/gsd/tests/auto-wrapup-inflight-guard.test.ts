// GSD-2 — Regression tests for #3512: gsd-auto-wrapup mid-turn interruption
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const autoTimersPath = join(import.meta.dirname, "..", "auto-timers.ts");
const autoTimersSrc = readFileSync(autoTimersPath, "utf-8");

const autoPath = join(import.meta.dirname, "..", "auto.ts");
const autoSrc = readFileSync(autoPath, "utf-8");

const runUnitPath = join(import.meta.dirname, "..", "auto", "run-unit.ts");
const runUnitSrc = readFileSync(runUnitPath, "utf-8");

const registerHooksPath = join(import.meta.dirname, "..", "bootstrap", "register-hooks.ts");
const registerHooksSrc = readFileSync(registerHooksPath, "utf-8");

describe("#3512: gsd-auto-wrapup must not interrupt in-flight tool calls", () => {
  test("soft timeout wrapup gates triggerTurn on getInFlightToolCount() === 0", () => {
    // The soft timeout sendMessage must NOT use a hardcoded `triggerTurn: true`.
    // It must check getInFlightToolCount() before deciding whether to trigger.
    // Use the section marker comment to isolate the soft timeout block.
    const startMarker = "── 1. Soft timeout warning";
    const endMarker = "── 2. Idle watchdog";
    const softTimeoutSection = autoTimersSrc.slice(
      autoTimersSrc.indexOf(startMarker),
      autoTimersSrc.indexOf(endMarker),
    );
    assert.ok(
      softTimeoutSection.length > 0,
      "Could not locate soft timeout section",
    );

    // Must reference getInFlightToolCount to gate the trigger
    assert.ok(
      softTimeoutSection.includes("getInFlightToolCount"),
      "Soft timeout wrapup must gate triggerTurn behind getInFlightToolCount() check",
    );

    // Must NOT have a hardcoded triggerTurn: true
    assert.ok(
      !softTimeoutSection.includes("triggerTurn: true"),
      "Soft timeout wrapup must not use hardcoded triggerTurn: true",
    );
  });

  test("context-pressure wrapup gates triggerTurn on getInFlightToolCount() === 0", () => {
    // The context budget sendMessage must NOT use a hardcoded `triggerTurn: true`.
    // Use the section marker to isolate the context-pressure block.
    const startMarker = "── 4. Context-pressure continue-here monitor";
    const contextSection = autoTimersSrc.slice(
      autoTimersSrc.indexOf(startMarker),
    );
    assert.ok(
      contextSection.length > 0,
      "Could not locate context budget section",
    );

    // Must reference getInFlightToolCount to gate the trigger
    assert.ok(
      contextSection.includes("getInFlightToolCount"),
      "Context budget wrapup must gate triggerTurn behind getInFlightToolCount() check",
    );

    // Must NOT have a hardcoded triggerTurn: true
    assert.ok(
      !contextSection.includes("triggerTurn: true"),
      "Context budget wrapup must not use hardcoded triggerTurn: true",
    );
  });
});

describe("#4276: pending/skipped tools stay visible to auto-mode hooks", () => {
  test("tool_call handler marks GSD tools in-flight before execution_start", () => {
    const startMarker = 'pi.on("tool_call", async (event, ctx) => {';
    const endMarker = 'pi.on("tool_result", async (event) => {';
    const toolCallSection = registerHooksSrc.slice(
      registerHooksSrc.indexOf(startMarker),
      registerHooksSrc.indexOf(endMarker),
    );

    assert.ok(toolCallSection.length > 0, "Could not locate tool_call handler section");
    assert.ok(
      toolCallSection.includes("markToolStart(event.toolCallId, event.toolName)"),
      "tool_call handler must mark tools pending before tool_execution_start fires",
    );
  });

  test("tool_result handler clears pending tools and records queued-skip errors", () => {
    const startMarker = 'pi.on("tool_result", async (event) => {';
    const endMarker = 'pi.on("tool_execution_start", async (event) => {';
    const toolResultSection = registerHooksSrc.slice(
      registerHooksSrc.indexOf(startMarker),
      registerHooksSrc.indexOf(endMarker),
    );

    assert.ok(toolResultSection.length > 0, "Could not locate tool_result handler section");
    assert.ok(
      toolResultSection.includes("markToolEnd(event.toolCallId)"),
      "tool_result handler must clear pending tool tracking even when execution hooks never fire",
    );
    assert.ok(
      toolResultSection.includes("recordToolInvocationError(event.toolName, errorText)"),
      "tool_result handler must surface queued-skip errors for GSD tools",
    );
  });
});

describe("#3512: pauseAuto and stopAuto must flush queued follow-up messages", () => {
  test("stopAuto calls clearQueue()", () => {
    // stopAuto must flush queued messages to prevent late async_job_result
    // notifications from triggering extra LLM turns after stop.
    const stopAutoSection = autoSrc.slice(
      autoSrc.indexOf("export async function stopAuto("),
      autoSrc.indexOf("export async function pauseAuto("),
    );
    assert.ok(stopAutoSection, "Could not locate stopAuto function");
    assert.ok(
      stopAutoSection.includes("ignoreAsyncJobsForUnitExecution"),
      "stopAuto must mark the current unit's async jobs stale before flushing follow-up messages",
    );
    assert.ok(
      stopAutoSection.includes("clearQueue"),
      "stopAuto must call clearQueue() to flush queued follow-up messages",
    );
  });

  test("pauseAuto calls clearQueue()", () => {
    // pauseAuto must also flush queued messages — same issue as stopAuto.
    const pauseAutoSection = autoSrc.slice(
      autoSrc.indexOf("export async function pauseAuto("),
    );
    assert.ok(pauseAutoSection, "Could not locate pauseAuto function");
    assert.ok(
      pauseAutoSection.includes("ignoreAsyncJobsForUnitExecution"),
      "pauseAuto must mark the current unit's async jobs stale before flushing follow-up messages",
    );
    assert.ok(
      pauseAutoSection.includes("clearQueue"),
      "pauseAuto must call clearQueue() to flush queued follow-up messages",
    );
  });

  test("run-unit.ts still has its existing clearQueue() call (baseline)", () => {
    // Verify the original clearQueue pattern in run-unit.ts hasn't been removed.
    assert.ok(
      runUnitSrc.includes("ignoreAsyncJobsForUnitExecution"),
      "run-unit.ts must mark completed unit-owned async jobs stale before clearing follow-up queue",
    );
    assert.ok(
      runUnitSrc.includes("clearQueue"),
      "run-unit.ts must retain its clearQueue() call after unit completion",
    );
  });
});

describe("#4365: tool_execution_start hook must pass toolName to markToolStart", () => {
  test("tool_execution_start handler passes event.toolName to markToolStart", () => {
    // The tool_execution_start handler must forward toolName so that
    // hasInteractiveToolInFlight() can correctly identify ask_user_questions
    // and prevent the idle watchdog from firing during interactive tool calls.
    const startMarker = 'pi.on("tool_execution_start", async (event) => {';
    const endMarker = 'pi.on("tool_execution_end", async (event) => {';
    const toolExecutionStartSection = registerHooksSrc.slice(
      registerHooksSrc.indexOf(startMarker),
      registerHooksSrc.indexOf(endMarker),
    );

    assert.ok(
      toolExecutionStartSection.length > 0,
      "Could not locate tool_execution_start handler section",
    );
    assert.ok(
      toolExecutionStartSection.includes("markToolStart(event.toolCallId, event.toolName)"),
      "tool_execution_start handler must pass event.toolName to markToolStart so hasInteractiveToolInFlight() works correctly",
    );
  });
});

describe("#4670: stale async jobs must be tracked, filtered, and truncated", () => {
  test("startAuto rebinds the shared async job event bus after session reset", () => {
    const startAutoSection = autoSrc.slice(
      autoSrc.indexOf("export async function startAuto("),
      autoSrc.indexOf("export { describeNextUnit }"),
    );
    assert.ok(startAutoSection.length > 0, "Could not locate startAuto function");
    assert.ok(
      startAutoSection.includes("setAsyncJobEventBus(pi.events)"),
      "startAuto must rebind the shared async job event bus on each start/resume attempt",
    );
  });

  test("registerHooks wires async job tracking and shared event bus", () => {
    assert.ok(
      registerHooksSrc.includes("setAsyncJobEventBus(pi.events)"),
      "registerHooks must give auto-mode access to the shared event bus for async job cleanup",
    );
    assert.ok(
      registerHooksSrc.includes("trackAsyncBashJob(event.toolName, event.result)"),
      "tool_execution_end must track async_bash job ids from successful tool results",
    );
  });

  test("before_provider_request filters ignored late async job messages and truncates wrapped notifications", () => {
    const startMarker = 'pi.on("before_provider_request", async (event) => {';
    const beforeProviderSection = registerHooksSrc.slice(
      registerHooksSrc.indexOf(startMarker),
    );

    assert.ok(beforeProviderSection.length > 0, "Could not locate before_provider_request handler section");
    assert.ok(
      beforeProviderSection.includes("filterIgnoredAsyncJobMessages"),
      "before_provider_request must drop ignored late async_job_result notifications",
    );
    assert.ok(
      beforeProviderSection.includes("truncateContextMessage"),
      "before_provider_request must reuse shared truncation for wrapped tool-derived messages",
    );
    assert.ok(
      beforeProviderSection.includes("isAutoActive() || isAutoPaused()"),
      "before_provider_request must enforce stale async-job hygiene while auto-mode is paused as well as active",
    );
  });
});
