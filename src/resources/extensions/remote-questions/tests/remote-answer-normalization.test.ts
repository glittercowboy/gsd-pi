/**
 * Regression tests for #4406 — remote-channel answers must be normalized to
 * the RoundResult shape { selected, notes } so the depth-verification gate
 * hook in gsd/bootstrap/register-hooks.ts recognizes them. Before the fix,
 * Telegram/Slack/Discord answers arrived as { answers: string[], user_note }
 * and `answer.selected` was always undefined, leaving the gate locked.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { toRoundResultResponse } from "../manager.ts";
import type { RemoteAnswer } from "../types.ts";
import { isDepthConfirmationAnswer } from "../../gsd/bootstrap/write-gate.ts";

const STANDARD_OPTIONS = [
  { label: "Yes, you got it (Recommended)" },
  { label: "Not quite — let me clarify" },
];

test("remote normalization: single-select Telegram answer clears depth gate (#4406)", () => {
  const remote: RemoteAnswer = {
    answers: {
      depth_verification_confirm: { answers: ["Yes, you got it (Recommended)"] },
    },
  };

  const normalized = toRoundResultResponse(remote);
  const answer = normalized.answers.depth_verification_confirm;

  assert.equal(normalized.endInterview, false);
  assert.equal(answer.selected, "Yes, you got it (Recommended)");
  assert.equal(answer.notes, "");
  assert.equal(
    isDepthConfirmationAnswer(answer.selected, STANDARD_OPTIONS),
    true,
    "normalized remote answer must unlock the depth-verification gate",
  );
});

test("remote normalization: multi-select answers stay as arrays", () => {
  const remote: RemoteAnswer = {
    answers: {
      multi_q: { answers: ["A", "B"] },
    },
  };

  const { answers } = toRoundResultResponse(remote);
  assert.deepEqual(answers.multi_q.selected, ["A", "B"]);
  assert.equal(answers.multi_q.notes, "");
});

test("remote normalization: user_note maps to notes", () => {
  const remote: RemoteAnswer = {
    answers: {
      q1: { answers: ["Not quite — let me clarify"], user_note: "Please include timeouts" },
    },
  };

  const { answers } = toRoundResultResponse(remote);
  assert.equal(answers.q1.selected, "Not quite — let me clarify");
  assert.equal(answers.q1.notes, "Please include timeouts");
});

test("remote normalization: empty answers array collapses to empty string (never undefined)", () => {
  const remote: RemoteAnswer = {
    answers: {
      q1: { answers: [], user_note: "No response provided" },
    },
  };

  const { answers } = toRoundResultResponse(remote);
  assert.equal(answers.q1.selected, "");
  assert.equal(answers.q1.notes, "No response provided");
  // Must NOT accidentally pass the gate when no selection was made.
  assert.equal(isDepthConfirmationAnswer(answers.q1.selected, STANDARD_OPTIONS), false);
});

test("remote normalization: independent entries per question id", () => {
  const remote: RemoteAnswer = {
    answers: {
      depth_verification_M001_confirm: { answers: ["Yes, you got it (Recommended)"] },
      followup: { answers: ["Option A", "Option B"], user_note: "extra" },
    },
  };

  const { answers } = toRoundResultResponse(remote);
  assert.equal(answers.depth_verification_M001_confirm.selected, "Yes, you got it (Recommended)");
  assert.equal(answers.depth_verification_M001_confirm.notes, "");
  assert.deepEqual(answers.followup.selected, ["Option A", "Option B"]);
  assert.equal(answers.followup.notes, "extra");
});
