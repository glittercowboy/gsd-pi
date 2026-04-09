import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  queryKnowledge,
  formatRoadmapExcerpt,
} from '../context-store.ts';

// ═══════════════════════════════════════════════════════════════════════════
// measurement.test.ts — Verify ≥40% context reduction from scoped injection
//
// Tests queryKnowledge() and formatRoadmapExcerpt() with realistic synthetic
// fixtures to confirm the context reduction target is met.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Synthetic KNOWLEDGE.md Fixture (~8KB, 9 H2 sections) ──────────────────

const syntheticKnowledge = `# Project Knowledge Base

## Database Patterns
SQLite is the primary persistence layer, using WAL mode for concurrent reads.
All queries use prepared statements for SQL injection prevention.
Connection pooling is handled by better-sqlite3's synchronous API.
Schema migrations are versioned and applied at startup.

Example patterns:
- Use transactions for multi-statement operations
- Prefer RETURNING clause for insert/update
- Index foreign keys for join performance
- Use CHECK constraints for data validation

Performance considerations:
- WAL checkpoint every 1000 writes
- Vacuum on shutdown for space reclamation
- Page size 4096 for SSD optimization

Database schema evolution:
- Migrations stored in migrations/ directory
- Each migration has up/down scripts
- Version table tracks applied migrations
- Rollback supported for last N migrations

Connection management:
- Single connection for write operations
- Read connections pooled for concurrency
- Connection timeout set to 5 seconds
- Busy timeout handles lock contention

Query patterns:
- Use prepared statements for parameterization
- Batch inserts via INSERT ... VALUES syntax
- Upserts via INSERT OR REPLACE
- Pagination via LIMIT/OFFSET or cursor

## API Design Principles
REST endpoints follow OpenAPI 3.0 specification.
Versioned paths use /v1/resource pattern.
Authentication uses Bearer tokens in Authorization header.
Rate limiting applies per-client with sliding window algorithm.

Response formats:
- Success: { data: T, meta?: { pagination } }
- Error: { error: { code, message, details? } }
- Pagination: cursor-based for large collections

Content negotiation:
- Accept: application/json (default)
- Accept: text/plain (for CLI consumers)
- Accept: text/event-stream (for SSE endpoints)

API versioning strategy:
- Major versions in URL path (/v1, /v2)
- Minor versions via Accept-Version header
- Deprecation warnings in response headers
- 12-month sunset period for old versions

Endpoint naming conventions:
- Nouns for resources (users, projects)
- Verbs only for non-CRUD actions (login, export)
- Plural form for collections
- Singular for singletons (me, config)

HTTP method semantics:
- GET: read-only, cacheable
- POST: create or non-idempotent action
- PUT: full replacement
- PATCH: partial update
- DELETE: remove resource

## Testing Strategy
Unit tests use node:test with strict assertions.
Integration tests mock external services via msw.
E2E tests use Playwright for browser automation.
Test coverage target is 80% line coverage.

Test organization:
- Unit tests adjacent to source files (*.test.ts)
- Integration tests in __tests__/integration/
- E2E tests in e2e/ directory
- Fixtures in __fixtures__/ subdirectories

Mocking guidelines:
- Prefer dependency injection over global mocks
- Use vi.mock() sparingly, only for ES module boundaries
- Reset mocks in afterEach hooks

Test data management:
- Factories generate realistic test data
- Seeds populate database for integration tests
- Snapshots capture expected output
- Golden files for complex comparisons

Assertion patterns:
- Use strict equality for primitives
- Deep equality for objects/arrays
- Regex matching for dynamic content
- Snapshot testing for UI components

Test isolation:
- Each test gets fresh database state
- Environment variables reset between tests
- File system operations use temp directories
- Network calls intercepted by mock server

## Error Handling
Errors are typed using discriminated unions.
Application errors extend BaseError class.
HTTP errors map to standard status codes.
Unhandled rejections trigger graceful shutdown.

Error codes follow domain prefixes:
- AUTH_xxx: Authentication/authorization errors
- DB_xxx: Database operation failures
- NET_xxx: Network/external service errors
- VAL_xxx: Validation errors

Logging integration:
- Error instances auto-serialize to JSON
- Stack traces included in development
- Correlation IDs propagate through request chain

Error recovery strategies:
- Retry with exponential backoff for transient errors
- Circuit breaker for external service failures
- Fallback values for non-critical operations
- Graceful degradation for partial failures

User-facing error messages:
- Generic messages for security-sensitive errors
- Actionable guidance for recoverable errors
- Reference codes for support escalation
- Localized messages via i18n

Error boundary patterns:
- Component-level boundaries in UI
- Route-level error handlers in API
- Global unhandled rejection handlers
- Process-level crash recovery

## Observability Patterns
Structured logging uses pino with JSON output.
Metrics collected via OpenTelemetry SDK.
Traces propagate context through async boundaries.
Health checks exposed at /health and /ready endpoints.

Log levels:
- ERROR: Unrecoverable failures
- WARN: Degraded operation
- INFO: Significant state changes
- DEBUG: Detailed diagnostic data

Metric types:
- Counters for request counts
- Histograms for latency distribution
- Gauges for resource utilization

Trace context propagation:
- W3C Trace Context headers
- Baggage for cross-service metadata
- Span attributes for searchability
- Events for significant moments

Dashboard design:
- SLO dashboards for reliability
- Request flow visualization
- Error rate trends
- Resource saturation alerts

Alerting strategy:
- Page for customer-impacting issues
- Ticket for degraded performance
- Notification for capacity planning
- Silence during maintenance windows

## Security Guidelines
Secrets never appear in logs or error messages.
Environment variables validated at startup.
CORS configured per-environment whitelist.
CSP headers enforced for web responses.

Input validation:
- Zod schemas for request body parsing
- Path parameters validated against patterns
- Query parameters have default/max values

Output encoding:
- HTML entities escaped in templates
- JSON stringification for API responses
- URL encoding for redirect targets

Authentication patterns:
- JWT tokens with short expiry
- Refresh token rotation
- Session invalidation on logout
- Multi-factor authentication support

Authorization model:
- Role-based access control (RBAC)
- Resource-level permissions
- Attribute-based policies (ABAC)
- Principle of least privilege

Secure communication:
- TLS 1.3 minimum
- Certificate pinning for mobile
- HSTS preload list
- Certificate transparency logging

## Performance Optimization
Critical paths target sub-10ms latency.
Database queries use covering indexes.
Response compression enabled for > 1KB bodies.
Static assets served with immutable caching.

Caching strategy:
- Redis for session data
- In-memory LRU for hot paths
- CDN for static assets
- Stale-while-revalidate for API responses

Memory management:
- Stream large payloads instead of buffering
- Weak references for disposable caches
- Manual GC hints for batch operations

Query optimization:
- Explain plans for complex queries
- Index usage analysis
- Query result caching
- Connection pooling tuning

Frontend performance:
- Code splitting for lazy loading
- Image optimization and lazy loading
- Critical CSS inlining
- Prefetching for likely navigations

Backend performance:
- Async I/O for non-blocking operations
- Worker threads for CPU-bound tasks
- Connection keep-alive
- Response streaming

## Deployment Architecture
Containers built with multi-stage Dockerfiles.
Kubernetes manifests in deploy/ directory.
Horizontal pod autoscaling on CPU/memory.
Rolling updates with zero-downtime.

Environment hierarchy:
- development: local Docker Compose
- staging: shared k8s namespace
- production: isolated k8s cluster

Configuration:
- ConfigMaps for non-sensitive config
- Secrets for credentials
- Environment-specific overlays via Kustomize

Container best practices:
- Non-root user in container
- Read-only filesystem where possible
- Resource limits and requests
- Liveness and readiness probes

Service mesh integration:
- Istio for traffic management
- mTLS for service-to-service auth
- Retry and timeout policies
- Circuit breaking configuration

Disaster recovery:
- Database replication across zones
- Point-in-time recovery capability
- Regular backup verification
- Documented runbooks

## Development Workflow
Feature branches follow conventional commits.
PRs require CI pass and code review.
Main branch deploys to staging automatically.
Release tags trigger production deployment.

CI pipeline stages:
1. Install dependencies
2. Lint and type check
3. Unit tests with coverage
4. Build artifacts
5. Integration tests
6. Security scan

Local development:
- pnpm for package management
- Turborepo for monorepo orchestration
- Docker Compose for service dependencies

Code review guidelines:
- Focus on correctness and clarity
- Security-sensitive changes require security review
- Performance-critical paths need benchmarks
- Breaking changes need migration guide

Branch strategy:
- main: production-ready code
- develop: integration branch (optional)
- feature/*: new functionality
- fix/*: bug fixes
- release/*: release preparation

Documentation requirements:
- README for project overview
- API docs auto-generated from OpenAPI
- Architecture decision records (ADRs)
- Runbooks for operational procedures
`;

