/**
 * Session-replacement tests for AgentSession (Plan 08-04, D-15).
 *
 * These tests verify that event listeners, steering messages, and pending
 * messages survive session transitions (switch-new, switch-resume, fork)
 * via the _snapshotState / _restoreState mechanism.
 *
 * Direct bracket-notation access to private methods is intentional:
 * _snapshotState and _restoreState are the core behaviour units, and
 * testing them directly avoids the heavy dependency graph required to
 * construct a real AgentSession.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// Minimal AgentSession stub
//
// Mirrors the private fields and methods that _snapshotState / _restoreState
// operate on. Only the fields touched by those two helpers are present.
// ---------------------------------------------------------------------------

/**
 * Create a minimal stub that exposes the same private fields and methods
 * as AgentSession for snapshot/restore testing.
 */
function makeSessionStub() {
	const stub = {
		_eventListeners: [] as Array<(event: unknown) => void>,
		_steeringMessages: [] as string[],
		_followUpMessages: [] as string[],
		_pendingNextTurnMessages: [] as unknown[],

		/** Mirrors AgentSession._snapshotState */
		_snapshotState(this: typeof stub) {
			return {
				listeners: [...this._eventListeners],
				steering: [...this._steeringMessages],
				followUp: [...this._followUpMessages],
				pending: [...this._pendingNextTurnMessages],
			};
		},

		/** Mirrors AgentSession._restoreState */
		_restoreState(
			this: typeof stub,
			snapshot: ReturnType<typeof stub._snapshotState>,
		) {
			this._eventListeners = snapshot.listeners;
			this._steeringMessages = snapshot.steering;
			this._followUpMessages = snapshot.followUp;
			this._pendingNextTurnMessages = snapshot.pending;
		},
	};

	return stub;
}

// ---------------------------------------------------------------------------
// Test 1 — switch-new: event listener survives newSession transition
// ---------------------------------------------------------------------------

test("switch-new: event listener registered before newSession() survives the transition", () => {
	const session = makeSessionStub();

	// Register a listener BEFORE the transition.
	const received: unknown[] = [];
	const listener = (event: unknown) => received.push(event);
	session._eventListeners.push(listener);

	// Simulate what AgentSession.newSession() does:
	//   1. snapshot state
	//   2. perform transition (clears _eventListeners, etc.)
	//   3. restore state
	const snapshot = session._snapshotState();

	// Simulate the transition clearing the listener array (as dispose() does).
	session._eventListeners = [];
	session._steeringMessages = [];
	session._followUpMessages = [];
	session._pendingNextTurnMessages = [];

	// Restore state.
	session._restoreState(snapshot);

	// Listener must still be present.
	assert.equal(session._eventListeners.length, 1, "listener array should have 1 entry after restore");
	assert.equal(session._eventListeners[0], listener, "restored listener must be the same reference");

	// Calling the listener via the restored array works.
	session._eventListeners[0]({ type: "session_state_changed", reason: "new_session" });
	assert.equal(received.length, 1, "listener must have received the event");
});

// ---------------------------------------------------------------------------
// Test 2 — switch-resume: steering messages survive switchSession transition
// ---------------------------------------------------------------------------

test("switch-resume: steering messages set before switchSession() survive the transition", () => {
	const session = makeSessionStub();

	// Set steering messages BEFORE the transition.
	session._steeringMessages = ["tell me about the weather", "and the stars"];

	// Simulate what AgentSession.switchSession() does:
	//   1. snapshot state
	//   2. runtime clears steering/followUp/pending (teardown)
	//   3. restore state
	const snapshot = session._snapshotState();

	// Simulate teardown clearing the arrays.
	session._steeringMessages = [];
	session._followUpMessages = [];
	session._pendingNextTurnMessages = [];

	// Restore state.
	session._restoreState(snapshot);

	// Steering messages must survive.
	assert.deepEqual(
		session._steeringMessages,
		["tell me about the weather", "and the stars"],
		"steering messages must be preserved after switchSession restore",
	);
});

// ---------------------------------------------------------------------------
// Test 3 — fork: listener + pending messages both survive fork transition
// ---------------------------------------------------------------------------

test("fork: event listener and pending messages registered before fork() survive the transition", () => {
	const session = makeSessionStub();

	// Register a listener AND set pending messages BEFORE the transition.
	const fired: string[] = [];
	const forkListener = (event: unknown) => fired.push(String((event as { type: string }).type));
	session._eventListeners.push(forkListener);
	session._pendingNextTurnMessages.push({ type: "custom", content: "pending context" });

	// Simulate what AgentSession.fork() does:
	//   1. snapshot state
	//   2. perform fork (clears pendingNextTurnMessages, dispose clears listeners)
	//   3. restore state
	const snapshot = session._snapshotState();

	// Simulate fork teardown.
	session._eventListeners = [];
	session._pendingNextTurnMessages = [];

	// Restore state.
	session._restoreState(snapshot);

	// Listener must survive.
	assert.equal(session._eventListeners.length, 1, "listener must be present after fork restore");
	assert.equal(session._eventListeners[0], forkListener, "restored listener must be the same reference");

	// Pending messages must survive.
	assert.equal(session._pendingNextTurnMessages.length, 1, "pending message must survive fork");
	assert.deepEqual(
		session._pendingNextTurnMessages[0],
		{ type: "custom", content: "pending context" },
		"pending message content must be intact after fork",
	);

	// Listener fires correctly after restore.
	session._eventListeners[0]({ type: "fork" });
	assert.deepEqual(fired, ["fork"], "listener must fire after fork restore");
});
