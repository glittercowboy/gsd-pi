// Behavioural contract for GSD extension bootstrap isolation (#4168, #4172).
//
// Guarantee: the `/gsd` slash command must be registered on pi even if the
// full bootstrap (shortcuts, tools, hooks, ecosystem) throws during import or
// execution. Prior regressions: a Windows-specific failure in register-
// shortcuts.ts silently prevented /gsd from being registered at all because
// registerGSDCommand was called inside the same try that loaded shortcuts.
//
// These tests exercise the real default export of index.ts (which calls
// registerGSDCommand via dynamic import, then attempts the full bootstrap)
// with a minimal mock ExtensionAPI and verify the observable behaviour
// directly: /gsd is registered in both the happy path and the degraded path.
//
// Anti-regression proof (documented in commit):
//   neuter index.ts to register /gsd inside the same try{} as
//   register-extension → the degraded-path test fails (no /gsd command
//   registered when register-extension throws). Restore → passes.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import registerExtension from "../index.ts";

type RegisterFn = (name: string, def: unknown) => void;

function makePi(overrides: Partial<Record<string, unknown>> = {}) {
  const registered: Array<[string, unknown]> = [];
  const registerCommand: RegisterFn = (name, def) => {
    registered.push([name, def]);
  };
  const events = {
    on: () => {},
    off: () => {},
    emit: () => {},
  };
  const pi = {
    registerCommand,
    registerTool: () => {},
    registerHook: () => {},
    registerShortcut: () => {},
    events,
    ...overrides,
  };
  return { pi, registered };
}

describe("extension bootstrap isolation (#4168, #4172)", () => {
  test("happy path: /gsd command is registered", async () => {
    const { pi, registered } = makePi();
    await registerExtension(pi as any);
    const names = registered.map(([n]) => n);
    assert.ok(
      names.includes("gsd"),
      `expected 'gsd' in registered commands, got ${JSON.stringify(names)}`,
    );
  });

  test("degraded path: /gsd still registered when registerCommand throws for non-core commands", async () => {
    // Simulate the Windows-style failure: pi.registerCommand throws for a
    // specific non-core command ('kill' is a simple target registered by
    // the full bootstrap) — the full bootstrap must fail but /gsd must
    // already be registered before the failure occurs.
    const registered: Array<[string, unknown]> = [];
    const pi = {
      registerCommand: (name: string, def: unknown) => {
        if (name !== "gsd" && name !== "worktree" && name !== "exit") {
          // Let /gsd, /worktree, /exit succeed (they precede the non-core
          // loop); throw when the first non-core registration fires.
        }
        if (name === "kill") throw new Error("simulated windows failure");
        registered.push([name, def]);
      },
      registerTool: () => {},
      registerHook: () => {},
      registerShortcut: () => {},
      events: { on: () => {}, off: () => {}, emit: () => {} },
    };

    // registerExtension must not throw — the outer try/catch in index.ts
    // swallows bootstrap failures after /gsd is already registered.
    await registerExtension(pi as any);

    const names = registered.map(([n]) => n);
    assert.ok(
      names.includes("gsd"),
      "expected 'gsd' to be registered even when a later command registration throws",
    );
  });

  test("degraded path: /gsd registered BEFORE any non-core command", async () => {
    // Ordering guard: the first registerCommand call must be for 'gsd',
    // because index.ts awaits registerGSDCommand(pi) before importing
    // register-extension. Regression scenario: if a future refactor moves
    // registerGSDCommand into the try block or after other registrations,
    // a failure in those earlier registrations would take /gsd down too.
    const calls: string[] = [];
    const pi = {
      registerCommand: (name: string) => {
        calls.push(name);
      },
      registerTool: () => {},
      registerHook: () => {},
      registerShortcut: () => {},
      events: { on: () => {}, off: () => {}, emit: () => {} },
    };
    await registerExtension(pi as any);
    assert.ok(calls.length > 0, "expected at least one registerCommand call");
    assert.equal(
      calls[0],
      "gsd",
      `expected 'gsd' to be the first command registered, got ${JSON.stringify(calls)}`,
    );
  });
});

// Behavioural contract for registerGsdExtension itself: each non-core
// registration is wrapped in its own try/catch so one failure does not
// prevent siblings from loading.

import { registerGsdExtension } from "../bootstrap/register-extension.ts";

describe("registerGsdExtension defensive registration", () => {
  test("a failing shortcut registration does not prevent kill command registration", async () => {
    // `shortcuts` is registered via a non-critical slot that is wrapped in
    // its own try/catch. `kill` is registered before the non-critical loop
    // as a critical command. Simulate: registerShortcut throws. Expect:
    // 'kill' is still registered, registerGsdExtension does not throw.
    const registered: string[] = [];
    const pi = {
      registerCommand: (name: string) => {
        registered.push(name);
      },
      registerTool: () => {},
      registerHook: () => {},
      registerShortcut: () => {
        throw new Error("simulated platform-specific shortcut failure");
      },
      events: { on: () => {}, off: () => {}, emit: () => {} },
    };
    assert.doesNotThrow(() => registerGsdExtension(pi as any));
    assert.ok(
      registered.includes("kill"),
      `expected 'kill' to be registered despite shortcut failure, got ${JSON.stringify(registered)}`,
    );
  });

  test("does NOT register /gsd (caller's responsibility, avoids double-registration)", () => {
    const registered: string[] = [];
    const pi = {
      registerCommand: (name: string) => {
        registered.push(name);
      },
      registerTool: () => {},
      registerHook: () => {},
      registerShortcut: () => {},
      events: { on: () => {}, off: () => {}, emit: () => {} },
    };
    registerGsdExtension(pi as any);
    assert.ok(
      !registered.includes("gsd"),
      `registerGsdExtension must NOT register 'gsd' (it is registered separately by index.ts), got ${JSON.stringify(registered)}`,
    );
  });
});
