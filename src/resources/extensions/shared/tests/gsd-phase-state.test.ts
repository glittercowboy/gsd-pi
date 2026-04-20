import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	activateGSD,
	deactivateGSD,
	setCurrentPhase,
	clearCurrentPhase,
	isGSDActive,
	getCurrentPhase,
} from "../gsd-phase-state.js";

describe("gsd-phase-state", () => {
	beforeEach(() => {
		deactivateGSD();
	});

	it("tracks active/inactive state", () => {
		assert.equal(isGSDActive(), false);
		activateGSD();
		assert.equal(isGSDActive(), true);
		deactivateGSD();
		assert.equal(isGSDActive(), false);
	});

	it("tracks the current phase when active", () => {
		activateGSD();
		assert.equal(getCurrentPhase(), null);
		setCurrentPhase("plan-milestone");
		assert.equal(getCurrentPhase(), "plan-milestone");
		clearCurrentPhase();
		assert.equal(getCurrentPhase(), null);
	});

	it("returns null phase when inactive even if phase was set", () => {
		activateGSD();
		setCurrentPhase("plan-milestone");
		deactivateGSD();
		assert.equal(getCurrentPhase(), null);
	});

	it("deactivation clears the current phase", () => {
		activateGSD();
		setCurrentPhase("execute-task");
		deactivateGSD();
		activateGSD();
		assert.equal(getCurrentPhase(), null);
	});
});
