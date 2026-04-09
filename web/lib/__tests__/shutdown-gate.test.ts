import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  scheduleShutdown,
  cancelShutdown,
  isShutdownPending,
  isDaemonMode,
} from "../shutdown-gate.ts";

describe("shutdown-gate", () => {
  afterEach(() => {
    // Always clean up any pending timers between tests
    cancelShutdown();
    delete process.env.GSD_WEB_DAEMON_MODE;
  });

  describe("default mode (no daemon)", () => {
    test("scheduleShutdown() sets a pending timer", () => {
      scheduleShutdown();
      assert.equal(isShutdownPending(), true);
    });

    test("cancelShutdown() clears the pending timer", () => {
      scheduleShutdown();
      cancelShutdown();
      assert.equal(isShutdownPending(), false);
    });

    test("isDaemonMode() returns false", () => {
      assert.equal(isDaemonMode(), false);
    });
  });

  describe("daemon mode (GSD_WEB_DAEMON_MODE=1)", () => {
    beforeEach(() => {
      process.env.GSD_WEB_DAEMON_MODE = "1";
    });

    test("isDaemonMode() returns true", () => {
      assert.equal(isDaemonMode(), true);
    });

    test("scheduleShutdown() does not schedule a timer", () => {
      scheduleShutdown();
      assert.equal(
        isShutdownPending(),
        false,
        "shutdown timer must not be set in daemon mode",
      );
    });

    test("scheduleShutdown() is safe to call multiple times", () => {
      scheduleShutdown();
      scheduleShutdown();
      scheduleShutdown();
      assert.equal(isShutdownPending(), false);
    });
  });

  describe("daemon mode is not activated by other values", () => {
    test("GSD_WEB_DAEMON_MODE=0 does not enable daemon mode", () => {
      process.env.GSD_WEB_DAEMON_MODE = "0";
      assert.equal(isDaemonMode(), false);
      scheduleShutdown();
      assert.equal(isShutdownPending(), true);
    });

    test("GSD_WEB_DAEMON_MODE=true does not enable daemon mode", () => {
      process.env.GSD_WEB_DAEMON_MODE = "true";
      assert.equal(isDaemonMode(), false);
      scheduleShutdown();
      assert.equal(isShutdownPending(), true);
    });

    test("unset GSD_WEB_DAEMON_MODE does not enable daemon mode", () => {
      delete process.env.GSD_WEB_DAEMON_MODE;
      assert.equal(isDaemonMode(), false);
      scheduleShutdown();
      assert.equal(isShutdownPending(), true);
    });
  });
});