// ─── Synthetic Roadmap Fixture (~1KB, 4 slices) ────────────────────────────

const syntheticRoadmap = `# M005: Tiered Context Injection

## Vision
Refactor prompt builders to inject relevance-scoped context instead of full files.
This reduces token consumption and improves agent focus on relevant information.

## Success Criteria
- [ ] 40% reduction in injected context size
- [ ] No regression in agent task completion rate
- [ ] Measurable test confirms reduction target

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | Scope existing DB queries | low | — | ✅ | planSlice and researchSlice use milestone+slice filters for decisions/requirements. |
| S02 | KNOWLEDGE scoping + roadmap excerpt | medium | S01 | ⬜ | KNOWLEDGE sections filtered by keywords. Roadmap injected as excerpt. |
| S03 | Measurement test suite | low | S02 | ⬜ | Automated tests confirm 40% reduction vs baseline. |
| S04 | Documentation and rollout | low | S03 | ⬜ | Updated docs. Feature flag for gradual rollout. |

## Key Risks
1. Keyword extraction may miss relevant sections — mitigate with fallback to full content
2. Excerpt parsing fragile to roadmap format changes — mitigate with graceful degradation

## Definition of Done
- [ ] All slices complete with passing verification
- [ ] Measurement tests in CI
- [ ] No increase in prompt build latency
`;

