// GSD-2 — Verify /gsd help menu covers all registered commands
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { TOP_LEVEL_SUBCOMMANDS } from "../commands/catalog.ts";

/**
 * Extracts command names from the showHelp() lines array.
 * Each help line follows the pattern: "  /gsd <cmd>  ..."
 */
function extractHelpCommands(lines: string[]): Set<string> {
  const cmds = new Set<string>();
  for (const line of lines) {
    const m = line.match(/^\s+\/gsd\s+(\S+)/);
    if (m) cmds.add(m[1]);
  }
  return cmds;
}

describe("help menu coverage", () => {
  test("every TOP_LEVEL_SUBCOMMAND appears in showHelp() output", async () => {
    // Import showHelp and capture its output via a mock ctx
    const lines: string[] = [];
    const mockCtx = {
      ui: {
        notify(message: string) {
          lines.push(...message.split("\n"));
        },
        custom: async () => {},
      },
    };

    const { showHelp } = await import("../commands/handlers/core.ts");
    showHelp(mockCtx as any);

    const helpCmds = extractHelpCommands(lines);

    // "help" is the command that shows the menu — it doesn't list itself
    const SELF_REFERENTIAL = new Set(["help"]);

    const missing: string[] = [];
    for (const entry of TOP_LEVEL_SUBCOMMANDS) {
      if (SELF_REFERENTIAL.has(entry.cmd)) continue;
      if (!helpCmds.has(entry.cmd)) {
        missing.push(entry.cmd);
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `Commands registered in TOP_LEVEL_SUBCOMMANDS but missing from /gsd help:\n  ${missing.join(", ")}`,
    );
  });
});
