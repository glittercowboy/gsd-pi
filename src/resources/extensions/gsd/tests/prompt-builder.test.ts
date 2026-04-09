/**
 * Prompt Builder Tests — Comprehensive tests for S02 components.
 *
 * Tests cover:
 * 1. Template validation (context-enhanced.md, discuss-prepared.md)
 * 2. Prompt loading and variable substitution
 * 3. Enhanced context validation (R109)
 * 4. Integration tests for format functions and prompt injection
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Template Paths ─────────────────────────────────────────────────────────────

const templatesDir = join(process.cwd(), "src/resources/extensions/gsd/templates");
const promptsDir = join(process.cwd(), "src/resources/extensions/gsd/prompts");

const contextEnhancedPath = join(templatesDir, "context-enhanced.md");
const contextPath = join(templatesDir, "context.md");
const discussPreparedPath = join(promptsDir, "discuss-prepared.md");

// ─── Template Tests ─────────────────────────────────────────────────────────────

describe("Template: context-enhanced.md", () => {
  test("file exists", () => {
    assert.ok(existsSync(contextEnhancedPath), "context-enhanced.md should exist");
  });

  test("contains all original context.md sections", () => {
    const contextEnhanced = readFileSync(contextEnhancedPath, "utf-8");
    const originalContext = readFileSync(contextPath, "utf-8");

    // Extract section headers from original context.md
    const originalSections = originalContext.match(/^## .+$/gm) ?? [];

    // Each original section should be present in context-enhanced.md
    for (const section of originalSections) {
      assert.ok(
        contextEnhanced.includes(section),
        `context-enhanced.md should contain original section: ${section}`,
      );
    }
  });

  test("contains new structured sections for prepared discussions", () => {
    const contextEnhanced = readFileSync(contextEnhancedPath, "utf-8");

    // New sections required by R108
    const newSections = [
      "## Codebase Brief",
      "## Architectural Decisions",
      "## Interface Contracts",
      "## Error Handling Strategy",
      "## Testing Requirements",
      "## Acceptance Criteria",
      "## Ecosystem Notes",
    ];

    for (const section of newSections) {
      assert.ok(
        contextEnhanced.includes(section),
        `context-enhanced.md should contain new section: ${section}`,
      );
    }
  });

  test("Codebase Brief has sub-sections", () => {
    const contextEnhanced = readFileSync(contextEnhancedPath, "utf-8");

    assert.ok(
      contextEnhanced.includes("### Technology Stack"),
      "Codebase Brief should have Technology Stack sub-section",
    );
    assert.ok(
      contextEnhanced.includes("### Key Modules"),
      "Codebase Brief should have Key Modules sub-section",
    );
    assert.ok(
      contextEnhanced.includes("### Patterns in Use"),
      "Codebase Brief should have Patterns in Use sub-section",
    );
  });

  test("Architectural Decisions has structured format guidance", () => {
    const contextEnhanced = readFileSync(contextEnhancedPath, "utf-8");

    // Check for decision structure markers
    assert.ok(
      contextEnhanced.includes("**Decision:**"),
      "Architectural Decisions should have Decision marker",
    );
    assert.ok(
      contextEnhanced.includes("**Rationale:**"),
      "Architectural Decisions should have Rationale marker",
    );
    assert.ok(
      contextEnhanced.includes("**Evidence:**"),
      "Architectural Decisions should have Evidence marker",
    );
    assert.ok(
      contextEnhanced.includes("**Alternatives Considered:**"),
      "Architectural Decisions should have Alternatives Considered marker",
    );
  });
});

describe("Template: discuss-prepared.md", () => {
  test("file exists", () => {
    assert.ok(existsSync(discussPreparedPath), "discuss-prepared.md should exist");
  });

  test("contains all three brief placeholders", () => {
    const discussPrepared = readFileSync(discussPreparedPath, "utf-8");

    assert.ok(
      discussPrepared.includes("{{codebaseBrief}}"),
      "discuss-prepared.md should contain {{codebaseBrief}} placeholder",
    );
    assert.ok(
      discussPrepared.includes("{{priorContextBrief}}"),
      "discuss-prepared.md should contain {{priorContextBrief}} placeholder",
    );
    assert.ok(
      discussPrepared.includes("{{ecosystemBrief}}"),
      "discuss-prepared.md should contain {{ecosystemBrief}} placeholder",
    );
  });

  test("contains 4-layer protocol markers", () => {
    const discussPrepared = readFileSync(discussPreparedPath, "utf-8");

    // Check for all four layer headings
    assert.ok(
      discussPrepared.includes("## Layer 1 — Scope"),
      "discuss-prepared.md should contain Layer 1 (Scope)",
    );
    assert.ok(
      discussPrepared.includes("## Layer 2 — Architecture"),
      "discuss-prepared.md should contain Layer 2 (Architecture)",
    );
    assert.ok(
      discussPrepared.includes("## Layer 3 — Error States"),
      "discuss-prepared.md should contain Layer 3 (Error States)",
    );
    assert.ok(
      discussPrepared.includes("## Layer 4 — Quality Bar"),
      "discuss-prepared.md should contain Layer 4 (Quality Bar)",
    );
  });

  test("contains gate question IDs for all layers", () => {
    const discussPrepared = readFileSync(discussPreparedPath, "utf-8");

    assert.ok(
      discussPrepared.includes("layer1_scope_gate"),
      "discuss-prepared.md should contain layer1_scope_gate question ID",
    );
    assert.ok(
      discussPrepared.includes("layer2_architecture_gate"),
      "discuss-prepared.md should contain layer2_architecture_gate question ID",
    );
    assert.ok(
      discussPrepared.includes("layer3_error_gate"),
      "discuss-prepared.md should contain layer3_error_gate question ID",
    );
    assert.ok(
      discussPrepared.includes("layer4_quality_gate"),
      "discuss-prepared.md should contain layer4_quality_gate question ID",
    );
  });

  test("contains context-enhanced template guidance", () => {
    const discussPrepared = readFileSync(discussPreparedPath, "utf-8");

    assert.ok(
      discussPrepared.includes("context-enhanced"),
      "discuss-prepared.md should reference context-enhanced template",
    );
  });
});

// ─── Prompt Loading Tests ───────────────────────────────────────────────────────

describe("Prompt Loading", () => {
  // Dynamic import to work with the module's warm cache
  test("loadPrompt substitutes all variables correctly", async () => {
    const { loadPrompt } = await import("../prompt-loader.ts");

    const result = loadPrompt("discuss-prepared", {
      preamble: "Test preamble",
      codebaseBrief: "Test codebase brief content",
      priorContextBrief: "Test prior context brief content",
      ecosystemBrief: "Test ecosystem brief content",
      milestoneId: "M001",
      contextPath: ".gsd/milestones/M001/M001-CONTEXT.md",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedTemplates: "Test templates",
      commitInstruction: "Test commit instruction",
      multiMilestoneCommitInstruction: "Test multi-milestone commit",
    });

    assert.ok(result.includes("Test codebase brief content"), "codebaseBrief should be substituted");
    assert.ok(result.includes("Test prior context brief content"), "priorContextBrief should be substituted");
    assert.ok(result.includes("Test ecosystem brief content"), "ecosystemBrief should be substituted");
    assert.ok(!result.includes("{{codebaseBrief}}"), "placeholder should not remain");
  });

  test("loadPrompt throws GSDError for missing variables", async () => {
    const { loadPrompt } = await import("../prompt-loader.ts");
    const { GSDError, GSD_PARSE_ERROR } = await import("../errors.ts");

    assert.throws(
      () => loadPrompt("discuss-prepared", {}), // Missing required variables
      (err: unknown) => {
        assert.ok(err instanceof GSDError, "should throw GSDError");
        assert.equal((err as InstanceType<typeof GSDError>).code, GSD_PARSE_ERROR, "should have GSD_PARSE_ERROR code");
        return true;
      },
    );
  });

  test("brief content with {{...}} patterns does not cause false variable errors", async () => {
    const { loadPrompt } = await import("../prompt-loader.ts");

    // Content that contains template-like patterns but should not be treated as variables
    const briefWithPatterns = `
## Tech Stack
- Framework: Uses \`{{slot}}\` placeholder syntax in templates
- Pattern: The codebase has \`{{variableName}}\` markers
`;

    // This should NOT throw, because {{slot}} and {{variableName}} are inside
    // the brief value, not undeclared placeholders in the template itself.
    const result = loadPrompt("discuss-prepared", {
      preamble: "Test",
      codebaseBrief: briefWithPatterns,
      priorContextBrief: "Test brief",
      ecosystemBrief: "Test brief",
      milestoneId: "M001",
      contextPath: ".gsd/milestones/M001/M001-CONTEXT.md",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedTemplates: "Test templates",
      commitInstruction: "Test commit instruction",
      multiMilestoneCommitInstruction: "Test multi-milestone commit",
    });

    assert.ok(result.includes("{{slot}}"), "template-like patterns in content should be preserved");
    assert.ok(result.includes("{{variableName}}"), "template-like patterns in content should be preserved");
  });
});

// ─── Validation Tests ───────────────────────────────────────────────────────────

describe("Enhanced Context Validation", () => {
  test("valid enhanced context passes validation", async () => {
    const { validateEnhancedContext } = await import("../prompt-validation.ts");

    const validContent = `
# M001: Test Milestone

## Why This Milestone

This is why we need this milestone.

## Architectural Decisions

### Decision 1

**Decision:** Use TypeScript
**Rationale:** Type safety

## Acceptance Criteria

- Criterion 1
- Criterion 2
`;

    const result = validateEnhancedContext(validContent);
    assert.equal(result.valid, true, "valid content should pass validation");
    assert.equal(result.missing.length, 0, "no missing sections");
  });

  test("missing scope section fails", async () => {
    const { validateEnhancedContext } = await import("../prompt-validation.ts");

    const contentMissingScope = `
# M001: Test Milestone

## Architectural Decisions

### Decision 1

**Decision:** Use TypeScript

## Acceptance Criteria

- Criterion 1
`;

    const result = validateEnhancedContext(contentMissingScope);
    assert.equal(result.valid, false, "should fail validation");
    assert.ok(
      result.missing.some((m) => m.includes("Scope") || m.includes("Why This Milestone")),
      "should report missing scope section",
    );
  });

  test("missing architectural decisions section fails", async () => {
    const { validateEnhancedContext } = await import("../prompt-validation.ts");

    const contentMissingDecisions = `
# M001: Test Milestone

## Why This Milestone

This is why we need this milestone.

## Acceptance Criteria

- Criterion 1
`;

    const result = validateEnhancedContext(contentMissingDecisions);
    assert.equal(result.valid, false, "should fail validation");
    assert.ok(
      result.missing.includes("Architectural Decisions"),
      "should report missing architectural decisions section",
    );
  });

  test("missing acceptance criteria section fails", async () => {
    const { validateEnhancedContext } = await import("../prompt-validation.ts");

    const contentMissingCriteria = `
# M001: Test Milestone

## Why This Milestone

This is why we need this milestone.

## Architectural Decisions

### Decision 1

**Decision:** Use TypeScript
`;

    const result = validateEnhancedContext(contentMissingCriteria);
    assert.equal(result.valid, false, "should fail validation");
    assert.ok(
      result.missing.includes("Acceptance Criteria"),
      "should report missing acceptance criteria section",
    );
  });

  test("empty architectural decisions section (no entries) fails", async () => {
    const { validateEnhancedContext } = await import("../prompt-validation.ts");

    const contentEmptyDecisions = `
# M001: Test Milestone

## Why This Milestone

This is why we need this milestone.

## Architectural Decisions

No decisions yet.

## Acceptance Criteria

- Criterion 1
`;

    const result = validateEnhancedContext(contentEmptyDecisions);
    assert.equal(result.valid, false, "should fail validation");
    assert.ok(
      result.missing.some((m) => m.includes("decision entry")),
      "should report missing decision entry",
    );
  });

  test("alternative scope headers are accepted", async () => {
    const { validateEnhancedContext } = await import("../prompt-validation.ts");

    // Test with ## Scope
    const withScope = `
## Scope

### In Scope
- Item 1

## Architectural Decisions

### Decision 1
**Decision:** Test

## Acceptance Criteria

- Criterion 1
`;
    assert.equal(validateEnhancedContext(withScope).valid, true, "## Scope should be accepted");

    // Test with ## Milestone Scope
    const withMilestoneScope = `
## Milestone Scope

This is the scope.

## Architectural Decisions

### Decision 1
**Decision:** Test

## Acceptance Criteria

- Criterion 1
`;
    assert.equal(
      validateEnhancedContext(withMilestoneScope).valid,
      true,
      "## Milestone Scope should be accepted",
    );
  });

  test("alternative acceptance criteria headers are accepted", async () => {
    const { validateEnhancedContext } = await import("../prompt-validation.ts");

    const withFinalIntegrated = `
## Why This Milestone

Test

## Architectural Decisions

### Decision 1
**Decision:** Test

## Final Integrated Acceptance

- Criterion 1
`;
    assert.equal(
      validateEnhancedContext(withFinalIntegrated).valid,
      true,
      "## Final Integrated Acceptance should be accepted",
    );
  });

  test("inline decision format is accepted", async () => {
    const { validateEnhancedContext } = await import("../prompt-validation.ts");

    const withInlineDecision = `
## Why This Milestone

Test

## Architectural Decisions

**Decision:** Use React for the frontend

## Acceptance Criteria

- Criterion 1
`;
    assert.equal(
      validateEnhancedContext(withInlineDecision).valid,
      true,
      "**Decision marker format should be accepted",
    );
  });
});

// ─── Integration Tests ──────────────────────────────────────────────────────────

describe("Integration: Format Functions", () => {
  test("formatCodebaseBrief produces non-empty output", async () => {
    const { formatCodebaseBrief } = await import("../preparation.ts");

    const brief = {
      techStack: {
        primaryLanguage: "TypeScript",
        detectedFiles: ["package.json", "tsconfig.json"],
        packageManager: "npm",
        isMonorepo: false,
        hasTests: true,
        hasCI: true,
      },
      moduleStructure: {
        topLevelDirs: ["src", "tests"],
        srcSubdirs: ["components", "utils"],
        totalFilesSampled: 5,
      },
      patterns: {
        asyncStyle: "async/await" as const,
        errorHandling: "try/catch" as const,
        namingConvention: "camelCase" as const,
        evidence: {
          asyncStyle: ["src/foo.ts: async/await (5 occurrences)"],
          errorHandling: ["src/bar.ts: try/catch (3 occurrences)"],
          namingConvention: ["camelCase: 50 occurrences"],
        },
        fileCounts: {
          asyncAwait: 3,
          promises: 0,
          callbacks: 0,
          tryCatch: 2,
          errorCallbacks: 0,
          resultTypes: 0,
        },
      },
      sampledFiles: ["src/index.ts", "src/utils.ts"],
    };

    const formatted = formatCodebaseBrief(brief);
    assert.ok(formatted.length > 0, "formatted brief should not be empty");
    assert.ok(formatted.includes("TypeScript"), "should include primary language");
    assert.ok(formatted.includes("async/await"), "should include async style");
  });

  test("formatPriorContextBrief produces non-empty output", async () => {
    const { formatPriorContextBrief } = await import("../preparation.ts");

    const brief = {
      decisions: {
        byScope: new Map([
          ["architecture", [{ id: "D001", scope: "architecture", decision: "Use SQLite", choice: "SQLite", rationale: "Simplicity" }]],
        ]),
        totalCount: 1,
      },
      requirements: {
        active: [{ id: "R001", description: "Test requirement", status: "active" as const }],
        validated: [],
        deferred: [],
        totalCount: 1,
      },
      knowledge: "Some knowledge entry",
      summaries: "M001 completed X and Y",
    };

    const formatted = formatPriorContextBrief(brief);
    assert.ok(formatted.length > 0, "formatted brief should not be empty");
    assert.ok(formatted.includes("Prior Decisions"), "should include decisions section");
    assert.ok(formatted.includes("D001"), "should include decision ID");
  });

  test("formatEcosystemBrief returns simplified message (research happens during discussion)", async () => {
    const { formatEcosystemBrief } = await import("../preparation.ts");

    // formatEcosystemBrief now returns a fixed message regardless of brief content
    // because ecosystem research happens during the discussion, not preparation
    const briefWithFindings = {
      available: true,
      queries: ["Next.js best practices 2024"],
      findings: [
        {
          query: "Next.js best practices 2024",
          title: "Server Components Guide",
          url: "https://example.com/guide",
          snippet: "Use Server Components for data fetching",
        },
      ],
      provider: "tavily",
    };

    const formatted = formatEcosystemBrief(briefWithFindings);
    assert.ok(formatted.length > 0, "formatted brief should not be empty");
    assert.ok(formatted.includes("Ecosystem Research"), "should include research heading");
    assert.ok(formatted.includes("during the discussion"), "should mention research happens during discussion");
  });

  test("formatEcosystemBrief returns same output for any brief state", async () => {
    const { formatEcosystemBrief } = await import("../preparation.ts");

    const briefUnavailable = {
      available: false,
      queries: [],
      findings: [],
      skippedReason: "No API key configured",
    };

    const briefAvailable = {
      available: true,
      queries: ["test"],
      findings: [],
      provider: "tavily",
    };

    const formatted1 = formatEcosystemBrief(briefUnavailable);
    const formatted2 = formatEcosystemBrief(briefAvailable);
    
    // Both should return the same simplified message
    assert.equal(formatted1, formatted2, "should return consistent output regardless of brief state");
    assert.ok(formatted1.includes("web search tools"), "should mention web search tools");
  });

  test("formatted briefs can be injected into prompt without errors", async () => {
    const { loadPrompt } = await import("../prompt-loader.ts");
    const { formatCodebaseBrief, formatPriorContextBrief, formatEcosystemBrief } = await import("../preparation.ts");

    // Create realistic briefs
    const codebaseBrief = formatCodebaseBrief({
      techStack: {
        primaryLanguage: "TypeScript",
        detectedFiles: ["package.json"],
        packageManager: "npm",
        isMonorepo: false,
        hasTests: true,
        hasCI: false,
      },
      moduleStructure: {
        topLevelDirs: ["src"],
        srcSubdirs: [],
        totalFilesSampled: 1,
      },
      patterns: {
        asyncStyle: "async/await" as const,
        errorHandling: "try/catch" as const,
        namingConvention: "camelCase" as const,
        evidence: { asyncStyle: [], errorHandling: [], namingConvention: [] },
        fileCounts: {
          asyncAwait: 0,
          promises: 0,
          callbacks: 0,
          tryCatch: 0,
          errorCallbacks: 0,
          resultTypes: 0,
        },
      },
      sampledFiles: [],
    });

    const priorContextBrief = formatPriorContextBrief({
      decisions: { byScope: new Map(), totalCount: 0 },
      requirements: { active: [], validated: [], deferred: [], totalCount: 0 },
      knowledge: "No prior knowledge recorded.",
      summaries: "No prior milestone summaries.",
    });

    const ecosystemBrief = formatEcosystemBrief({
      available: false,
      queries: [],
      findings: [],
      skippedReason: "Preparation disabled",
    });

    // Should not throw when injecting formatted briefs
    const result = loadPrompt("discuss-prepared", {
      preamble: "Test preamble",
      codebaseBrief,
      priorContextBrief,
      ecosystemBrief,
      milestoneId: "M001",
      contextPath: ".gsd/milestones/M001/M001-CONTEXT.md",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedTemplates: "Test templates",
      commitInstruction: "Do not commit",
      multiMilestoneCommitInstruction: "Do not commit",
    });

    assert.ok(result.includes("TypeScript"), "codebase brief should be present");
    assert.ok(result.includes("Prior Decisions"), "prior context brief should be present");
    // formatEcosystemBrief now returns a fixed message about research during discussion
    assert.ok(result.includes("during the discussion"), "ecosystem brief should be present");
  });
});
