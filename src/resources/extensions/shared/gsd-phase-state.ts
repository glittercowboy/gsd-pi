/**
 * GSD Phase State — cross-extension coordination
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 *
 * Lightweight module-level state that GSD auto-mode writes to and the
 * subagent tool reads from. Both extensions run in the same process so
 * a module variable is sufficient — no file I/O needed.
 */

let _active = false;
let _currentPhase: string | null = null;

/** Mark GSD auto-mode as active. */
export function activateGSD(): void {
	_active = true;
}

/** Mark GSD auto-mode as inactive and clear the current phase. */
export function deactivateGSD(): void {
	_active = false;
	_currentPhase = null;
}

/** Set the currently dispatched GSD phase (e.g. "plan-milestone"). */
export function setCurrentPhase(phase: string): void {
	_currentPhase = phase;
}

/** Clear the current phase (unit completed or aborted). */
export function clearCurrentPhase(): void {
	_currentPhase = null;
}

/** Returns true if GSD auto-mode is currently active. */
export function isGSDActive(): boolean {
	return _active;
}

/** Returns the current GSD phase, or null if none is active. */
export function getCurrentPhase(): string | null {
	return _active ? _currentPhase : null;
}
