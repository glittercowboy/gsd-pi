// decision-scope-cascade: Tests for R005 fallback cascade and scope derivation
//
// Validates:
// (a) inlineDecisionsFromDb cascade: milestone + scope → milestone only → null
// (b) deriveSliceScope extracts meaningful scope keywords from slice titles
// (c) deriveSliceScope returns undefined for generic titles

import { describe, test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertDecision,
} from '../gsd-db.ts';
import {
  queryDecisions,
  formatDecisionsForPrompt,
} from '../context-store.ts';
import { deriveSliceScope } from '../auto-prompts.ts';

// ═══════════════════════════════════════════════════════════════════════════
// deriveSliceScope: Extract meaningful scope from slice titles
// ═══════════════════════════════════════════════════════════════════════════

describe("deriveSliceScope: keyword extraction", () => {
  test("extracts first meaningful noun from title", () => {
    // "Auth Middleware & Protected Route" → "auth"
    assert.strictEqual(
      deriveSliceScope("Auth Middleware & Protected Route"),
      "auth",
      "extracts 'auth' from auth-related title",
    );

    // "Database & User Model Setup" → "database" (not "setup" which is generic)
    const dbScope = deriveSliceScope("Database & User Model Setup");
    assert.ok(
      dbScope === "database" || dbScope === "user",
      `expected 'database' or 'user', got '${dbScope}'`,
    );

    // "API Rate Limiting" → "api"
    assert.strictEqual(
      deriveSliceScope("API Rate Limiting"),
      "api",
      "extracts 'api' from API-related title",
    );

    // "Stripe Payment Integration" → "stripe"
    assert.strictEqual(
      deriveSliceScope("Stripe Payment Integration"),
      "stripe",
      "extracts 'stripe' from payment-related title",
    );
  });

  test("returns undefined for generic titles", () => {
    // "Integration Testing" → undefined (both words are generic)
    assert.strictEqual(
      deriveSliceScope("Integration Testing"),
      undefined,
      "returns undefined for generic 'Integration Testing'",
    );

    // "Setup & Configuration" → undefined (all generic)
    assert.strictEqual(
      deriveSliceScope("Setup & Configuration"),
      undefined,
      "returns undefined for generic 'Setup & Configuration'",
    );

    // "Final Review" → undefined
    assert.strictEqual(
      deriveSliceScope("Final Review"),
      undefined,
      "returns undefined for generic 'Final Review'",
    );

    // "Basic Implementation" → undefined
    assert.strictEqual(
      deriveSliceScope("Basic Implementation"),
      undefined,
      "returns undefined for generic 'Basic Implementation'",
    );
  });

  test("handles description as additional context", () => {
    // Generic title but specific description
    const scope = deriveSliceScope(
      "Initial Setup",
      "Configure PostgreSQL database connection",
    );
    assert.ok(
      scope === "postgresql" || scope === "database" || scope === "configure",
      `expected meaningful scope from description, got '${scope}'`,
    );
  });

  test("handles edge cases", () => {
    // Empty title
    assert.strictEqual(
      deriveSliceScope(""),
      undefined,
      "returns undefined for empty title",
    );

    // Short words only
    assert.strictEqual(
      deriveSliceScope("A B C"),
      undefined,
      "returns undefined for very short words",
    );

    // Mixed case and punctuation
    assert.strictEqual(
      deriveSliceScope("OAuth2 + JWT Authentication"),
      "oauth2",
      "handles mixed case and punctuation",
    );
  });

  test("filters unit IDs (S01, M001, T03)", () => {
    // "S01: Infrastructure" → undefined (S01 is a unit ID, infrastructure is generic)
    assert.strictEqual(
      deriveSliceScope("S01: Infrastructure"),
      undefined,
      "skips S01 ID and returns undefined for generic 'Infrastructure'",
    );

    // "M001 Setup" → undefined (M001 is a unit ID, setup is generic)
    assert.strictEqual(
      deriveSliceScope("M001 Setup"),
      undefined,
      "skips M001 ID and returns undefined for generic 'Setup'",
    );

    // "T03: Database Migration" → "database" (skips T03, returns meaningful word)
    assert.strictEqual(
      deriveSliceScope("T03: Database Migration"),
      "database",
      "skips T03 ID and returns 'database'",
    );

    // "S02 Auth Flow" → "auth" (skips S02, returns meaningful word)
    assert.strictEqual(
      deriveSliceScope("S02 Auth Flow"),
      "auth",
      "skips S02 ID and returns 'auth'",
    );
  });

  test("filters process/activity words", () => {
    // "Integration Testing + Hardening" → undefined (all generic/process words)
    assert.strictEqual(
      deriveSliceScope("Integration Testing + Hardening"),
      undefined,
      "returns undefined for 'Integration Testing + Hardening'",
    );

    // "Validation & Verification" → undefined (both are process words)
    assert.strictEqual(
      deriveSliceScope("Validation & Verification"),
      undefined,
      "returns undefined for 'Validation & Verification'",
    );

    // "Performance Optimization" → "performance" (optimization is generic, performance is domain)
    assert.strictEqual(
      deriveSliceScope("Performance Optimization"),
      "performance",
      "extracts 'performance' before generic 'optimization'",
    );

    // "Security Enhancement" → "security" (enhancement is generic, security is domain)
    assert.strictEqual(
      deriveSliceScope("Security Enhancement"),
      "security",
      "extracts 'security' before generic 'enhancement'",
    );

    // "WebSocket Delivery Pipeline" → "websocket"
    assert.strictEqual(
      deriveSliceScope("WebSocket Delivery Pipeline"),
      "websocket",
      "extracts 'websocket' from delivery pipeline title",
    );

    // "Prisma Schema + Migration" → "prisma"
    assert.strictEqual(
      deriveSliceScope("Prisma Schema + Migration"),
      "prisma",
      "extracts 'prisma' from schema migration title",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// inlineDecisionsFromDb cascade: R005 implementation
// ═══════════════════════════════════════════════════════════════════════════

describe("inlineDecisionsFromDb: cascade fallback (R005)", () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  test("cascade: scoped query returns scoped decisions when they exist", () => {
    // Insert decisions with different scopes
    insertDecision({
      id: 'D001', when_context: 'M001/S01', scope: 'auth',
      decision: 'use JWT', choice: 'JWT', rationale: 'standard',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });
    insertDecision({
      id: 'D002', when_context: 'M001/S02', scope: 'database',
      decision: 'use PostgreSQL', choice: 'PostgreSQL', rationale: 'relational',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });
    insertDecision({
      id: 'D003', when_context: 'M001/S01', scope: 'architecture',
      decision: 'use microservices', choice: 'microservices', rationale: 'scalable',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });

    // Query with scope 'auth' should return D001 only
    const authDecisions = queryDecisions({ milestoneId: 'M001', scope: 'auth' });
    assert.strictEqual(authDecisions.length, 1, 'scoped query returns 1 decision');
    assert.strictEqual(authDecisions[0]?.id, 'D001', 'returns D001 for auth scope');

    // Query with scope 'database' should return D002 only
    const dbDecisions = queryDecisions({ milestoneId: 'M001', scope: 'database' });
    assert.strictEqual(dbDecisions.length, 1, 'scoped query returns 1 decision');
    assert.strictEqual(dbDecisions[0]?.id, 'D002', 'returns D002 for database scope');
  });

  test("cascade: milestone-only fallback when scoped query returns empty", () => {
    // Insert decisions for M001 with generic scope (e.g. 'architecture')
    insertDecision({
      id: 'D001', when_context: 'M001/S01', scope: 'architecture',
      decision: 'use microservices', choice: 'microservices', rationale: 'scalable',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });
    insertDecision({
      id: 'D002', when_context: 'M001/S02', scope: 'performance',
      decision: 'use caching', choice: 'Redis', rationale: 'fast',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });

    // Query with scope 'auth' (no decisions with this scope) should return empty
    const authDecisions = queryDecisions({ milestoneId: 'M001', scope: 'auth' });
    assert.strictEqual(authDecisions.length, 0, 'scoped query for auth returns empty');

    // Simulate cascade: fallback to milestone-only query
    const milestoneDecisions = queryDecisions({ milestoneId: 'M001' });
    assert.strictEqual(milestoneDecisions.length, 2, 'milestone-only query returns 2 decisions');
    const ids = milestoneDecisions.map(d => d.id).sort();
    assert.deepStrictEqual(ids, ['D001', 'D002'], 'milestone fallback returns all M001 decisions');
  });

  test("cascade: returns null when both scoped and milestone queries are empty", () => {
    // Insert decisions only for M002
    insertDecision({
      id: 'D001', when_context: 'M002/S01', scope: 'auth',
      decision: 'use OAuth', choice: 'OAuth2', rationale: 'standard',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });

    // Query M001 with scope should return empty (no M001 decisions at all)
    const scopedDecisions = queryDecisions({ milestoneId: 'M001', scope: 'auth' });
    assert.strictEqual(scopedDecisions.length, 0, 'scoped query returns empty');

    // Fallback to milestone-only should also return empty (no M001 decisions)
    const milestoneDecisions = queryDecisions({ milestoneId: 'M001' });
    assert.strictEqual(milestoneDecisions.length, 0, 'milestone-only query returns empty');

    // This scenario would result in null from inlineDecisionsFromDb
    // (we can't directly test inlineDecisionsFromDb here without mocking fs)
  });

  test("cascade: demonstrates the full cascade behavior", () => {
    // This test demonstrates the cascade logic that inlineDecisionsFromDb implements:
    // 1. First try { milestoneId: 'M001', scope: 'payment' } → empty
    // 2. Then try { milestoneId: 'M001' } → gets D001, D002
    // 3. Return the milestone-level decisions

    // Setup: decisions exist at milestone level but not for 'payment' scope
    insertDecision({
      id: 'D001', when_context: 'M001/S01', scope: 'architecture',
      decision: 'use REST', choice: 'REST API', rationale: 'standard',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });
    insertDecision({
      id: 'D002', when_context: 'M001/S02', scope: 'security',
      decision: 'use HTTPS', choice: 'TLS 1.3', rationale: 'secure',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });

    // Step 1: Query with scope 'payment' (no matches)
    const paymentDecisions = queryDecisions({ milestoneId: 'M001', scope: 'payment' });
    assert.strictEqual(paymentDecisions.length, 0, 'payment scope query returns empty');

    // Step 2: Since scope was provided but returned empty, cascade to milestone-only
    const milestoneDecisions = queryDecisions({ milestoneId: 'M001' });
    assert.strictEqual(milestoneDecisions.length, 2, 'milestone fallback returns 2 decisions');

    // Step 3: Format and verify content
    const formatted = formatDecisionsForPrompt(milestoneDecisions);
    assert.match(formatted, /D001/, 'formatted output includes D001');
    assert.match(formatted, /D002/, 'formatted output includes D002');
    assert.match(formatted, /architecture/, 'formatted output includes architecture scope');
    assert.match(formatted, /security/, 'formatted output includes security scope');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: scope derivation feeds into cascade
// ═══════════════════════════════════════════════════════════════════════════

describe("integration: scope derivation with cascade", () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  test("derived scope finds matching decisions when they exist", () => {
    // Insert decisions with 'auth' scope
    insertDecision({
      id: 'D001', when_context: 'M001/S01', scope: 'auth',
      decision: 'use JWT', choice: 'JWT tokens', rationale: 'stateless',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });

    // Derive scope from slice title
    const derivedScope = deriveSliceScope("Auth Middleware & Protected Routes");
    assert.strictEqual(derivedScope, 'auth', 'derives auth scope from title');

    // Query with derived scope should find the decision
    const decisions = queryDecisions({ milestoneId: 'M001', scope: derivedScope });
    assert.strictEqual(decisions.length, 1, 'scoped query finds matching decision');
    assert.strictEqual(decisions[0]?.id, 'D001', 'finds the auth decision');
  });

  test("generic title triggers milestone-level fallback", () => {
    // Insert decisions with various scopes
    insertDecision({
      id: 'D001', when_context: 'M001/S01', scope: 'architecture',
      decision: 'use monolith', choice: 'monolith', rationale: 'simple',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });
    insertDecision({
      id: 'D002', when_context: 'M001/S02', scope: 'tooling',
      decision: 'use TypeScript', choice: 'TypeScript', rationale: 'type safety',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });

    // Derive scope from generic slice title
    const derivedScope = deriveSliceScope("Integration Testing");
    assert.strictEqual(derivedScope, undefined, 'generic title returns undefined scope');

    // Without a scope, query returns all milestone decisions
    const decisions = queryDecisions({ milestoneId: 'M001', scope: derivedScope });
    assert.strictEqual(decisions.length, 2, 'no scope filter returns all decisions');
  });
});
