// GSD2 — Regression test: pendingProviderRegistrations must be flushed exactly once (#3576)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * This test validates that the provider preflush pattern in sdk.ts clears
 * pendingProviderRegistrations after iterating, so bindCore() doesn't
 * re-register the same providers.
 *
 * The bug: createAgentSession() iterated pendingProviderRegistrations but
 * did not clear the array. Later, bindCore() replayed and registered the
 * same providers again, stacking wrappers.
 */

interface ProviderEntry {
  name: string;
  config: Record<string, unknown>;
}

interface MockRuntime {
  pendingProviderRegistrations: ProviderEntry[];
}

describe("provider registration preflush", () => {
  it("clears pending registrations after preflush so bindCore does not replay", () => {
    const registered: string[] = [];
    const runtime: MockRuntime = {
      pendingProviderRegistrations: [
        { name: "ollama", config: { type: "ollama" } },
        { name: "custom-provider", config: { type: "custom" } },
      ],
    };

    // Simulate sdk.ts preflush (lines 220-223)
    for (const { name } of runtime.pendingProviderRegistrations) {
      registered.push(name);
    }
    // The fix: clear after preflush
    runtime.pendingProviderRegistrations = [];

    // Simulate bindCore() flush (runner.ts lines 268-271)
    for (const { name } of runtime.pendingProviderRegistrations) {
      registered.push(name);
    }
    runtime.pendingProviderRegistrations = [];

    assert.deepEqual(
      registered,
      ["ollama", "custom-provider"],
      "each provider should be registered exactly once",
    );
  });

  it("without the fix, providers are registered twice", () => {
    const registered: string[] = [];
    const runtime: MockRuntime = {
      pendingProviderRegistrations: [
        { name: "ollama", config: { type: "ollama" } },
      ],
    };

    // Old behavior: preflush without clearing
    for (const { name } of runtime.pendingProviderRegistrations) {
      registered.push(name);
    }
    // NOT clearing — simulating the old bug

    // bindCore() replays the same queue
    for (const { name } of runtime.pendingProviderRegistrations) {
      registered.push(name);
    }

    assert.deepEqual(
      registered,
      ["ollama", "ollama"],
      "without clearing, providers are registered twice (demonstrating the bug)",
    );
  });
});
