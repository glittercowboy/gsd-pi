/**
 * graph-context.test.ts — Unit tests for inlineGraphSubgraph().
 *
 * Covers:
 *   Group 1: Null-return paths (empty term, zero nodes, missing graph.json)
 *   Group 2: Correct output formatting (nodes, edges, stale annotation)
 *   Group 3: Node formatting (description, confidence, no-description)
 *
 * Testing strategy:
 *   @gsd-build/mcp-server is dynamically imported inside inlineGraphSubgraph().
 *   Because node:test (v22) does not support mock.module() without the
 *   --experimental-test-module-mocks flag (not enabled in test:unit), we
 *   exercise the real graphQuery/graphStatus functions by controlling the
 *   on-disk graph.json that those functions read. This is a clean, deterministic
 *   approach that avoids all module-level mocking.
 *
 *   Fixture layout per test:
 *     <tmpDir>/.gsd/graphs/graph.json
 *
 *   builtAt controls staleness: old timestamp → stale, recent → fresh.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { inlineGraphSubgraph } from "../graph-context.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface TestNode {
  id: string;
  label: string;
  type: string;
  confidence: string;
  description?: string;
  sourceFile?: string;
}

interface TestEdge {
  from: string;
  to: string;
  type: string;
  confidence: string;
}

interface GraphFixture {
  nodes: TestNode[];
  edges: TestEdge[];
  /** ISO timestamp for graph.builtAt. Controls staleness. Default: recent (not stale). */
  builtAt?: string;
}

/** Returns an ISO timestamp that is stale (> 24h ago). */
function staleTimestamp(hoursAgo = 26): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

/** Returns an ISO timestamp that is fresh (< 24h ago). */
function freshTimestamp(): string {
  return new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 minutes ago
}

/**
 * Creates a temp project directory with a .gsd/graphs/graph.json file.
 * Returns the projectDir path. Caller is responsible for cleanup.
 */
function makeProjectDir(fixture: GraphFixture): string {
  const projectDir = mkdtempSync(join(tmpdir(), "graph-ctx-test-"));
  const gsdDir = join(projectDir, ".gsd");
  const graphsDir = join(gsdDir, "graphs");
  mkdirSync(graphsDir, { recursive: true });

  const graph = {
    nodes: fixture.nodes,
    edges: fixture.edges,
    builtAt: fixture.builtAt ?? freshTimestamp(),
  };

  writeFileSync(join(graphsDir, "graph.json"), JSON.stringify(graph), "utf-8");
  return projectDir;
}

/** Removes a temp directory, suppressing errors on Windows. */
function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Minimal node factory. */
function makeNode(overrides: Partial<TestNode> & { id: string; label: string }): TestNode {
  return {
    type: "CLASS",
    confidence: "INFERRED",
    ...overrides,
  };
}

/** Minimal edge factory. */
function makeEdge(overrides: Partial<TestEdge> & { from: string; to: string }): TestEdge {
  return {
    type: "CALLS",
    confidence: "INFERRED",
    ...overrides,
  };
}

// ─── Group 1: Null returns ────────────────────────────────────────────────────

describe("inlineGraphSubgraph — null returns", () => {
  it("returns null immediately for empty string term", async () => {
    // No graph.json needed — exits before any file I/O
    const result = await inlineGraphSubgraph("/tmp/nonexistent", "", { budget: 3000 });
    assert.strictEqual(result, null);
  });

  it("returns null for whitespace-only term", async () => {
    const result = await inlineGraphSubgraph("/tmp/nonexistent", "   ", { budget: 3000 });
    assert.strictEqual(result, null);
  });

  it("returns null when graphQuery returns zero nodes (no matching term in graph)", async () => {
    const projectDir = makeProjectDir({
      nodes: [makeNode({ id: "n1", label: "AuthService" })],
      edges: [],
    });
    try {
      // "zzznomatch999" is intentionally absent from the fixture
      const result = await inlineGraphSubgraph(projectDir, "zzznomatch999", { budget: 3000 });
      assert.strictEqual(result, null);
    } finally {
      cleanup(projectDir);
    }
  });

  it("returns null (no throw) when graph.json is missing", async () => {
    // A project dir with no .gsd directory at all — graphQuery returns zero nodes
    const projectDir = mkdtempSync(join(tmpdir(), "graph-ctx-nofile-"));
    try {
      const result = await inlineGraphSubgraph(projectDir, "auth", { budget: 3000 });
      assert.strictEqual(result, null);
    } finally {
      cleanup(projectDir);
    }
  });
});

