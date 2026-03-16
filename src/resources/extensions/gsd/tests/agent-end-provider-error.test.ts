import test from "node:test";
import assert from "node:assert/strict";

import { pauseAutoForProviderError } from "../provider-error-pause.ts";

test("pauseAutoForProviderError warns and pauses without requiring ctx.log", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;

  await pauseAutoForProviderError(
    {
      notify(message, level?) {
        notifications.push({ message, level: level ?? "info" });
      },
    },
    ": terminated",
    async () => {
      pauseCalls += 1;
    },
  );

  assert.equal(pauseCalls, 1, "should pause auto-mode exactly once");
  assert.deepEqual(notifications, [
    {
      message: "Auto-mode paused due to provider error: terminated",
      level: "warning",
    },
  ]);
});
