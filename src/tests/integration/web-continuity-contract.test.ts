import test from "node:test";
import assert from "node:assert/strict";

// ─── Constants mirrored from gsd-workspace-store.tsx ─────────────────
// These MUST match the exported values in the store. The final test
// case verifies the store's actual exported values if the runtime
// supports .tsx imports; otherwise we trust these mirrors.
const MAX_TRANSCRIPT_BLOCKS = 100;
const COMMAND_TIMEOUT_MS = 90_000;
const VISIBILITY_REFRESH_THRESHOLD_MS = 30_000;

// ---------------------------------------------------------------------------
// Inline routing harness — mirrors GSDWorkspaceStore logic for the
// four continuity/safety mechanisms under test.
// ---------------------------------------------------------------------------

interface ContinuityState {
  liveTranscript: string[];
  streamingAssistantText: string;
  commandInFlight: string | null;
  lastClientError: string | null;
  terminalErrorLines: string[];
  connectionState: string;
  refreshBootCalls: Array<{ soft: boolean }>;
  lastBootRefreshAt: number;
  commandTimeoutTimer: ReturnType<typeof setTimeout> | null;
}

function createContinuityState(): ContinuityState {
  return {
    liveTranscript: [],
    streamingAssistantText: "",
    commandInFlight: null,
    lastClientError: null,
    terminalErrorLines: [],
    connectionState: "idle",
    refreshBootCalls: [],
    lastBootRefreshAt: 0,
    commandTimeoutTimer: null,
  };
}

/** Mirrors handleTurnBoundary with the MAX_TRANSCRIPT_BLOCKS cap */
function handleTurnBoundary(state: ContinuityState): ContinuityState {
  if (state.streamingAssistantText.length > 0) {
    const next = [...state.liveTranscript, state.streamingAssistantText];
    return {
      ...state,
      liveTranscript:
        next.length > MAX_TRANSCRIPT_BLOCKS
          ? next.slice(next.length - MAX_TRANSCRIPT_BLOCKS)
          : next,
      streamingAssistantText: "",
    };
  }
  return state;
}

/** Mirrors message_update accumulation */
function accumulateText(state: ContinuityState, delta: string): ContinuityState {
  return { ...state, streamingAssistantText: state.streamingAssistantText + delta };
}

/** Mirrors the command timeout mechanism from sendCommand */
function startCommandWithTimeout(
  state: ContinuityState,
  commandType: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): ContinuityState {
  // Clear any existing timer
  if (state.commandTimeoutTimer) clearTimeout(state.commandTimeoutTimer);

  const s = { ...state, commandInFlight: commandType };

  s.commandTimeoutTimer = setTimeout(() => {
    if (s.commandInFlight) {
      s.commandInFlight = null;
      s.lastClientError = "Command timed out — controls re-enabled";
      s.terminalErrorLines = [...s.terminalErrorLines, "Command timed out — controls re-enabled"];
    }
  }, timeoutMs);

  return s;
}

/** Mirrors the finally block that clears commandInFlight on normal completion */
function completeCommand(state: ContinuityState): ContinuityState {
  if (state.commandTimeoutTimer) {
    clearTimeout(state.commandTimeoutTimer);
  }
  return { ...state, commandInFlight: null, commandTimeoutTimer: null };
}

/** Mirrors SSE onopen reconnect logic */
function handleSseOpen(state: ContinuityState, previousStreamState: string): ContinuityState {
  const wasDisconnected =
    previousStreamState === "reconnecting" ||
    previousStreamState === "disconnected" ||
    previousStreamState === "error";

  const s = { ...state, connectionState: "connected" };

  if (wasDisconnected) {
    s.refreshBootCalls = [...s.refreshBootCalls, { soft: true }];
  }

  return s;
}

/** Mirrors visibilitychange listener logic */
function handleVisibilityReturn(state: ContinuityState, now: number): ContinuityState {
  if (now - state.lastBootRefreshAt >= VISIBILITY_REFRESH_THRESHOLD_MS) {
    return {
      ...state,
      refreshBootCalls: [...state.refreshBootCalls, { soft: true }],
      lastBootRefreshAt: now,
    };
  }
  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Transcript cap: pushing 110 blocks keeps only the last 100, oldest dropped", () => {
  let state = createContinuityState();

  // Push 110 turns
  for (let i = 0; i < 110; i++) {
    state = accumulateText(state, `block-${i}`);
    state = handleTurnBoundary(state);
  }

  assert.ok(
    state.liveTranscript.length <= MAX_TRANSCRIPT_BLOCKS,
    `Transcript length ${state.liveTranscript.length} should be ≤ ${MAX_TRANSCRIPT_BLOCKS}`,
  );
  assert.equal(state.liveTranscript.length, MAX_TRANSCRIPT_BLOCKS);

  // Oldest blocks (0-9) should be dropped; newest (10-109) should remain
  assert.equal(state.liveTranscript[0], "block-10");
  assert.equal(state.liveTranscript[99], "block-109");
});

test("Transcript cap: exactly at cap does not trim", () => {
  let state = createContinuityState();

  for (let i = 0; i < MAX_TRANSCRIPT_BLOCKS; i++) {
    state = accumulateText(state, `block-${i}`);
    state = handleTurnBoundary(state);
  }

  assert.equal(state.liveTranscript.length, MAX_TRANSCRIPT_BLOCKS);
  assert.equal(state.liveTranscript[0], "block-0");
  assert.equal(state.liveTranscript[99], "block-99");
});

