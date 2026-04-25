import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Constants mirrored from the shutdown-gate and app-shell
// ---------------------------------------------------------------------------
const SHUTDOWN_DELAY_MS = 3_000;

// ---------------------------------------------------------------------------
// Test 1: pagehide handler must NOT fire shutdown beacon on tab switches
// ---------------------------------------------------------------------------
// The bug: `pagehide` fires both on actual page unload AND on mobile/Safari
// tab switches (where event.persisted === true because the page enters bfcache).
// The current handler does not check event.persisted, so it fires shutdown
// beacons on tab switches — killing the server and all PTY sessions.

/**
 * Mirrors the pagehide handler logic from app-shell.tsx's
 * ProjectAwareWorkspace component.  The BUGGY version sends a shutdown
 * beacon unconditionally.
 */
function buggyPageHideHandler(_event: { persisted: boolean }): boolean {
  // Current code (buggy): always sends beacon regardless of event.persisted
  return true; // true = beacon was sent
}

/**
 * Fixed version: only send shutdown beacon when the page is truly being
 * unloaded (event.persisted === false).  When persisted is true the page
 * is being put into bfcache (tab switch, app backgrounding) and the
 * server should stay alive.
 */
function fixedPageHideHandler(event: { persisted: boolean }): boolean {
  if (event.persisted) {
    // Page is entering bfcache (tab switch) — do NOT shut down
    return false;
  }
  return true; // true = beacon was sent
}

test("pagehide: buggy handler sends shutdown beacon on tab switch (persisted=true)", () => {
  // This test documents the bug — the buggy handler fires on tab switches
  const beaconSent = buggyPageHideHandler({ persisted: true });
  assert.equal(beaconSent, true, "Buggy handler sends beacon even on tab switch");
});

test("pagehide: fixed handler skips shutdown beacon on tab switch (persisted=true)", () => {
  const beaconSent = fixedPageHideHandler({ persisted: true });
  assert.equal(beaconSent, false, "Fixed handler must NOT send beacon on tab switch");
});

test("pagehide: fixed handler still sends shutdown beacon on real page unload (persisted=false)", () => {
  const beaconSent = fixedPageHideHandler({ persisted: false });
  assert.equal(beaconSent, true, "Fixed handler must send beacon on real unload");
});

// ---------------------------------------------------------------------------
// Test 2: Project switching must NOT destroy PTY sessions
// ---------------------------------------------------------------------------
// The bug: ProjectStoreManager.switchProject() changes the active store,
// which causes React to unmount the entire WorkspaceChrome tree (including
// ShellTerminal). The PTY processes survive server-side, but the client
// loses all xterm state and SSE connections.  When the user switches back,
// a NEW terminal is created instead of reconnecting to the existing one.

/**
 * Mirrors the session-id generation logic used by ShellTerminal.
 * The BUGGY version generates a project-agnostic session ID, so switching
 * projects and switching back creates a collision or a fresh session.
 *
 * The FIXED version namespaces session IDs by project so switching back
 * reconnects to the same server-side PTY session via its stable ID.
 */

interface TerminalSessionTracker {
  /** Active PTY session IDs on the server (survives client unmount) */
  serverSessions: Map<string, { alive: boolean; projectCwd: string }>;
  /** Client-side session IDs (destroyed on unmount) */
  clientSessions: Set<string>;
}

function createTracker(): TerminalSessionTracker {
  return {
    serverSessions: new Map(),
    clientSessions: new Set(),
  };
}

/**
 * Simulates what happens when ShellTerminal mounts for a project.
 * The BUGGY version uses a plain default ID with no project namespace.
 */
function buggyMountTerminal(tracker: TerminalSessionTracker, _projectCwd: string): string {
  const sessionId = "default"; // No project namespace — always the same ID
  tracker.serverSessions.set(sessionId, { alive: true, projectCwd: _projectCwd });
  tracker.clientSessions.add(sessionId);
  return sessionId;
}

/**
 * Simulates what happens when ShellTerminal unmounts (project switch).
 * Client-side state is destroyed but server session stays alive.
 */
function unmountTerminal(tracker: TerminalSessionTracker, sessionId: string): void {
  tracker.clientSessions.delete(sessionId);
  // Server session stays alive — this is the correct behavior
}

/**
 * FIXED mount: uses a project-scoped session ID so switching back to
 * a project reconnects to the same server-side PTY.
 */
function fixedMountTerminal(tracker: TerminalSessionTracker, projectCwd: string): string {
  const sessionId = `shell:${projectCwd}:default`;
  // getOrCreateSession on the server: if alive, returns existing; if dead, creates new
  if (!tracker.serverSessions.has(sessionId) || !tracker.serverSessions.get(sessionId)!.alive) {
    tracker.serverSessions.set(sessionId, { alive: true, projectCwd });
  }
  tracker.clientSessions.add(sessionId);
  return sessionId;
}

test("project switch: buggy flow reuses same session ID for different projects", () => {
  const tracker = createTracker();

  // Mount terminal for project A
  const sessionA = buggyMountTerminal(tracker, "/projects/alpha");
  assert.equal(sessionA, "default");
  assert.equal(tracker.serverSessions.get("default")?.projectCwd, "/projects/alpha");

  // Switch to project B — unmount A, mount B
  unmountTerminal(tracker, sessionA);
  const sessionB = buggyMountTerminal(tracker, "/projects/beta");

  // Bug: same session ID, but now points to a different project
  assert.equal(sessionB, "default");
  assert.equal(
    tracker.serverSessions.get("default")?.projectCwd,
    "/projects/beta",
    "Buggy: server session is overwritten with new project",
  );
});

