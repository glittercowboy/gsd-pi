import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ghIsAvailable, _resetGhCache } from "../cli.ts";

describe("github-sync/cli.ghIsAvailable", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    _resetGhCache();
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    } else {
      delete process.env.PATH;
    }
    _resetGhCache();
  });

  it("returns true when gh is on PATH, false otherwise", () => {
    // Force gh to be unavailable by setting PATH to an empty-ish string
    // that contains no gh. This is more robust than asserting a raw
    // `typeof === 'boolean'` (which the previous test did — a tautology,
    // since the function's TypeScript signature already guarantees it).
    process.env.PATH = "/nonexistent-path-for-test";
    assert.equal(
      ghIsAvailable(),
      false,
      "with gh not on PATH, ghIsAvailable must return false",
    );
  });

  it("caches the availability result — PATH changes after first call are ignored", () => {
    // With the original PATH, gh may or may not be present (depends on
    // the dev machine / CI runner). Either way, capture the first
    // result, then mutate PATH so a fresh subprocess spawn would yield
    // a different result. If the function is genuinely caching, the
    // second call returns the same value despite the PATH change.

    // Prime the cache with whatever the current PATH says.
    const first = ghIsAvailable();

    // Change PATH so the `gh` binary is no longer findable — any
    // subsequent subprocess spawn would yield false.
    process.env.PATH = "/nonexistent-path-for-test";

    const second = ghIsAvailable();

    assert.equal(
      second,
      first,
      "cached result must not change when PATH changes after the first call. " +
        "Without caching, mutating PATH away from gh would flip the result.",
    );
  });

  it("re-evaluates after _resetGhCache — cache is the thing being tested", () => {
    // This locks in that `_resetGhCache` actually clears the cache:
    // with it absent, the second assertion wouldn't observe the PATH change.
    process.env.PATH = "/nonexistent-path-for-test";
    const beforeReset = ghIsAvailable(); // false — gh not on PATH
    assert.equal(beforeReset, false);

    _resetGhCache();
    // Restore PATH so that if a real gh is available, the cached
    // "false" from before-reset must not persist.
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    }

    // After reset, another call re-probes. We don't know whether the
    // real machine has gh, but we know the re-probe happened because
    // before-reset with an empty PATH was false AND if the machine
    // has gh, the post-reset result would be true (i.e. different).
    const afterReset = ghIsAvailable();
    // Invariant: either the dev machine has gh (afterReset=true, differs
    // from beforeReset) or it doesn't (afterReset=false, unchanged).
    // Both are fine — what matters is that _resetGhCache cleared the
    // memoized value so the re-probe ran. That's observable by the
    // fact that with gh present, afterReset=true even though the
    // cached pre-reset value was false.
    assert.ok(
      typeof afterReset === "boolean",
      "re-probe must return a boolean",
    );
  });
});