// ═══════════════════════════════════════════════════════════════════════════
// Measurement Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("measurement: context reduction verification", () => {
  test("synthetic KNOWLEDGE fixture is ~8KB as specified", () => {
    const sizeKB = syntheticKnowledge.length / 1024;
    assert.ok(
      sizeKB >= 7 && sizeKB <= 10,
      `KNOWLEDGE fixture should be ~8KB, got ${sizeKB.toFixed(2)}KB`
    );
  });

  test("synthetic KNOWLEDGE has 9 H2 sections", () => {
    const h2Count = (syntheticKnowledge.match(/^## /gm) || []).length;
    assert.strictEqual(h2Count, 9, `KNOWLEDGE fixture should have 9 H2 sections, got ${h2Count}`);
  });

  test("queryKnowledge achieves ≥40% reduction with targeted keywords", async () => {
    // Keywords targeting 2 sections: "Database Patterns" and "Testing Strategy"
    const keywords = ['database', 'testing'];
    
    const scopedResult = await queryKnowledge(syntheticKnowledge, keywords);
    
    const fullSize = syntheticKnowledge.length;
    const scopedSize = scopedResult.length;
    const reductionPct = ((fullSize - scopedSize) / fullSize) * 100;
    
    // Verify we got matching sections
    assert.match(scopedResult, /## Database Patterns/, 'should include Database section');
    assert.match(scopedResult, /## Testing Strategy/, 'should include Testing section');
    
    // Verify we excluded other sections
    assert.ok(!scopedResult.includes('## API Design'), 'should exclude API section');
    assert.ok(!scopedResult.includes('## Observability'), 'should exclude Observability section');
    assert.ok(!scopedResult.includes('## Deployment'), 'should exclude Deployment section');
    
    // Verify ≥40% reduction (2/9 sections = ~78% reduction expected)
    assert.ok(
      reductionPct >= 40,
      `queryKnowledge should achieve ≥40% reduction, got ${reductionPct.toFixed(1)}% (${scopedSize} chars vs ${fullSize} chars)`
    );
    
    console.log(`  → queryKnowledge: ${reductionPct.toFixed(1)}% reduction (${scopedSize} → ${fullSize} chars)`);
  });

  test("queryKnowledge with single keyword achieves ≥40% reduction", async () => {
    // Single keyword targeting 1 section
    const keywords = ['security'];
    
    const scopedResult = await queryKnowledge(syntheticKnowledge, keywords);
    
    const fullSize = syntheticKnowledge.length;
    const scopedSize = scopedResult.length;
    const reductionPct = ((fullSize - scopedSize) / fullSize) * 100;
    
    // Verify we got matching section
    assert.match(scopedResult, /## Security Guidelines/, 'should include Security section');
    
    // Verify ≥40% reduction (1/9 sections = ~89% reduction expected)
    assert.ok(
      reductionPct >= 40,
      `single keyword should achieve ≥40% reduction, got ${reductionPct.toFixed(1)}%`
    );
  });

  test("formatRoadmapExcerpt achieves ≥40% reduction", () => {
    const sliceId = 'S02';
    
    const excerptResult = formatRoadmapExcerpt(syntheticRoadmap, sliceId, '.gsd/milestones/M005/M005-ROADMAP.md');
    
    const fullSize = syntheticRoadmap.length;
    const excerptSize = excerptResult.length;
    const reductionPct = ((fullSize - excerptSize) / fullSize) * 100;
    
    // Verify excerpt contains required elements
    assert.match(excerptResult, /\| ID \| Slice \|/, 'should have table header');
    assert.match(excerptResult, /\| S01 \|/, 'should have predecessor S01');
    assert.match(excerptResult, /\| S02 \|/, 'should have target S02');
    assert.match(excerptResult, /See full roadmap:/, 'should have reference directive');
    
    // Verify we excluded other slices
    assert.ok(!excerptResult.includes('| S03 |'), 'should exclude S03');
    assert.ok(!excerptResult.includes('| S04 |'), 'should exclude S04');
    
    // Verify ≥40% reduction (2 rows + overhead vs full roadmap = significant reduction)
    assert.ok(
      reductionPct >= 40,
      `formatRoadmapExcerpt should achieve ≥40% reduction, got ${reductionPct.toFixed(1)}% (${excerptSize} chars vs ${fullSize} chars)`
    );
    
    console.log(`  → formatRoadmapExcerpt: ${reductionPct.toFixed(1)}% reduction (${excerptSize} → ${fullSize} chars)`);
  });

  test("combined KNOWLEDGE + roadmap reduction exceeds 40%", async () => {
    // Simulate what happens in buildPlanSlicePrompt
    const keywords = ['database', 'testing'];
    
    const scopedKnowledge = await queryKnowledge(syntheticKnowledge, keywords);
    const scopedRoadmap = formatRoadmapExcerpt(syntheticRoadmap, 'S02');
    
    const fullKnowledgeSize = syntheticKnowledge.length;
    const fullRoadmapSize = syntheticRoadmap.length;
    const fullTotal = fullKnowledgeSize + fullRoadmapSize;
    
    const scopedKnowledgeSize = scopedKnowledge.length;
    const scopedRoadmapSize = scopedRoadmap.length;
    const scopedTotal = scopedKnowledgeSize + scopedRoadmapSize;
    
    const combinedReductionPct = ((fullTotal - scopedTotal) / fullTotal) * 100;
    
    // Combined reduction should easily exceed 40%
    assert.ok(
      combinedReductionPct >= 40,
      `combined reduction should be ≥40%, got ${combinedReductionPct.toFixed(1)}%`
    );
    
    console.log(`  → Combined: ${combinedReductionPct.toFixed(1)}% reduction`);
    console.log(`    - KNOWLEDGE: ${fullKnowledgeSize} → ${scopedKnowledgeSize} chars`);
    console.log(`    - Roadmap: ${fullRoadmapSize} → ${scopedRoadmapSize} chars`);
    console.log(`    - Total: ${fullTotal} → ${scopedTotal} chars`);
  });
});

describe("measurement: edge cases maintain reduction target", () => {
  test("three keywords still achieves ≥40% reduction", async () => {
    // Even with 3 matching sections (3/9 = 33%), we should hit target
    const keywords = ['database', 'api', 'security'];
    
    const scopedResult = await queryKnowledge(syntheticKnowledge, keywords);
    
    const fullSize = syntheticKnowledge.length;
    const scopedSize = scopedResult.length;
    const reductionPct = ((fullSize - scopedSize) / fullSize) * 100;
    
    // Verify matches (3 sections)
    assert.match(scopedResult, /## Database Patterns/, 'should include Database');
    assert.match(scopedResult, /## API Design/, 'should include API');
    assert.match(scopedResult, /## Security Guidelines/, 'should include Security');
    
    // With 3/9 sections, reduction should be ~67%
    assert.ok(
      reductionPct >= 40,
      `3 keywords should still achieve ≥40% reduction, got ${reductionPct.toFixed(1)}%`
    );
  });

  test("excerpt for S01 (no dependencies) achieves ≥40% reduction", () => {
    const excerptResult = formatRoadmapExcerpt(syntheticRoadmap, 'S01');
    
    const fullSize = syntheticRoadmap.length;
    const excerptSize = excerptResult.length;
    const reductionPct = ((fullSize - excerptSize) / fullSize) * 100;
    
    // S01 has no predecessor, so just 1 row + header + reference
    assert.match(excerptResult, /\| S01 \|/, 'should have S01');
    assert.ok(!excerptResult.includes('| S02 |'), 'should not have S02');
    
    // Single row should still achieve significant reduction
    assert.ok(
      reductionPct >= 40,
      `S01 excerpt should achieve ≥40% reduction, got ${reductionPct.toFixed(1)}%`
    );
  });
});
