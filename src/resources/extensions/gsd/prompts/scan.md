You are performing a focused codebase scan.

## Scan Parameters

- **Focus:** {{focus}}
- **Documents to produce:** {{documents}}
- **Output directory:** `{{outputDir}}`

## Working Directory

`{{workingDirectory}}`

## Instructions

1. Explore the codebase to understand its structure, technology choices, and patterns
2. For each document listed above, produce a well-structured Markdown file in `{{outputDir}}/`
3. Use the document schemas below as a guide for each output file

For this scan, only these documents are relevant: **{{documents}}**. Refer only to those schemas below and ignore the rest.

### Document Schemas

**STACK.md** — Technology stack overview
- Languages, runtimes, and versions
- Key frameworks and libraries (with versions where visible)
- Build tools and bundlers
- Package manager

**INTEGRATIONS.md** — External dependencies and integrations
- Third-party APIs and services
- Database systems
- Authentication providers
- Infrastructure and deployment platforms
- Communication services (email, messaging, etc.)

**ARCHITECTURE.md** — Architectural patterns and design decisions
- Overall architecture style (monolith, microservices, monorepo, etc.)
- Core data flow
- Key design patterns in use
- Module/package boundaries

**STRUCTURE.md** — Directory and code organization
- Top-level directory layout with purpose
- Source code organization
- Test organization
- Configuration file locations

**CONVENTIONS.md** — Coding conventions and standards
- Naming conventions (files, functions, variables)
- Code style and formatting rules
- Import/export patterns
- Error handling patterns
- TypeScript/language-specific conventions

**TESTING.md** — Testing patterns and practices
- Test framework(s) in use
- Test file naming and location conventions
- Test helper and fixture patterns
- Coverage requirements (if any)
- How to run tests

**CONCERNS.md** — Technical debt and risks
- Known areas of technical debt
- Fragile or high-risk code areas
- Missing test coverage
- Outdated dependencies
- Performance bottlenecks
- Security considerations

## Rules

- Write only the documents listed in **Documents to produce** — do not generate extra files
- Each document must be a clean, standalone Markdown file starting with a `# Heading`
- Be factual: report what you observe in the code, not what might be ideal
- Keep each document focused and scannable — use headers, bullet points, and code snippets
- Do NOT modify any source files
- After writing all documents, summarize what was produced (file names and line counts)

{{skillActivation}}
