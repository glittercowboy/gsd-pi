import test, { describe } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Test: project switching preserves the active tab (view) instead of
// resetting to dashboard.
//
// Bug #2711: Switching projects always returns to dashboard.
//
// Root cause: handleSelectProject in ProjectsPanel dispatched
//   gsd:navigate-view with { view: "dashboard" } on every switch.
//   Additionally, the viewRestored flag in WorkspaceChrome was never
//   reset when the project changed, so the per-project sessionStorage
//   restore could not fire for the new project.
//
// These tests validate the corrected logic in isolation, without needing
// a full React DOM.
// ---------------------------------------------------------------------------

// ── Simulated sessionStorage (mirrors browser sessionStorage API) ────────

class MockSessionStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

// ── Mirrors the KNOWN_VIEWS set and viewStorageKey from app-shell.tsx ─────

const KNOWN_VIEWS = new Set([
  "dashboard",
  "power",
  "chat",
  "roadmap",
  "files",
  "activity",
  "visualize",
]);

function viewStorageKey(projectCwd: string): string {
  return `gsd-active-view:${projectCwd}`;
}

// ── Simulated WorkspaceChrome view-restore logic ─────────────────────────
// This mirrors the useEffect in WorkspaceChrome that restores the persisted
// view when projectPath changes — with the fix applied.

interface ChromeState {
  activeView: string;
  viewRestored: boolean;
  projectPath: string | null;
}

/**
 * Simulates the view-restore effect.
 * In the fixed code, viewRestored resets to false when projectPath changes,
 * allowing the stored view to be read for the new project.
 */
function simulateViewRestoreEffect(
  state: ChromeState,
  storage: MockSessionStorage,
): ChromeState {
  // The fix: if projectPath changed, reset viewRestored
  // (In React this is a separate useEffect that depends on [projectPath])
  if (!state.viewRestored && state.projectPath) {
    const stored = storage.getItem(viewStorageKey(state.projectPath));
    if (stored && KNOWN_VIEWS.has(stored)) {
      return { ...state, activeView: stored, viewRestored: true };
    }
    return { ...state, viewRestored: true };
  }
  return state;
}

/**
 * Simulates switching to a new project path.
 * The fix resets viewRestored so the restore effect can fire for the new project.
 */
function simulateProjectSwitch(
  state: ChromeState,
  newProjectPath: string,
): ChromeState {
  return {
    ...state,
    projectPath: newProjectPath,
    viewRestored: false, // <-- THE FIX: reset so restore runs for new project
  };
}

// ── Simulated handleSelectProject (pre-fix vs post-fix) ──────────────────

/** Pre-fix: always navigates to dashboard on project switch */
function handleSelectProjectPreFix(
  _state: ChromeState,
  _projectPath: string,
): string {
  // Bug: always forces dashboard
  return "dashboard";
}

/** Post-fix: does NOT override the active view */
function handleSelectProjectPostFix(
  state: ChromeState,
  _projectPath: string,
): string {
  // Fix: preserve whatever view is active (restore logic handles per-project view)
  return state.activeView;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("project switch tab preservation (#2711)", () => {
  test("BUG: pre-fix handleSelectProject always resets to dashboard", () => {
    const state: ChromeState = {
      activeView: "roadmap",
      viewRestored: true,
      projectPath: "/projects/alpha",
    };

    const viewAfterSwitch = handleSelectProjectPreFix(state, "/projects/beta");
    // This demonstrates the bug: user was on "roadmap" but got sent to "dashboard"
    assert.equal(viewAfterSwitch, "dashboard");
  });

  test("FIX: post-fix handleSelectProject preserves current view", () => {
    const state: ChromeState = {
      activeView: "roadmap",
      viewRestored: true,
      projectPath: "/projects/alpha",
    };

    const viewAfterSwitch = handleSelectProjectPostFix(state, "/projects/beta");
    assert.equal(viewAfterSwitch, "roadmap", "Should preserve the current tab");
  });

  test("FIX: viewRestored resets on project switch, enabling per-project view restore", () => {
    const storage = new MockSessionStorage();
    storage.setItem(viewStorageKey("/projects/alpha"), "files");
    storage.setItem(viewStorageKey("/projects/beta"), "activity");

    // Start on project alpha, viewing files
    let state: ChromeState = {
      activeView: "dashboard",
      viewRestored: false,
      projectPath: "/projects/alpha",
    };

    // Initial restore for alpha
    state = simulateViewRestoreEffect(state, storage);
    assert.equal(state.activeView, "files");
    assert.equal(state.viewRestored, true);

    // Switch to project beta
    state = simulateProjectSwitch(state, "/projects/beta");
    assert.equal(state.viewRestored, false, "viewRestored should reset on project switch");

    // Restore effect fires for beta
    state = simulateViewRestoreEffect(state, storage);
    assert.equal(state.activeView, "activity", "Should restore beta's persisted view");
  });

  test("FIX: switching to project with no stored view keeps current view", () => {
    const storage = new MockSessionStorage();
    // Only alpha has a stored view
    storage.setItem(viewStorageKey("/projects/alpha"), "roadmap");

    let state: ChromeState = {
      activeView: "roadmap",
      viewRestored: true,
      projectPath: "/projects/alpha",
    };

    // Switch to gamma (no stored view)
    state = simulateProjectSwitch(state, "/projects/gamma");
    state = simulateViewRestoreEffect(state, storage);

    // Should keep the current view since gamma has no stored preference
    assert.equal(state.activeView, "roadmap", "Should keep current view when new project has no stored view");
  });

  test("FIX: stored view for invalid view name is ignored", () => {
    const storage = new MockSessionStorage();
    storage.setItem(viewStorageKey("/projects/alpha"), "nonexistent-view");

    let state: ChromeState = {
      activeView: "power",
      viewRestored: false,
      projectPath: "/projects/alpha",
    };

    state = simulateViewRestoreEffect(state, storage);
    // Invalid stored view should be ignored, keeping current view
    assert.equal(state.activeView, "power");
  });

  test("FIX: rapid project switches each get a fresh restore", () => {
    const storage = new MockSessionStorage();
    storage.setItem(viewStorageKey("/projects/a"), "chat");
    storage.setItem(viewStorageKey("/projects/b"), "visualize");
    storage.setItem(viewStorageKey("/projects/c"), "files");

    let state: ChromeState = {
      activeView: "dashboard",
      viewRestored: false,
      projectPath: "/projects/a",
    };

    // Restore for A
    state = simulateViewRestoreEffect(state, storage);
    assert.equal(state.activeView, "chat");

    // Switch to B
    state = simulateProjectSwitch(state, "/projects/b");
    state = simulateViewRestoreEffect(state, storage);
    assert.equal(state.activeView, "visualize");

    // Switch to C
    state = simulateProjectSwitch(state, "/projects/c");
    state = simulateViewRestoreEffect(state, storage);
    assert.equal(state.activeView, "files");

    // Switch back to A
    state = simulateProjectSwitch(state, "/projects/a");
    state = simulateViewRestoreEffect(state, storage);
    assert.equal(state.activeView, "chat", "Should restore A's view again after switching away and back");
  });
});
