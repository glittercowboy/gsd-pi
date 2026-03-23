import test from "node:test";
import assert from "node:assert/strict";
import { formatForSignal, parseSignalResponse, parseSlackReply } from "../../remote-questions/format.ts";
import { isValidChannelId } from "../../remote-questions/config.ts";

// ---------------------------------------------------------------------------
// Signal channel ID validation
// ---------------------------------------------------------------------------

test("isValidChannelId accepts valid Signal phone numbers", () => {
  assert.ok(isValidChannelId("signal", "+15551234567"));
  assert.ok(isValidChannelId("signal", "+442071234567"));
  assert.ok(isValidChannelId("signal", "+8613800138000"));
});

test("isValidChannelId rejects invalid Signal phone numbers", () => {
  assert.ok(!isValidChannelId("signal", "5551234567"));    // missing +
  assert.ok(!isValidChannelId("signal", "+123"));           // too short
  assert.ok(!isValidChannelId("signal", "not-a-number"));   // letters
  assert.ok(!isValidChannelId("signal", ""));               // empty
});

// ---------------------------------------------------------------------------
// Signal message formatting
// ---------------------------------------------------------------------------

test("formatForSignal produces readable plain text for single question", () => {
  const prompt = {
    id: "test-123",
    channel: "signal" as const,
    createdAt: Date.now(),
    timeoutAt: Date.now() + 300_000,
    pollIntervalMs: 5000,
    questions: [{
      id: "choice",
      header: "Approach",
      question: "Which approach do you prefer?",
      options: [
        { label: "Option A", description: "First approach" },
        { label: "Option B", description: "Second approach" },
      ],
      allowMultiple: false,
    }],
  };

  const text = formatForSignal(prompt);

  assert.ok(text.includes("GSD needs your input"));
  assert.ok(text.includes("📋 Approach"));
  assert.ok(text.includes("Which approach do you prefer?"));
  assert.ok(text.includes("1. Option A — First approach"));
  assert.ok(text.includes("2. Option B — Second approach"));
  assert.ok(text.includes("Reply with a number"));
});

test("formatForSignal handles multi-select prompt", () => {
  const prompt = {
    id: "test-456",
    channel: "signal" as const,
    createdAt: Date.now(),
    timeoutAt: Date.now() + 300_000,
    pollIntervalMs: 5000,
    questions: [{
      id: "multi",
      header: "Features",
      question: "Which features do you want?",
      options: [
        { label: "Auth", description: "Authentication" },
        { label: "API", description: "REST API" },
        { label: "UI", description: "Web dashboard" },
      ],
      allowMultiple: true,
    }],
  };

  const text = formatForSignal(prompt);
  assert.ok(text.includes("comma-separated numbers"));
});

test("formatForSignal handles multi-question prompt", () => {
  const prompt = {
    id: "test-789",
    channel: "signal" as const,
    createdAt: Date.now(),
    timeoutAt: Date.now() + 300_000,
    pollIntervalMs: 5000,
    questions: [
      {
        id: "q1",
        header: "First",
        question: "Pick one",
        options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
        allowMultiple: false,
      },
      {
        id: "q2",
        header: "Second",
        question: "Pick another",
        options: [{ label: "C", description: "c" }, { label: "D", description: "d" }],
        allowMultiple: false,
      },
    ],
  };

  const text = formatForSignal(prompt);
  assert.ok(text.includes("Question 1/2"));
  assert.ok(text.includes("Question 2/2"));
  assert.ok(text.includes("semicolons"));
});

// ---------------------------------------------------------------------------
// Signal response parsing
// ---------------------------------------------------------------------------

test("parseSignalResponse handles single-number answer", () => {
  const result = parseSignalResponse("2", [{
    id: "choice",
    header: "Choice",
    question: "Pick one",
    allowMultiple: false,
    options: [
      { label: "Alpha", description: "A" },
      { label: "Beta", description: "B" },
    ],
  }], "prompt-1");

  assert.deepEqual(result, { answers: { choice: { answers: ["Beta"] } } });
});

test("parseSignalResponse handles comma-separated multi-select", () => {
  const result = parseSignalResponse("1,3", [{
    id: "multi",
    header: "Multi",
    question: "Pick several",
    allowMultiple: true,
    options: [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
      { label: "C", description: "c" },
    ],
  }], "prompt-2");

  assert.deepEqual(result, { answers: { multi: { answers: ["A", "C"] } } });
});

test("parseSignalResponse handles free text as user_note", () => {
  const result = parseSignalResponse("I want something custom", [{
    id: "choice",
    header: "Choice",
    question: "Pick one",
    allowMultiple: false,
    options: [
      { label: "Alpha", description: "A" },
      { label: "Beta", description: "B" },
    ],
  }], "prompt-3");

  assert.deepEqual(result, {
    answers: { choice: { answers: [], user_note: "I want something custom" } },
  });
});

test("parseSignalResponse handles multi-question semicolon answers", () => {
  const result = parseSignalResponse("1; custom note", [
    {
      id: "first",
      header: "First",
      question: "Pick one",
      allowMultiple: false,
      options: [
        { label: "Alpha", description: "A" },
        { label: "Beta", description: "B" },
      ],
    },
    {
      id: "second",
      header: "Second",
      question: "Explain",
      allowMultiple: false,
      options: [
        { label: "Gamma", description: "G" },
        { label: "Delta", description: "D" },
      ],
    },
  ], "prompt-4");

  assert.deepEqual(result, {
    answers: {
      first: { answers: ["Alpha"] },
      second: { answers: [], user_note: "custom note" },
    },
  });
});

test("parseSignalResponse handles empty text", () => {
  const result = parseSignalResponse("", [{
    id: "choice",
    header: "Choice",
    question: "Pick one",
    allowMultiple: false,
    options: [{ label: "A", description: "a" }],
  }], "prompt-5");

  assert.deepEqual(result, {
    answers: { choice: { answers: [], user_note: "No response provided" } },
  });
});

// ---------------------------------------------------------------------------
// Signal adapter — constructor / validation (unit-level, no network)
// ---------------------------------------------------------------------------

test("SignalAdapter requires SIGNAL_PHONE_NUMBER", async () => {
  const { SignalAdapter } = await import("../../remote-questions/signal-adapter.ts");
  const original = process.env.SIGNAL_PHONE_NUMBER;
  delete process.env.SIGNAL_PHONE_NUMBER;

  const adapter = new SignalAdapter("http://localhost:8080", "+15551234567");
  await assert.rejects(
    () => adapter.validate(),
    { message: /SIGNAL_PHONE_NUMBER not set/ },
  );

  if (original !== undefined) process.env.SIGNAL_PHONE_NUMBER = original;
});
