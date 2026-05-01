/**
 * Regression test for the remote_questions.channel_id snowflake-precision bug:
 * Discord/Telegram IDs can exceed 2^53, so YAML parsers that coerce them to
 * JS numbers silently corrupt the value (e.g. 1234567890123456789 →
 * 1234567890123456800). validatePreferences must reject numeric channel_id
 * with a clear error pointing the user at the fix (quote the value).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validatePreferences } from "../preferences.ts";

test("remote_questions.channel_id as number is rejected with a precision-loss error", () => {
  const { errors } = validatePreferences({
    remote_questions: {
      channel: "discord",
      channel_id: 1234567890123456789 as unknown as string,
    },
  } as any);

  assert.ok(errors.length > 0, "must produce at least one error");
  const msg = errors.join("\n");
  assert.match(msg, /channel_id/);
  assert.match(msg, /string|quoted/i);
  assert.match(msg, /2\^53|precision/i);
});

test("remote_questions.channel_id as quoted string passes validation", () => {
  const { errors, preferences } = validatePreferences({
    remote_questions: {
      channel: "discord",
      channel_id: "1234567890123456789",
    },
  } as any);

  assert.equal(errors.length, 0, `expected no errors, got: ${errors.join(", ")}`);
  assert.equal(preferences.remote_questions?.channel_id, "1234567890123456789");
});

test("remote_questions.channel_id error suggests the exact quoted replacement", () => {
  const { errors } = validatePreferences({
    remote_questions: {
      channel: "discord",
      channel_id: 999999999999999999 as unknown as string,
    },
  } as any);

  // The message should point at the offending value so the user can fix it
  // without parsing a generic "must be a string" complaint.
  const msg = errors.join("\n");
  assert.match(msg, /channel_id/);
});

test("remote_questions as non-object is rejected", () => {
  const { errors } = validatePreferences({
    remote_questions: "discord" as unknown as object,
  } as any);
  assert.ok(errors.some((e) => /remote_questions must be an object/.test(e)));
});