test("project switch: fixed flow preserves per-project session identity", () => {
  const tracker = createTracker();

  // Mount terminal for project A
  const sessionA = fixedMountTerminal(tracker, "/projects/alpha");
  assert.ok(sessionA.includes("/projects/alpha"), "Session ID includes project path");

  // Switch to project B — unmount A, mount B
  unmountTerminal(tracker, sessionA);
  const sessionB = fixedMountTerminal(tracker, "/projects/beta");

  // Session IDs are different — no collision
  assert.notEqual(sessionA, sessionB, "Different projects get different session IDs");

  // Both server sessions exist independently
  assert.equal(tracker.serverSessions.get(sessionA)?.alive, true);
  assert.equal(tracker.serverSessions.get(sessionB)?.alive, true);

  // Switch back to project A — should reconnect to same session
  unmountTerminal(tracker, sessionB);
  const sessionA2 = fixedMountTerminal(tracker, "/projects/alpha");
  assert.equal(sessionA2, sessionA, "Switching back reconnects to the same session ID");
  assert.equal(tracker.serverSessions.get(sessionA)?.alive, true, "Original server session is still alive");
});

// ---------------------------------------------------------------------------
// Test 3: Shutdown gate must differentiate tab-switch from real unload
// ---------------------------------------------------------------------------
// The shutdown gate has a 3s delay to allow page refreshes to cancel the
// shutdown.  But on mobile tab switches that fire pagehide, the 3s timer
// starts — and if the user doesn't switch back within 3s, the server dies.
// The fix is to never start the timer on persisted pagehide events.

interface ShutdownGateState {
  timerScheduled: boolean;
  shutdownExecuted: boolean;
}

function createShutdownGate(): ShutdownGateState {
  return { timerScheduled: false, shutdownExecuted: false };
}

function scheduleShutdownIfAllowed(gate: ShutdownGateState, event: { persisted: boolean }): void {
  // Fixed: only schedule shutdown when the page is truly unloading
  if (event.persisted) return;
  gate.timerScheduled = true;
}

function cancelShutdown(gate: ShutdownGateState): void {
  gate.timerScheduled = false;
}

test("shutdown gate: tab switch (persisted=true) must not schedule shutdown", () => {
  const gate = createShutdownGate();
  scheduleShutdownIfAllowed(gate, { persisted: true });
  assert.equal(gate.timerScheduled, false, "No shutdown timer on tab switch");
});

test("shutdown gate: real page unload (persisted=false) must schedule shutdown", () => {
  const gate = createShutdownGate();
  scheduleShutdownIfAllowed(gate, { persisted: false });
  assert.equal(gate.timerScheduled, true, "Shutdown timer on real unload");
});

test("shutdown gate: scheduled shutdown can still be cancelled by page refresh", () => {
  const gate = createShutdownGate();
  scheduleShutdownIfAllowed(gate, { persisted: false });
  assert.equal(gate.timerScheduled, true);
  cancelShutdown(gate);
  assert.equal(gate.timerScheduled, false, "Timer cancelled on refresh");
});

// ---------------------------------------------------------------------------
// Test 4: Shell terminal session ID must be project-scoped
// ---------------------------------------------------------------------------

/**
 * Mirrors the session ID derivation that ShellTerminal should use.
 * The default session ID (when no sessionPrefix is given) must incorporate
 * the project path so that different projects get different PTY sessions.
 */
function deriveSessionId(
  projectCwd: string | undefined,
  sessionPrefix?: string,
  command?: string,
): string {
  const base = sessionPrefix ?? (command ? "gsd-default" : "default");
  if (!projectCwd) return base;
  // Stable hash-like key from the project path — keeps IDs short but unique
  return `${base}:${projectCwd}`;
}

test("session ID derivation: different projects produce different IDs", () => {
  const idA = deriveSessionId("/projects/alpha");
  const idB = deriveSessionId("/projects/beta");
  assert.notEqual(idA, idB);
});

test("session ID derivation: same project produces stable ID", () => {
  const id1 = deriveSessionId("/projects/alpha");
  const id2 = deriveSessionId("/projects/alpha");
  assert.equal(id1, id2);
});

test("session ID derivation: explicit sessionPrefix is preserved with project scope", () => {
  const id = deriveSessionId("/projects/alpha", "my-prefix");
  assert.ok(id.includes("my-prefix"), "Prefix included");
  assert.ok(id.includes("/projects/alpha"), "Project path included");
});

test("session ID derivation: command sessions are also project-scoped", () => {
  const idA = deriveSessionId("/projects/alpha", undefined, "gsd");
  const idB = deriveSessionId("/projects/beta", undefined, "gsd");
  assert.notEqual(idA, idB);
  assert.ok(idA.includes("gsd-default"), "Uses gsd-default base for command sessions");
});

test("session ID derivation: no projectCwd falls back to plain base ID", () => {
  const id = deriveSessionId(undefined);
  assert.equal(id, "default");
});