// ─── Group 2: Correct output formatting ──────────────────────────────────────

describe("inlineGraphSubgraph — correct output", () => {
  it("returns block with section header and node labels when term matches", async () => {
    const projectDir = makeProjectDir({
      nodes: [
        makeNode({ id: "n1", label: "UserService" }),
        makeNode({ id: "n2", label: "UserRepository" }),
      ],
      edges: [],
    });
    try {
      const result = await inlineGraphSubgraph(projectDir, "User", { budget: 3000 });
      assert.ok(result !== null, "result should not be null");
      assert.ok(result!.includes("### Knowledge Graph Context"), "should include section header");
      assert.ok(result!.includes("UserService"), "should include first node label");
      assert.ok(result!.includes("UserRepository"), "should include second node label");
      assert.ok(result!.includes("Nodes (2)"), "should show node count");
    } finally {
      cleanup(projectDir);
    }
  });

  it("does not include Relations section when edges array is empty", async () => {
    const projectDir = makeProjectDir({
      nodes: [makeNode({ id: "n1", label: "AuthController" })],
      edges: [],
    });
    try {
      const result = await inlineGraphSubgraph(projectDir, "Auth", { budget: 3000 });
      assert.ok(result !== null, "result should not be null");
      assert.ok(!result!.includes("Relations"), "should not include Relations section for zero edges");
      assert.ok(!result!.includes("⚠"), "should not include stale warning for fresh graph");
    } finally {
      cleanup(projectDir);
    }
  });

  it("includes Relations section when edges are present", async () => {
    const projectDir = makeProjectDir({
      nodes: [
        makeNode({ id: "n1", label: "AuthService" }),
        makeNode({ id: "n2", label: "UserRepo" }),
      ],
      edges: [makeEdge({ from: "n1", to: "n2", type: "CALLS" })],
    });
    try {
      const result = await inlineGraphSubgraph(projectDir, "Auth", { budget: 3000 });
      assert.ok(result !== null, "result should not be null");
      assert.ok(result!.includes("Relations (1)"), "should show edge count");
      assert.ok(result!.includes("→[CALLS]→"), "should include edge type in arrow notation");
    } finally {
      cleanup(projectDir);
    }
  });

  it("includes stale annotation when graph was built more than 24h ago", async () => {
    const projectDir = makeProjectDir({
      nodes: [makeNode({ id: "n1", label: "AuthService" })],
      edges: [],
      builtAt: staleTimestamp(26), // 26 hours ago → stale
    });
    try {
      const result = await inlineGraphSubgraph(projectDir, "Auth", { budget: 3000 });
      assert.ok(result !== null, "result should not be null");
      assert.ok(result!.includes("⚠ Graph last built"), "should include stale annotation");
      assert.ok(result!.includes("h ago"), "should include hours-ago text");
    } finally {
      cleanup(projectDir);
    }
  });

  it("does not include stale annotation for a fresh graph", async () => {
    const projectDir = makeProjectDir({
      nodes: [makeNode({ id: "n1", label: "AuthService" })],
      edges: [],
      builtAt: freshTimestamp(), // 30 minutes ago → not stale
    });
    try {
      const result = await inlineGraphSubgraph(projectDir, "Auth", { budget: 3000 });
      assert.ok(result !== null, "result should not be null");
      assert.ok(!result!.includes("⚠"), "should not include stale annotation for fresh graph");
    } finally {
      cleanup(projectDir);
    }
  });

  it("returns valid block even when graph.json has corrupted builtAt (graphStatus throws internally)", async () => {
    // Write a graph.json with an invalid builtAt — graphStatus will catch and return {exists: false}
    // inlineGraphSubgraph should still return the node block without stale annotation
    const projectDir = mkdtempSync(join(tmpdir(), "graph-ctx-corrupt-"));
    const gsdDir = join(projectDir, ".gsd");
    const graphsDir = join(gsdDir, "graphs");
    mkdirSync(graphsDir, { recursive: true });

    const graph = {
      nodes: [{ id: "n1", label: "AuthController", type: "CLASS", confidence: "INFERRED" }],
      edges: [],
      builtAt: "NOT-A-DATE", // invalid ISO — will cause Date.now() - NaN to produce NaN
    };
    writeFileSync(join(graphsDir, "graph.json"), JSON.stringify(graph), "utf-8");

    try {
      const result = await inlineGraphSubgraph(projectDir, "Auth", { budget: 3000 });
      // graphQuery reads the file and finds the node; graphStatus may return {exists: true, stale: false/true}
      // Either way, function must not throw and must return a string with node content
      assert.ok(result !== null, "result should not be null");
      assert.ok(result!.includes("AuthController"), "should include node label");
    } finally {
      cleanup(projectDir);
    }
  });

  it("passes the budget option to graphQuery (enforces node count limit)", async () => {
    // Each node uses ~20 tokens. With budget=20, only ~1 node should be returned.
    // Build a graph with many nodes all matching the same term.
    const nodes: TestNode[] = Array.from({ length: 10 }, (_, i) =>
      makeNode({ id: `n${i}`, label: `AuthModule${i}` })
    );
    const projectDir = makeProjectDir({ nodes, edges: [] });
    try {
      const resultSmall = await inlineGraphSubgraph(projectDir, "Auth", { budget: 20 });
      const resultLarge = await inlineGraphSubgraph(projectDir, "Auth", { budget: 10000 });

      // Both should return something (at least 1 node matches)
      assert.ok(resultSmall !== null, "small-budget result should not be null");
      assert.ok(resultLarge !== null, "large-budget result should not be null");

      // With a very small budget (20 tokens ≈ 1 node), fewer nodes should appear
      const smallNodeCount = (resultSmall!.match(/- \*\*/g) || []).length;
      const largeNodeCount = (resultLarge!.match(/- \*\*/g) || []).length;
      assert.ok(
        smallNodeCount <= largeNodeCount,
        `small-budget should return <= nodes than large-budget (got ${smallNodeCount} vs ${largeNodeCount})`,
      );
    } finally {
      cleanup(projectDir);
    }
  });
});

