/**
 * Regression tests for CPU/memory leak fixes in long-running sessions.
 *
 * Structural tests that verify the fix patterns are present in source —
 * NOT runtime integration tests. This approach is chosen because:
 * - The leaks manifest over hours of real usage, not in unit test timescales
 * - The fixes are defensive guards (caps, disposal, handler cleanup)
 * - Structural verification catches regressions when code is refactored
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────

function readSource(relativePath: string): string {
  return readFileSync(join(import.meta.dirname, "..", "..", relativePath), "utf-8");
}

function extractFunctionBody(src: string, name: string): string {
  const fnStart = src.indexOf(name);
  assert.ok(fnStart > -1, `${name} must exist in source`);
  let depth = 0;
  let fnEnd = -1;
  for (let i = src.indexOf("{", fnStart); i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}") depth--;
    if (depth === 0) { fnEnd = i; break; }
  }
  return src.slice(fnStart, fnEnd + 1);
}

// ── TUI render-skip ─────────────────────────────────────────────────

test("Container caches render output for stable-reference comparison", () => {
  const src = readSource("packages/pi-tui/src/tui.ts");
  assert.ok(
    src.includes("_prevRender"),
    "Container must have _prevRender cache for render-skip optimization",
  );
});

test("TUI skips post-processing when component output is unchanged", () => {
  const src = readSource("packages/pi-tui/src/tui.ts");
  assert.ok(
    src.includes("_lastRenderedComponents"),
    "TUI must track _lastRenderedComponents for reference-equality skip",
  );
});

// ── Loader frame isolation ──────────────────────────────────────────

test("Loader does not call setText on every spinner tick", () => {
  const src = readSource("packages/pi-tui/src/components/loader.ts");
  // The old pattern was: setText(`${frame} ${message}`) inside the interval
  // The new pattern: only update Text when message changes, prepend frame in render()
  assert.ok(
    src.includes("_lastMessage"),
    "Loader must track _lastMessage to avoid setText on every tick",
  );
  // Verify the interval does NOT call setText or updateDisplay
  const intervalMatch = src.match(/setInterval\s*\(\s*\(\)\s*=>\s*\{([^}]+)\}/s);
  assert.ok(intervalMatch, "Loader must have a setInterval callback");
  const intervalBody = intervalMatch[1];
  assert.ok(
    !intervalBody.includes("setText") && !intervalBody.includes("updateDisplay"),
    "Loader interval must NOT call setText or updateDisplay — " +
    "frame rotation should only trigger requestRender()",
  );
});

// ── Text cache guard ────────────────────────────────────────────────

test("Text.setText returns early when text is unchanged", () => {
  const src = readSource("packages/pi-tui/src/components/text.ts");
  const setTextBody = extractFunctionBody(src, "setText(");
  assert.ok(
    setTextBody.includes("if (this.text === text) return"),
    "setText must early-return when text is identical to prevent cache invalidation",
  );
});

// ── Chat component cap ──────────────────────────────────────────────

test("InteractiveMode caps rendered chat components", () => {
  const src = readSource("packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts");
  assert.ok(
    src.includes("MAX_CHAT_COMPONENTS"),
    "InteractiveMode must define MAX_CHAT_COMPONENTS to prevent unbounded growth",
  );
  assert.ok(
    src.includes("trimChatHistory"),
    "InteractiveMode must call trimChatHistory to enforce the cap",
  );
});

// ── ToolExecution dispose ───────────────────────────────────────────

test("ToolExecutionComponent has dispose() to clear heavy references", () => {
  const src = readSource("packages/pi-coding-agent/src/modes/interactive/components/tool-execution.ts");
  assert.ok(
    src.includes("dispose()"),
    "ToolExecutionComponent must have dispose() for GC of image maps, diff previews, etc.",
  );
});

// ── Orphan process prevention ───────────────────────────────────────

test("InteractiveMode kills descendant processes on shutdown", () => {
  const src = readSource("packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts");
  assert.ok(
    src.includes("listDescendants"),
    "Shutdown must use listDescendants to find orphan child processes",
  );
  assert.ok(
    src.includes("SIGTERM") && src.includes("SIGKILL"),
    "Shutdown must send SIGTERM then SIGKILL to descendants",
  );
});

// ── Signal handler accumulation ─────────────────────────────────────

test("bg-shell removes signal handlers on session_shutdown", () => {
  const src = readSource("src/resources/extensions/bg-shell/bg-shell-lifecycle.ts");
  assert.ok(
    src.includes('process.off("SIGTERM"') || src.includes("process.off('SIGTERM'"),
    "session_shutdown must remove SIGTERM handler to prevent accumulation",
  );
  assert.ok(
    src.includes('process.off("SIGINT"') || src.includes("process.off('SIGINT'"),
    "session_shutdown must remove SIGINT handler to prevent accumulation",
  );
});

// ── Alert queue cap ─────────────────────────────────────────────────

test("pendingAlerts has a maximum size cap", () => {
  const src = readSource("src/resources/extensions/bg-shell/process-manager.ts");
  assert.ok(
    src.includes("MAX_PENDING_ALERTS"),
    "process-manager must cap pendingAlerts to prevent unbounded growth",
  );
});
