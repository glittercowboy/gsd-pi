import test from "node:test";
import assert from "node:assert/strict";

import {
	startProcess,
	cleanupAll,
	cleanupSessionProcesses,
	processes,
} from "../resources/extensions/bg-shell/process-manager.ts";
import { waitForCondition } from "../resources/extensions/gsd/tests/test-helpers.ts";

function isPidAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Use a shell-native sleeper so the test exercises bg_shell's real spawn path
// without relying on platform-specific quoting for `node -e "..."`
const sleeperCommand = "sleep 30";

test("cleanupSessionProcesses reaps only session-scoped processes from the previous session", async (t) => {
	t.after(cleanupAll);
	const owned = startProcess({
		command: sleeperCommand,
		cwd: process.cwd(),
		ownerSessionFile: "session-a",
	});
	const persistent = startProcess({
		command: sleeperCommand,
		cwd: process.cwd(),
		ownerSessionFile: "session-a",
		persistAcrossSessions: true,
	});
	const foreign = startProcess({
		command: sleeperCommand,
		cwd: process.cwd(),
		ownerSessionFile: "session-b",
	});

	// Poll until all three spawned children are live — no magic sleeps.
	await waitForCondition(
		() =>
			isPidAlive(owned.proc.pid) &&
			isPidAlive(persistent.proc.pid) &&
			isPidAlive(foreign.proc.pid),
		{ timeoutMs: 5_000, description: "all three spawned children to be alive" },
	);

	const removed = await cleanupSessionProcesses("session-a", { graceMs: 200 });
	assert.deepEqual(removed.sort(), [owned.id], "only the session-scoped process should be reaped");

	// Poll until the reaped child has actually exited. Foreign + persistent stay
	// alive by contract — any point after cleanupSessionProcesses returned is a
	// valid observation window for them.
	await waitForCondition(() => !isPidAlive(owned.proc.pid), {
		timeoutMs: 5_000,
		description: "owned (session-a) process to exit after cleanup",
	});
	assert.equal(isPidAlive(persistent.proc.pid), true, "persistent process should survive cleanup");
	assert.equal(isPidAlive(foreign.proc.pid), true, "foreign process should survive cleanup");
	assert.equal(processes.get(owned.id)?.persistAcrossSessions, false);
	assert.equal(processes.get(persistent.id)?.persistAcrossSessions, true);
});
