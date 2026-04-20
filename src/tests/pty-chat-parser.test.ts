import test from "node:test";
import assert from "node:assert/strict";

const { PtyChatParser } = await import("../../web/lib/pty-chat-parser.ts");

test("PtyChatParser.flush emits a trailing partial line without waiting for a newline", () => {
  const parser = new PtyChatParser("test");
  let latest = parser.getMessages();
  parser.onMessage(() => {
    latest = parser.getMessages();
  });

  parser.feed("All slices are complete — nothing to discuss.");
  assert.equal(latest.length, 0, "partial line should stay buffered before flush");

  parser.flush();

  assert.equal(latest.length, 1);
  assert.equal(latest[0]?.role, "assistant");
  assert.equal(latest[0]?.content, "All slices are complete — nothing to discuss.\n");
});

// ─── Bug #2707: User messages omitted ────────────────────────────────────────

test("user input echoed on the same prompt line is classified as role=user", () => {
  const parser = new PtyChatParser("test");
  let latest = parser.getMessages();
  parser.onMessage(() => {
    latest = parser.getMessages();
  });

  // GSD prints assistant response, then prompt with user input on same line
  parser.feed("Here is your task summary.\n");
  parser.feed("❯ show status\n");

  const userMsgs = latest.filter((m) => m.role === "user");
  assert.equal(userMsgs.length, 1, "should have exactly one user message");
  assert.equal(userMsgs[0].content, "show status");
});

test("user input on a separate line after bare prompt is classified as role=user, not assistant", () => {
  const parser = new PtyChatParser("test");
  let latest = parser.getMessages();
  parser.onMessage(() => {
    latest = parser.getMessages();
  });

  // GSD prints assistant text, then bare prompt on its own line
  parser.feed("Done processing.\n");
  parser.feed("❯ \n");
  // User input appears on the next line (PTY echo without prompt prefix)
  parser.feed("hello world\n");

  const userMsgs = latest.filter((m) => m.role === "user");
  assert.equal(userMsgs.length, 1, "should have exactly one user message");
  assert.equal(userMsgs[0].content, "hello world");

  // The user input must NOT appear as assistant content
  const assistantMsgs = latest.filter((m) => m.role === "assistant");
  for (const msg of assistantMsgs) {
    assert.ok(
      !msg.content.includes("hello world"),
      "user input must not be misclassified as assistant content",
    );
  }
});

test("multiple user turns: each user input after prompt is role=user", () => {
  const parser = new PtyChatParser("test");
  let latest = parser.getMessages();
  parser.onMessage(() => {
    latest = parser.getMessages();
  });

  // Turn 1: assistant response, prompt, user input
  parser.feed("Welcome to GSD.\n");
  parser.feed("❯ \n");
  parser.feed("discuss\n");

  // Turn 2: assistant response, prompt, user input
  parser.feed("Starting discussion mode.\n");
  parser.feed("❯ \n");
  parser.feed("plan my milestone\n");

  const userMsgs = latest.filter((m) => m.role === "user");
  assert.equal(userMsgs.length, 2, "should have two user messages");
  assert.equal(userMsgs[0].content, "discuss");
  assert.equal(userMsgs[1].content, "plan my milestone");
});

test("awaitingInput is true after prompt line, false after user input arrives", () => {
  const parser = new PtyChatParser("test");

  parser.feed("Task complete.\n");
  assert.equal(parser.isAwaitingInput(), false, "not awaiting input before prompt");

  parser.feed("❯ \n");
  assert.equal(parser.isAwaitingInput(), true, "awaiting input after bare prompt");

  parser.feed("next command\n");
  assert.equal(parser.isAwaitingInput(), false, "no longer awaiting after user input");
});

test("awaitingInput resets when assistant content follows user input", () => {
  const parser = new PtyChatParser("test");

  parser.feed("Hello.\n");
  parser.feed("❯ \n");
  assert.equal(parser.isAwaitingInput(), true);

  parser.feed("do something\n");
  assert.equal(parser.isAwaitingInput(), false);

  // Assistant responds
  parser.feed("Working on it...\n");
  assert.equal(parser.isAwaitingInput(), false, "should stay false during assistant output");
});

// ─── Bug #2707: Chat looks stuck ────────────────────────────────────────────

test("prompt with empty user text does not create a user message but signals awaiting input", () => {
  const parser = new PtyChatParser("test");
  let latest = parser.getMessages();
  parser.onMessage(() => {
    latest = parser.getMessages();
  });

  parser.feed("All done.\n");
  parser.feed("❯ \n");

  const userMsgs = latest.filter((m) => m.role === "user");
  assert.equal(userMsgs.length, 0, "bare prompt should not create a user message");
  assert.equal(parser.isAwaitingInput(), true, "parser should signal awaiting input");
});

test("alternate prompt markers (› and >) also trigger awaiting input", () => {
  const parser = new PtyChatParser("test");

  parser.feed("Response text.\n");
  parser.feed("› \n");
  assert.equal(parser.isAwaitingInput(), true, "› prompt should trigger awaiting input");

  parser.feed("user reply\n");
  assert.equal(parser.isAwaitingInput(), false);

  parser.feed("More output.\n");
  parser.feed("> \n");
  assert.equal(parser.isAwaitingInput(), true, "> prompt should trigger awaiting input");
});
