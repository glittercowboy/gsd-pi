/**
 * Tests that cleanupQuickBranch is called on turn_end to squash-merge the
 * quick branch back to the original branch after the agent completes.
 *
 * Relates to #2668: /gsd quick does not squash-merge branch back after agent
 * completes task. cleanupQuickBranch() exists but is never invoked.
 *
 * The fix registers a turn_end hook in register-hooks.ts that calls
 * cleanupQuickBranch() after each turn, which is a no-op when no quick-task
 * state is pending.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Structural test: verify turn_end hook exists in register-hooks.ts ──────

describe("quick task turn_end cleanup (#2668)", () => {
  const hooksSource = readFileSync(
    join(import.meta.dirname, "..", "bootstrap", "register-hooks.ts"),
    "utf-8",
  );

  it("register-hooks.ts loads cleanupQuickBranch from quick.ts", () => {
    assert.ok(
      hooksSource.includes("cleanupQuickBranch"),
      "register-hooks.ts must reference cleanupQuickBranch",
    );

    // Verify it is loaded from quick.ts (static or lazy), not just mentioned in a comment.
    const importMatch =
      hooksSource.match(/import\s*\{[^}]*cleanupQuickBranch[^}]*\}\s*from\s*["'][^"']*quick/) ||
      hooksSource.match(/const\s+\{\s*cleanupQuickBranch\s*\}\s*=\s*await\s+import\(["'][^"']*quick\.js["']\)/);
    assert.ok(
      importMatch,
      "cleanupQuickBranch must be loaded from quick module",
    );
  });

  it("registers a turn_end handler that calls cleanupQuickBranch", () => {
    // Find the turn_end registration
    const turnEndMatch = hooksSource.match(
      /pi\.on\(\s*["']turn_end["']/,
    );
    assert.ok(
      turnEndMatch,
      "register-hooks.ts must register a turn_end handler",
    );

    // Extract the turn_end handler body — find everything from the pi.on("turn_end"
    // to the matching closing });
    const turnEndIdx = hooksSource.indexOf(turnEndMatch[0]);
    assert.ok(turnEndIdx !== -1);

    // Get the rest of the source from that point
    const rest = hooksSource.slice(turnEndIdx);

    // The handler must call cleanupQuickBranch
    // Look for cleanupQuickBranch within the first handler body (up to first `});`)
    const handlerEnd = rest.indexOf("});");
    assert.ok(handlerEnd !== -1, "turn_end handler has a closing });");

    const handlerBody = rest.slice(0, handlerEnd);
    assert.ok(
      handlerBody.includes("cleanupQuickBranch"),
      "turn_end handler must call cleanupQuickBranch",
    );
  });

  it("turn_end handler calls cleanupQuickBranch without arguments (uses cwd default)", () => {
    // cleanupQuickBranch(basePath = process.cwd()) — calling without args is correct
    // because the handler runs in the same process where handleQuick set up cwd
    const turnEndIdx = hooksSource.indexOf('pi.on("turn_end"') !== -1
      ? hooksSource.indexOf('pi.on("turn_end"')
      : hooksSource.indexOf("pi.on('turn_end'");
    assert.ok(turnEndIdx !== -1);

    const rest = hooksSource.slice(turnEndIdx);
    const handlerEnd = rest.indexOf("});");
    const handlerBody = rest.slice(0, handlerEnd);

    // Should call cleanupQuickBranch() — either bare or with no-arg form
    assert.ok(
      handlerBody.includes("cleanupQuickBranch("),
      "turn_end handler invokes cleanupQuickBranch()",
    );
  });
});
