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
      pauseAutoSection.includes("clearQueue"),
      "pauseAuto must call clearQueue() to flush queued follow-up messages",
    );
  });

  test("run-unit.ts still has its existing clearQueue() call (baseline)", () => {
    // Verify the original clearQueue pattern in run-unit.ts hasn't been removed.
    assert.ok(
      runUnitSrc.includes("clearQueue"),
      "run-unit.ts must retain its clearQueue() call after unit completion",
    );
  });
});