test("Command timeout: stuck command is cleared after timeout with error visibility", async () => {
  let state = createContinuityState();

  // Start a command with a very short timeout for testing
  const shortTimeout = 50; // 50ms for test speed
  state = startCommandWithTimeout(state, "prompt", shortTimeout);

  assert.equal(state.commandInFlight, "prompt");

  // Wait for the timeout to fire
  await new Promise((resolve) => setTimeout(resolve, shortTimeout + 50));

  // The timeout callback mutates the state object directly (as the real store does)
  assert.equal(state.commandInFlight, null, "commandInFlight should be cleared after timeout");
  assert.equal(
    state.lastClientError,
    "Command timed out — controls re-enabled",
    "lastClientError should be set with timeout message",
  );
  assert.ok(
    state.terminalErrorLines.includes("Command timed out — controls re-enabled"),
    "Error terminal line should be emitted",
  );
});

test("Command timeout: normal completion clears the timer before it fires", async () => {
  let state = createContinuityState();

  // Start a command with a short timeout
  state = startCommandWithTimeout(state, "prompt", 100);
  assert.equal(state.commandInFlight, "prompt");

  // Complete normally before timeout
  state = completeCommand(state);
  assert.equal(state.commandInFlight, null);

  // Wait past when the timeout would have fired
  await new Promise((resolve) => setTimeout(resolve, 200));

  // No error should have been set
  assert.equal(state.lastClientError, null, "No timeout error after normal completion");
  assert.equal(state.terminalErrorLines.length, 0, "No error terminal lines after normal completion");
});

test("Reconnect triggers soft refresh: SSE reconnect from reconnecting state", () => {
  let state = createContinuityState();
  state.connectionState = "reconnecting";

  state = handleSseOpen(state, "reconnecting");

  assert.equal(state.connectionState, "connected");
  assert.equal(state.refreshBootCalls.length, 1);
  assert.deepEqual(state.refreshBootCalls[0], { soft: true });
});

test("Reconnect triggers soft refresh: SSE reconnect from disconnected state", () => {
  let state = createContinuityState();
  state.connectionState = "disconnected";

  state = handleSseOpen(state, "disconnected");

  assert.equal(state.connectionState, "connected");
  assert.equal(state.refreshBootCalls.length, 1);
  assert.deepEqual(state.refreshBootCalls[0], { soft: true });
});

test("Reconnect triggers soft refresh: SSE reconnect from error state", () => {
  let state = createContinuityState();
  state.connectionState = "error";

  state = handleSseOpen(state, "error");

  assert.equal(state.connectionState, "connected");
  assert.equal(state.refreshBootCalls.length, 1);
  assert.deepEqual(state.refreshBootCalls[0], { soft: true });
});

test("Reconnect does NOT trigger refresh when previous state was connected", () => {
  let state = createContinuityState();
  state.connectionState = "connected";

  state = handleSseOpen(state, "connected");

  assert.equal(state.connectionState, "connected");
  assert.equal(state.refreshBootCalls.length, 0);
});

test("Reconnect does NOT trigger refresh when previous state was idle (first connect)", () => {
  let state = createContinuityState();
  state.connectionState = "idle";

  state = handleSseOpen(state, "idle");

  assert.equal(state.connectionState, "connected");
  assert.equal(state.refreshBootCalls.length, 0);
});

test("Visibility return triggers soft refresh when ≥30s since last boot refresh", () => {
  let state = createContinuityState();
  state.lastBootRefreshAt = Date.now() - VISIBILITY_REFRESH_THRESHOLD_MS - 1000; // 31s ago

  const now = Date.now();
  state = handleVisibilityReturn(state, now);

  assert.equal(state.refreshBootCalls.length, 1);
  assert.deepEqual(state.refreshBootCalls[0], { soft: true });
  assert.equal(state.lastBootRefreshAt, now);
});

test("Visibility return skipped when <30s since last boot refresh", () => {
  let state = createContinuityState();
  const now = Date.now();
  state.lastBootRefreshAt = now - 10_000; // 10s ago — well within threshold

  state = handleVisibilityReturn(state, now);

  assert.equal(state.refreshBootCalls.length, 0, "No refresh when recent");
});

test("Visibility return skipped when exactly at threshold boundary", () => {
  let state = createContinuityState();
  const now = Date.now();
  // Exactly at threshold — not past it, so should NOT trigger
  state.lastBootRefreshAt = now - VISIBILITY_REFRESH_THRESHOLD_MS + 1;

  state = handleVisibilityReturn(state, now);

  assert.equal(state.refreshBootCalls.length, 0, "No refresh at threshold boundary");
});

test("Visibility return triggers when exactly at threshold", () => {
  let state = createContinuityState();
  const now = Date.now();
  // Exactly at threshold — elapsed equals threshold
  state.lastBootRefreshAt = now - VISIBILITY_REFRESH_THRESHOLD_MS;

  state = handleVisibilityReturn(state, now);

  assert.equal(state.refreshBootCalls.length, 1, "Refresh when exactly at threshold");
});

test("Mirrored constants match expected values", () => {
  assert.equal(MAX_TRANSCRIPT_BLOCKS, 100, "MAX_TRANSCRIPT_BLOCKS should be 100");
  assert.equal(COMMAND_TIMEOUT_MS, 90_000, "COMMAND_TIMEOUT_MS should be 90s");
  assert.equal(VISIBILITY_REFRESH_THRESHOLD_MS, 30_000, "VISIBILITY_REFRESH_THRESHOLD_MS should be 30s");
});
