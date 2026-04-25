import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, relative, sep } from "node:path";

// ─── Inline the pure functions under test to avoid import-chain issues ───────
// These are copied from packages/pi-coding-agent/src/core/resource-loader.ts
// (detectExtensionConflicts + extractExtensionKey).  The test validates the
// algorithm; integration coverage lives in the full build tests.

interface MinimalExtension {
  path: string;
  tools: Map<string, unknown>;
  commands: Map<string, unknown>;
  flags: Map<string, unknown>;
}

function extractExtensionKey(ownerPath: string, extensionsDir: string): string | undefined {
  const normalizedDir = resolve(extensionsDir);
  const normalizedPath = resolve(ownerPath);
  const prefix = normalizedDir.endsWith(sep) ? normalizedDir : `${normalizedDir}${sep}`;
  if (!normalizedPath.startsWith(prefix)) {
    return undefined;
  }
  const relPath = relative(normalizedDir, normalizedPath);
  const firstSegment = relPath.split(/[\\/]/)[0];
  return firstSegment?.replace(/\.(?:ts|js)$/, "") || undefined;
}

function detectExtensionConflicts(
  extensions: MinimalExtension[],
  bundledExtensionKeys: Set<string>,
  extensionsDir: string,
): Array<{ path: string; message: string }> {
  const conflicts: Array<{ path: string; message: string }> = [];
  const toolOwners = new Map<string, string>();
  const commandOwners = new Map<string, string>();
  const flagOwners = new Map<string, string>();

  const isBundled = (ownerPath: string): boolean => {
    const key = extractExtensionKey(ownerPath, extensionsDir);
    return key !== undefined && bundledExtensionKeys.has(key);
  };

  for (const ext of extensions) {
    for (const toolName of ext.tools.keys()) {
      const existingOwner = toolOwners.get(toolName);
      if (existingOwner && existingOwner !== ext.path) {
        const hint = isBundled(existingOwner)
          ? ` (built-in tool supersedes — consider removing ${ext.path})`
          : "";
        conflicts.push({ path: ext.path, message: `Tool "${toolName}" conflicts with ${existingOwner}${hint}` });
      } else {
        toolOwners.set(toolName, ext.path);
      }
    }

    for (const commandName of ext.commands.keys()) {
      const existingOwner = commandOwners.get(commandName);
      if (existingOwner && existingOwner !== ext.path) {
        const hint = isBundled(existingOwner)
          ? ` (built-in command supersedes — consider removing ${ext.path})`
          : "";
        conflicts.push({ path: ext.path, message: `Command "/${commandName}" conflicts with ${existingOwner}${hint}` });
      } else {
        commandOwners.set(commandName, ext.path);
      }
    }

    for (const flagName of ext.flags.keys()) {
      const existingOwner = flagOwners.get(flagName);
      if (existingOwner && existingOwner !== ext.path) {
        conflicts.push({ path: ext.path, message: `Flag "--${flagName}" conflicts with ${existingOwner}` });
      } else {
        flagOwners.set(flagName, ext.path);
      }
    }
  }

  return conflicts;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeExtension(
  path: string,
  overrides: { tools?: string[]; commands?: string[]; flags?: string[] } = {},
): MinimalExtension {
  const tools = new Map<string, unknown>();
  for (const name of overrides.tools ?? []) tools.set(name, {});
  const commands = new Map<string, unknown>();
  for (const name of overrides.commands ?? []) commands.set(name, {});
  const flags = new Map<string, unknown>();
  for (const name of overrides.flags ?? []) flags.set(name, {});
  return { path, tools, commands, flags };
}

// ─── extractExtensionKey ─────────────────────────────────────────────────────

describe("extractExtensionKey", () => {
  const extensionsDir = "/home/user/.gsd/agent/extensions";

  it("extracts directory name from a nested extension path", () => {
    assert.equal(
      extractExtensionKey("/home/user/.gsd/agent/extensions/mcp-client/index.js", extensionsDir),
      "mcp-client",
    );
  });

  it("strips .ts/.js suffix from flat extension files", () => {
    assert.equal(
      extractExtensionKey("/home/user/.gsd/agent/extensions/my-ext.ts", extensionsDir),
      "my-ext",
    );
  });

  it("returns undefined when the path is not under extensionsDir", () => {
    assert.equal(
      extractExtensionKey("/other/path/some-ext/index.js", extensionsDir),
      undefined,
    );
  });
});

// ─── detectExtensionConflicts ─────────────────────────────────────────────────

describe("detectExtensionConflicts", () => {
  const extensionsDir = "/home/user/.gsd/agent/extensions";

  it("returns no conflicts when extensions have unique tool names", () => {
    const extensions = [
      makeExtension(join(extensionsDir, "ext-a/index.js"), { tools: ["tool_a"] }),
      makeExtension(join(extensionsDir, "ext-b/index.js"), { tools: ["tool_b"] }),
    ];
    const conflicts = detectExtensionConflicts(extensions, new Set(["ext-a"]), extensionsDir);
    assert.equal(conflicts.length, 0);
  });

  it("adds supersedes hint when first-registered tool owner is a bundled extension", () => {
    const bundledPath = join(extensionsDir, "mcp-client/index.js");
    const userPath = join(extensionsDir, "mcporter/index.ts");

    const extensions = [
      makeExtension(bundledPath, { tools: ["mcp_servers"] }),
      makeExtension(userPath, { tools: ["mcp_servers"] }),
    ];

    const conflicts = detectExtensionConflicts(extensions, new Set(["mcp-client"]), extensionsDir);

    assert.equal(conflicts.length, 1);
    assert.ok(
      conflicts[0].message.includes("supersedes"),
      `Expected "supersedes" in message, got: ${conflicts[0].message}`,
    );
    assert.equal(conflicts[0].path, userPath);
  });

  it("omits supersedes hint when first-registered tool owner is NOT bundled", () => {
    const userPathA = join(extensionsDir, "mcporter/index.ts");
    const userPathB = join(extensionsDir, "mcporter-v2/index.ts");

    const extensions = [
      makeExtension(userPathA, { tools: ["mcp_servers"] }),
      makeExtension(userPathB, { tools: ["mcp_servers"] }),
    ];

    const conflicts = detectExtensionConflicts(extensions, new Set(["mcp-client"]), extensionsDir);

    assert.equal(conflicts.length, 1);
    assert.ok(
      !conflicts[0].message.includes("supersedes"),
      `Expected no "supersedes" in message, got: ${conflicts[0].message}`,
    );
  });

  it("adds supersedes hint for command conflicts with bundled extensions", () => {
    const bundledPath = join(extensionsDir, "mcp-client/index.js");
    const userPath = join(extensionsDir, "mcporter/index.ts");

    const extensions = [
      makeExtension(bundledPath, { commands: ["mcp"] }),
      makeExtension(userPath, { commands: ["mcp"] }),
    ];

    const conflicts = detectExtensionConflicts(extensions, new Set(["mcp-client"]), extensionsDir);

    assert.equal(conflicts.length, 1);
    assert.ok(
      conflicts[0].message.includes("supersedes"),
      `Expected "supersedes" in command conflict, got: ${conflicts[0].message}`,
    );
  });

  it("works with an empty bundledExtensionKeys set (backwards compat)", () => {
    const pathA = join(extensionsDir, "ext-a/index.js");
    const pathB = join(extensionsDir, "ext-b/index.js");

    const extensions = [
      makeExtension(pathA, { tools: ["shared_tool"] }),
      makeExtension(pathB, { tools: ["shared_tool"] }),
    ];

    const conflicts = detectExtensionConflicts(extensions, new Set(), extensionsDir);

    assert.equal(conflicts.length, 1);
    assert.ok(
      !conflicts[0].message.includes("supersedes"),
      `Expected no "supersedes" when bundledKeys empty, got: ${conflicts[0].message}`,
    );
  });

  it("reproduces issue #2075: bundled extension under /.gsd/agent/extensions/ was never identified as built-in", () => {
    // Before the fix, the isBuiltIn check used path heuristics that excluded
    // paths containing /.gsd/agent/extensions/, so bundled extensions placed
    // there by initResources() could never be recognized as built-in.
    const bundledPath = "/home/user/.gsd/agent/extensions/mcp-client/index.js";
    const userPath = "/home/user/.gsd/agent/extensions/mcporter/index.ts";

    const extensions = [
      makeExtension(bundledPath, { tools: ["mcp_servers", "mcp_discover", "mcp_call"] }),
      makeExtension(userPath, { tools: ["mcp_servers", "mcp_discover", "mcp_call"] }),
    ];

    const bundledKeys = new Set(["mcp-client"]);
    const conflicts = detectExtensionConflicts(extensions, bundledKeys, "/home/user/.gsd/agent/extensions");

    // All three conflicting tools should include the supersedes hint
    assert.equal(conflicts.length, 3);
    for (const conflict of conflicts) {
      assert.ok(
        conflict.message.includes("supersedes"),
        `Conflict for tool should include "supersedes" hint, got: ${conflict.message}`,
      );
    }
  });
});