// ─── Group 3: Node formatting ─────────────────────────────────────────────────

describe("inlineGraphSubgraph — node formatting", () => {
  it("includes description after em-dash when node has description", async () => {
    const projectDir = makeProjectDir({
      nodes: [makeNode({ id: "n1", label: "JwtValidator", description: "JWT validation" })],
      edges: [],
    });
    try {
      const result = await inlineGraphSubgraph(projectDir, "Jwt", { budget: 3000 });
      assert.ok(result !== null, "result should not be null");
      assert.ok(result!.includes("— JWT validation"), "should include description after em-dash");
    } finally {
      cleanup(projectDir);
    }
  });

  it("omits em-dash suffix when node has no description", async () => {
    const projectDir = makeProjectDir({
      nodes: [makeNode({ id: "n1", label: "TokenStore" })], // no description
      edges: [],
    });
    try {
      const result = await inlineGraphSubgraph(projectDir, "Token", { budget: 3000 });
      assert.ok(result !== null, "result should not be null");
      const lines = result!.split("\n");
      const nodeLine = lines.find((l) => l.includes("TokenStore"));
      assert.ok(nodeLine !== undefined, "node line should be present");
      assert.ok(!nodeLine.includes("—"), "node line should not include em-dash when no description");
    } finally {
      cleanup(projectDir);
    }
  });

  it("includes confidence tier in the node output line", async () => {
    const projectDir = makeProjectDir({
      nodes: [makeNode({ id: "n1", label: "AuthService", confidence: "EXTRACTED" })],
      edges: [],
    });
    try {
      const result = await inlineGraphSubgraph(projectDir, "Auth", { budget: 3000 });
      assert.ok(result !== null, "result should not be null");
      assert.ok(result!.includes("EXTRACTED"), "should include the confidence tier in node line");
    } finally {
      cleanup(projectDir);
    }
  });
});
