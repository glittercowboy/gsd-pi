/**
 * Tests for Pi SDK event classifier (TDD — RED first, then GREEN).
 * Covers all 8 GSD2EventType variants plus null/unknown/malformed inputs.
 */
import { describe, test, expect } from "bun:test";
import { classifyPiSdkEvent } from "../src/server/ndjson-parser";

describe("classifyPiSdkEvent", () => {
  // -- 8 happy-path variants --

  test("plain_text: { type: 'text', text: string } → { kind: 'plain_text', text }", () => {
    const result = classifyPiSdkEvent({ type: "text", text: "hello" });
    expect(result).toEqual({ kind: "plain_text", text: "hello" });
  });

  test("tool_use: { type: 'tool_use', name, input } → { kind: 'tool_use', name, input }", () => {
    const result = classifyPiSdkEvent({ type: "tool_use", name: "Read", input: { path: "/x" } });
    expect(result).toEqual({ kind: "tool_use", name: "Read", input: { path: "/x" } });
  });

  test("tool_result: { type: 'tool_result', tool_use_id, content } → { kind: 'tool_result', ... }", () => {
    const result = classifyPiSdkEvent({ type: "tool_result", tool_use_id: "tu_1", content: "ok" });
    expect(result).toEqual({ kind: "tool_result", tool_use_id: "tu_1", content: "ok" });
  });

  test("phase_transition: { type: 'phase_transition', phase } → { kind: 'phase_transition', phase }", () => {
    const result = classifyPiSdkEvent({ type: "phase_transition", phase: "Executing" });
    expect(result).toEqual({ kind: "phase_transition", phase: "Executing" });
  });

  test("cost_update: { type: 'cost_update', total_cost_usd, input_tokens, output_tokens } → { kind: 'cost_update', ... }", () => {
    const result = classifyPiSdkEvent({
      type: "cost_update",
      total_cost_usd: 0.05,
      input_tokens: 1000,
      output_tokens: 200,
    });
    expect(result).toEqual({
      kind: "cost_update",
      total_cost_usd: 0.05,
      input_tokens: 1000,
      output_tokens: 200,
    });
  });

  test("stuck_detection: { type: 'stuck_detection', message } → { kind: 'stuck_detection', message }", () => {
    const result = classifyPiSdkEvent({ type: "stuck_detection", message: "Looping" });
    expect(result).toEqual({ kind: "stuck_detection", message: "Looping" });
  });

  test("timeout: { type: 'timeout', message, elapsed_seconds } → { kind: 'timeout', ... }", () => {
    const result = classifyPiSdkEvent({ type: "timeout", message: "Timed out", elapsed_seconds: 120 });
    expect(result).toEqual({ kind: "timeout", message: "Timed out", elapsed_seconds: 120 });
  });

  test("auto_mode_announcement: { type: 'auto_mode_announcement', mode, slice? } → { kind: 'auto_mode_announcement', ... }", () => {
    const result = classifyPiSdkEvent({
      type: "auto_mode_announcement",
      mode: "start",
      slice: "S01",
    });
    expect(result).toEqual({ kind: "auto_mode_announcement", mode: "start", slice: "S01" });
  });

  // -- null / unknown / malformed inputs --

  test("string input (not object) → null", () => {
    expect(classifyPiSdkEvent("{broken")).toBeNull();
  });

  test("unknown type field → null (no throw)", () => {
    expect(classifyPiSdkEvent({ type: "unknown_future_event" })).toBeNull();
  });

  test("null input → null", () => {
    expect(classifyPiSdkEvent(null)).toBeNull();
  });

  test("plain_text missing required 'text' field → null", () => {
    expect(classifyPiSdkEvent({ type: "text" })).toBeNull();
  });
});
