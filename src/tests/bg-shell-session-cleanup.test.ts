import test from "node:test";
import assert from "node:assert/strict";

import {
	startProcess,
	cleanupAll,
	cleanupSessionProcesses,
	processes,
} from "../resources/extensions/bg-shell/process-manager.ts";

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

	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(isPidAlive(owned.proc.pid), true, "owned process should be alive before cleanup");
	assert.equal(isPidAlive(persistent.proc.pid), true, "persistent process should be alive before cleanup");
	assert.equal(isPidAlive(foreign.proc.pid), true, "foreign process should be alive before cleanup");

	const removed = await cleanupSessionProcesses("session-a", { graceMs: 200 });
	assert.deepEqual(removed.sort(), [owned.id], "only the session-scoped process should be reaped");

	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(isPidAlive(owned.proc.pid), false, "owned process should be terminated");
	assert.equal(isPidAlive(persistent.proc.pid), true, "persistent process should survive cleanup");
	assert.equal(isPidAlive(foreign.proc.pid), true, "foreign process should survive cleanup");
	assert.equal(processes.get(owned.id)?.persistAcrossSessions, false);
	assert.equal(processes.get(persistent.id)?.persistAcrossSessions, true);
});
