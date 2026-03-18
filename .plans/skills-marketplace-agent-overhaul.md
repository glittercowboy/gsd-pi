# Skills / Marketplace / Plugin / Agent System Overhaul

**Created**: 2026-03-18
**Status**: Draft — Awaiting Discussion
**Scope**: Full architectural overhaul of the skills, marketplace, plugin, and agent subsystems

---

## Executive Summary

GSD-2 has grown organically into a powerful system with skills, agents, plugins, and marketplace capabilities — but these subsystems evolved independently and now have overlapping concerns, inconsistent APIs, and fragmented discovery/resolution paths. This plan proposes a unified architecture that:

1. Consolidates skills, agents, and plugins under a single **Component** abstraction
2. Builds a proper **Registry** with versioning, dependency resolution, and trust
3. Creates a real **Marketplace** with remote fetching, search, and update lifecycle
4. Adds a **Composition Engine** for building complex workflows from primitives
5. Improves **Developer Experience** for authoring custom components

---

## Current State Analysis

### What Exists Today

| Subsystem | Location | Format | Discovery | Status |
|-----------|----------|--------|-----------|--------|
| **Skills** | `~/.gsd/agent/skills/`, `.gsd/skills/` | `SKILL.md` w/ YAML frontmatter | File-walk at startup + runtime snapshot/diff | Production, solid |
| **Agents** | `~/.gsd/agent/agents/`, `.gsd/agents/` | `.md` w/ YAML frontmatter | File-walk, scoped (user/project/both) | Production, basic |
| **Extensions** | `src/resources/extensions/` | TypeScript modules w/ `ExtensionAPI` | `package.json` → `pi.extensions` or index.ts fallback | Production, mature |
| **Marketplace** | `~/.claude/plugins/marketplaces/` | `marketplace.json` → `plugin.json` | Four-stage pipeline (discover→select→validate→commit) | Production, early |
| **Plugin Import** | `plugin-importer.ts` + friends | Namespaced registry | Three-tier resolution (canonical→local→shorthand) | Production, early |
| **Claude Import** | `claude-import.ts` | Claude plugin format | Walk Claude skill/plugin dirs | Production, bridge |

### Pain Points

1. **Three separate discovery paths** — skills, agents, and plugins each have their own directory walking, frontmatter parsing, and resolution logic
2. **No dependency model** — skills can't declare they need other skills, agents, or MCP servers
3. **No versioning** — no way to pin, update, or roll back skill/agent versions
4. **Marketplace is read-only** — can discover and import, but no publish, update, or sync
5. **Agent ↔ Skill boundary is blurry** — agents are essentially skills with tool restrictions and a model override
6. **No composition** — can't build a "security-audit-pipeline" that chains scout → security-review → security-audit → report
7. **Trust model is implicit** — project vs. user scope, but no signing, checksums, or sandboxing
8. **No search/browse** — CLI browsing of available components is limited
9. **Telemetry is skill-only** — agents and extensions don't have health/performance tracking
10. **No hot-reload** — installing a new skill mid-session requires snapshot/diff hack

---

## Proposed Architecture

### Phase 1: Unified Component Model

**Goal**: Single abstraction for all installable/discoverable units.

#### 1.1 Component Spec (`component.yaml`)

Replace `SKILL.md` frontmatter, agent `.md` frontmatter, and `plugin.json` with a single spec:

```yaml
# component.yaml
apiVersion: gsd/v1
kind: skill | agent | pipeline | extension | mcp-server
metadata:
  name: security-audit
  namespace: gsd              # optional, defaults to "local"
  version: 1.2.0
  description: "Comprehensive security audit with OWASP coverage"
  author:
    name: "GSD Team"
    email: "team@gsd.dev"
  tags: [security, audit, owasp]
  license: MIT
spec:
  # For skills
  prompt: ./SKILL.md           # prompt content file

  # For agents
  model: claude-sonnet-4-6     # optional model override
  tools: [bash, read, grep, glob]
  systemPrompt: ./AGENT.md

  # For pipelines (new!)
  steps:
    - component: scout
      task: "Find all auth-related code"
      output: auth_files
    - component: security-review
      task: "Review {auth_files} for vulnerabilities"
      output: findings
    - component: worker
      task: "Generate report from {findings}"

  # Dependencies
  requires:
    skills: [code-review]       # must be installed
    mcpServers: [sqlite]        # MCP server dependency

  # Compatibility
  compatibility:
    gsd: ">=2.28.0"
    node: ">=22.0.0"

  # Configuration schema (optional)
  config:
    type: object
    properties:
      severity_threshold:
        type: string
        enum: [low, medium, high, critical]
        default: medium
```

#### 1.2 Backward Compatibility

- **SKILL.md with frontmatter** → auto-converted to `component.yaml` + `SKILL.md` (prompt-only)
- **Agent .md files** → auto-converted to `component.yaml` + `AGENT.md`
- **Conversion is lazy** — old format still loads, new format preferred
- **Migration command**: `/gsd components migrate` to batch-convert

#### 1.3 Component Directory Layout

```
~/.gsd/components/
├── skills/
│   └── security-audit/
│       ├── component.yaml
│       ├── SKILL.md
│       └── references/
│           └── owasp-top-10.md
├── agents/
│   └── scout/
│       ├── component.yaml
│       └── AGENT.md
├── pipelines/
│   └── full-security-scan/
│       └── component.yaml
└── registry.json              # local index cache
```

---

### Phase 2: Unified Registry

**Goal**: Single registry that handles discovery, resolution, and lifecycle for all component types.

#### 2.1 Registry Architecture

```
ComponentRegistry
├── LocalStore          — disk-backed component index
│   ├── UserStore       — ~/.gsd/components/
│   └── ProjectStore    — .gsd/components/
├── RemoteStore         — marketplace HTTP clients
│   ├── OfficialStore   — registry.gsd.dev (future)
│   └── CustomStores    — user-added marketplace URLs
├── Resolver            — namespaced resolution (existing, enhanced)
├── DependencyResolver  — DAG-based dependency resolution
├── VersionManager      — semver comparison, pinning, ranges
└── TrustManager        — signature verification, checksums
```

#### 2.2 Resolution Precedence (Enhanced)

1. **Explicit version pin** — `security-audit@1.2.0`
2. **Project-local** — `.gsd/components/`
3. **User-global** — `~/.gsd/components/`
4. **Namespace-qualified** — `gsd:security-audit`
5. **Shorthand** — `security-audit` (unique match required)
6. **Remote fallback** — search marketplace if `auto-install: true`

#### 2.3 Registry Commands

```bash
/gsd components list                    # list all installed
/gsd components list --type=skill       # filter by type
/gsd components list --outdated         # show updatable
/gsd components search "security"       # search local + remote
/gsd components info security-audit     # detailed info
/gsd components install gsd:security-audit@^1.0
/gsd components update                  # update all
/gsd components update security-audit   # update one
/gsd components uninstall security-audit
/gsd components create --type=skill     # scaffold new component
/gsd components validate ./my-skill/    # validate component.yaml
/gsd components migrate                 # convert old format → new
```

---

### Phase 3: Marketplace v2

**Goal**: Full lifecycle marketplace with remote sources, publishing, and sync.

#### 3.1 Marketplace Sources

```yaml
# ~/.gsd/marketplace-sources.yaml
sources:
  - name: official
    url: https://registry.gsd.dev/v1
    trust: verified

  - name: community
    url: https://github.com/gsd-community/marketplace
    type: github-releases        # or: git, http, local
    trust: community

  - name: company-internal
    url: https://git.company.com/gsd-plugins
    type: git
    trust: trusted
    auth: env:COMPANY_GIT_TOKEN

  - name: local-dev
    path: ~/my-gsd-plugins/
    type: local
    trust: trusted
```

#### 3.2 Marketplace Protocol

**Discovery API** (for HTTP sources):
```
GET /v1/components?q=security&type=skill&sort=downloads
GET /v1/components/{namespace}/{name}
GET /v1/components/{namespace}/{name}/versions
GET /v1/components/{namespace}/{name}/{version}/download
```

**Git-based sources** (for GitHub/GitLab):
- Read `marketplace.json` from repo root (existing format, enhanced)
- Support releases as version anchors
- Support subdirectory-per-component layout

**Local sources**:
- Direct file-walk (existing behavior, unified under new registry)

#### 3.3 Install & Sync Flow

```
gsd components install gsd:security-audit

1. Resolve source → find component in marketplace index
2. Fetch component.yaml → validate schema
3. Resolve dependencies → build install DAG
4. Download artifacts → verify checksums
5. Install to ~/.gsd/components/skills/security-audit/
6. Update registry.json index
7. Emit installed event → skill-discovery picks up immediately
```

#### 3.4 Publishing (Future)

```bash
/gsd components publish                 # publish to configured source
/gsd components pack                    # create distributable tarball
```

---

### Phase 4: Agent System Overhaul

**Goal**: Elevate agents from "skills with tool restrictions" to a first-class, configurable execution model with routing, composition, specialization, and lifecycle management.

#### 4.1 Agent Definition (Enhanced)

Current agents are flat `.md` files with minimal frontmatter. The new system supports rich configuration:

```yaml
# component.yaml (kind: agent)
apiVersion: gsd/v1
kind: agent
metadata:
  name: db-migrator
  description: "Database migration specialist with rollback safety"
  tags: [database, migration, sql, safety]
  version: 1.0.0
spec:
  # Execution configuration
  model: claude-sonnet-4-6
  model_fallbacks: [claude-haiku-4-5]
  tools:
    allow: [bash, read, write, edit, grep, glob]
    deny: [web-search, browser]             # explicit deny list
  max_turns: 25                              # prevent runaway agents
  max_tokens: 100000                         # budget cap per invocation
  timeout_minutes: 10                        # hard timeout

  # Behavioral configuration
  systemPrompt: ./AGENT.md                   # prompt file
  temperature: 0.3                           # optional temperature override
  thinking: standard                         # off | minimal | standard | full
  output_format: structured                  # text | structured | markdown

  # Context injection
  context:
    always_include:
      - ./references/migration-patterns.md
      - ./references/rollback-checklist.md
    inject_project_context: true             # include project files
    inject_git_status: true                  # include current git state

  # Isolation
  isolation: worktree                        # none | worktree | container (future)
  merge_strategy: patch                      # patch | squash | manual

  # Chaining
  accepts_input: true                        # can receive {previous} from chain
  output_schema:                             # structured output contract
    type: object
    properties:
      files_changed:
        type: array
        items: { type: string }
      summary:
        type: string
      success:
        type: boolean

  # Skill dependencies
  requires:
    skills: [test]                           # needs test skill available
```

#### 4.2 Agent Routing & Auto-Selection

Today agents are manually specified. The new system adds intelligent routing:

```yaml
# In preferences.md or component.yaml
agent_routing:
  rules:
    - when: "task involves database migrations"
      use: db-migrator
      confidence: high

    - when: "task requires web research or finding documentation"
      use: researcher
      confidence: medium

    - when: "task is a code review or PR review"
      use: reviewer
      confidence: high

    - when: "task involves exploring unfamiliar codebase"
      use: scout
      confidence: high

  fallback: worker                           # default agent when no rule matches
  auto_route: suggest                        # off | suggest | auto
```

**Routing flow**:
1. User invokes `/subagent` with a task description
2. Router scores task against all agent routing rules
3. `suggest` mode: proposes agent, user confirms
4. `auto` mode: selects highest-confidence match
5. Falls back to `worker` if no match

#### 4.3 Agent Teams & Roles

Formalize the concept of agent teams for complex tasks:

```yaml
# component.yaml (kind: agent-team)
apiVersion: gsd/v1
kind: agent-team
metadata:
  name: security-response-team
  description: "Coordinated security audit with specialized agents"
spec:
  members:
    - agent: scout
      role: reconnaissance
      task: "Map attack surface and find security-relevant code"
      output: attack_surface

    - agent: security-reviewer
      role: static-analysis
      task: "Analyze {attack_surface} for OWASP Top 10 vulnerabilities"
      output: findings
      parallel: true

    - agent: security-auditor
      role: dependency-audit
      task: "Audit all dependencies for known CVEs"
      output: dep_findings
      parallel: true

    - agent: worker
      role: reporter
      task: "Consolidate {findings} and {dep_findings} into prioritized report"
      depends_on: [static-analysis, dependency-audit]

  coordination:
    max_parallel: 3
    timeout_minutes: 30
    budget_ceiling: 5.00
    on_failure: continue                     # continue | stop | retry
```

#### 4.4 Agent Specialization Inheritance

Agents can extend other agents, adding or overriding configuration:

```yaml
# db-migrator-postgres inherits from db-migrator
apiVersion: gsd/v1
kind: agent
metadata:
  name: db-migrator-postgres
  description: "PostgreSQL-specific migration specialist"
spec:
  extends: db-migrator                       # inherit base agent config
  context:
    always_include:
      - ./references/postgres-specifics.md   # adds to parent's context
  tools:
    allow: [bash, read, write, edit, grep, glob, sql]  # overrides parent
```

#### 4.5 Agent Lifecycle & Health

Extend the skill-health system to agents:

```bash
/gsd agent health
# ┌─────────────────┬─────────┬──────────┬──────────┬───────────┬────────┐
# │ Agent           │ Success │ Avg Cost │ Avg Turns│ Avg Time  │ Status │
# ├─────────────────┼─────────┼──────────┼──────────┼───────────┼────────┤
# │ scout           │  98%    │ $0.03    │ 3.2      │ 12s       │ ✓      │
# │ researcher      │  91%    │ $0.18    │ 8.1      │ 45s       │ ✓      │
# │ db-migrator     │  85%    │ $0.22    │ 6.4      │ 38s       │ ⚠      │
# │ worker          │  94%    │ $0.15    │ 5.5      │ 30s       │ ✓      │
# └─────────────────┴─────────┴──────────┴──────────┴───────────┴────────┘

/gsd agent history db-migrator
# Shows last N invocations with task, outcome, cost, duration

/gsd agent tune db-migrator
# AI-assisted optimization:
# - Analyzes failure patterns
# - Suggests prompt improvements
# - Recommends tool/model changes
# - Proposes routing rule updates
```

#### 4.6 Agent Management Commands

```bash
# Creation (detailed in Phase 5)
/gsd agent new                              # interactive wizard
/gsd agent generate "description..."        # AI-assisted creation

# Discovery & info
/gsd agent list                             # all agents with source/scope
/gsd agent list --scope=project             # project-local only
/gsd agent info scout                       # full config + health + history

# Editing
/gsd agent edit db-migrator                 # open AGENT.md in $EDITOR
/gsd agent edit db-migrator --ai            # AI-assisted editing
/gsd agent config db-migrator               # edit component.yaml config

# Testing
/gsd agent test db-migrator                 # validate config + dry-run
/gsd agent test db-migrator --live "migrate users table to add email column"

# Lifecycle
/gsd agent enable db-migrator               # activate
/gsd agent disable db-migrator              # deactivate without removing
/gsd agent remove db-migrator               # uninstall
/gsd agent export db-migrator               # shareable tarball
/gsd agent import ./db-migrator.tar.gz      # import from tarball

# Debugging
/gsd agent debug db-migrator                # resolution path, config, metrics
/gsd agent logs db-migrator                 # recent execution logs
/gsd agent diff db-migrator                 # compare local vs marketplace version
```

#### 4.7 Built-in Agent Enhancements

Upgrade the 5 bundled agents with the new system:

| Agent | Current | Enhanced |
|-------|---------|----------|
| **scout** | Basic recon | + routing rules, structured output contract, thoroughness config |
| **researcher** | Web research | + source preferences, citation format, fact-checking mode |
| **worker** | Generic executor | + task classification, auto-tool-selection, isolation defaults |
| **javascript-pro** | JS guidance | + framework detection, version-aware advice, test generation |
| **typescript-pro** | TS guidance | + strict mode awareness, type complexity analysis, migration help |

Add new bundled agents:
- **reviewer** — code review with configurable dimensions (security, perf, style, tests)
- **debugger** — hypothesis-driven debugging with evidence collection
- **planner** — task decomposition and dependency analysis
- **documenter** — generates docs from code analysis

---

### Phase 5: Composition Engine

**Goal**: Enable building complex workflows from component primitives.

#### 4.1 Pipeline Components

A new `kind: pipeline` component type that composes other components:

```yaml
apiVersion: gsd/v1
kind: pipeline
metadata:
  name: full-security-scan
  description: "End-to-end security audit pipeline"
spec:
  inputs:
    target_dir:
      type: string
      default: "."
      description: "Directory to scan"

  steps:
    - id: discover
      component: scout
      task: "Find all security-relevant files in {inputs.target_dir}"
      output: security_files

    - id: dep-audit
      component: security-audit
      task: "Audit dependencies for known vulnerabilities"
      output: dep_findings
      parallel: true           # can run alongside next step

    - id: code-review
      component: security-review
      task: "Review {discover.security_files} for vulnerabilities"
      output: code_findings
      parallel: true

    - id: report
      component: worker
      task: |
        Generate a consolidated security report combining:
        - Dependency findings: {dep-audit.dep_findings}
        - Code findings: {code-review.code_findings}
      depends_on: [dep-audit, code-review]

  outputs:
    report: "{report.output}"
```

#### 4.2 Pipeline Runtime

- Pipelines execute as a series of subagent calls
- `parallel: true` steps run concurrently (respecting max concurrency)
- `depends_on` creates explicit ordering
- Variable interpolation passes context between steps
- Each step gets an isolated agent context
- Pipeline-level timeout and budget limits

#### 4.3 Pipeline Commands

```bash
/gsd pipeline run full-security-scan --target_dir=src/
/gsd pipeline list
/gsd pipeline history                   # past executions
/gsd pipeline create                    # interactive scaffold
```

---

### Phase 5: Authoring & Developer Experience

**Goal**: Make it easy for users to create, iterate on, test, and share custom skills and agents.

#### 5.1 Interactive Creation Wizard

```bash
/gsd skill new
/gsd agent new
/gsd pipeline new
```

Each launches an interactive flow:

**Skill Creation (`/gsd skill new`)**:
```
? Skill name: clerk-auth-patterns
? Short description: Authentication patterns for Clerk in Next.js apps
? Scope: (project / global)  → project
? Tags (comma-separated): auth, clerk, nextjs
? Add reference docs? (y/n) → y
  ? Path or URL: https://clerk.com/docs/quickstarts/nextjs
    → Fetches and saves to references/clerk-nextjs-quickstart.md

Creating .gsd/skills/clerk-auth-patterns/
  ├── component.yaml     ✓
  ├── SKILL.md            ✓ (template with best-practice structure)
  └── references/
      └── clerk-nextjs-quickstart.md  ✓

✓ Skill created! Edit SKILL.md to add your prompt instructions.
  Run: /gsd skill edit clerk-auth-patterns
```

**Agent Creation (`/gsd agent new`)**:
```
? Agent name: db-migrator
? Short description: Database migration specialist with rollback safety
? Model override: (default / sonnet / opus / haiku) → sonnet
? Allowed tools: (multi-select)
  ✓ bash
  ✓ read
  ✓ write
  ✓ edit
  ✓ grep
  ✓ glob
  ○ web-search
  ○ browser
? Scope: (project / global) → global

Creating ~/.gsd/agents/db-migrator/
  ├── component.yaml     ✓
  └── AGENT.md            ✓ (template with role/constraints/examples)

✓ Agent created! Edit AGENT.md to define behavior.
  Run: /gsd agent edit db-migrator
```

#### 5.2 AI-Assisted Authoring

Users can describe what they want in natural language and GSD generates the component:

```bash
/gsd skill generate "I want a skill that helps me write Terraform modules
  following our company's tagging standards and naming conventions. We use
  AWS and require cost tags on every resource."
```

This triggers an AI-powered flow:
1. Parses the user's intent
2. Generates `component.yaml` with appropriate metadata and tags
3. Generates `SKILL.md` with structured prompt content:
   - Role definition
   - Key constraints and rules
   - Example patterns
   - Common mistakes to avoid
4. Asks the user to review and refine
5. Optionally fetches reference docs (Terraform provider docs, etc.)

Same for agents:
```bash
/gsd agent generate "A code reviewer that focuses on SQL injection
  vulnerabilities and always checks parameterized queries"
```

#### 5.3 Skill/Agent Editing

```bash
/gsd skill edit clerk-auth-patterns     # opens SKILL.md in $EDITOR
/gsd skill edit clerk-auth-patterns --ai
  # AI-assisted editing session:
  # - Shows current SKILL.md content
  # - User describes changes in natural language
  # - AI rewrites and shows diff
  # - User approves or iterates
```

#### 5.4 Skill/Agent from Session Learning

After a productive session, users can capture the patterns into a reusable skill:

```bash
/gsd skill capture
```

This analyzes the current session's conversation and:
1. Identifies recurring patterns, instructions, and constraints
2. Extracts domain-specific rules the user established
3. Proposes a skill name and description
4. Generates a SKILL.md draft from the session context
5. User reviews, edits, and saves

Example flow:
```
Analyzing session... Found 3 recurring patterns:

1. "Always use parameterized queries with pg-promise"
2. "Check for N+1 queries in any ORM usage"
3. "Wrap all DB calls in transaction blocks"

? Create skill from these patterns? (y/n) → y
? Skill name: database-safety
? Include all 3 patterns? (y/n) → y

✓ Created .gsd/skills/database-safety/SKILL.md
  Review and refine: /gsd skill edit database-safety
```

#### 5.5 Component Listing & Management

```bash
/gsd skill list                         # list all installed skills
/gsd skill list --scope=project         # project-local only
/gsd agent list                         # list all agents
/gsd skill info clerk-auth-patterns     # show detail + health metrics
/gsd skill remove clerk-auth-patterns   # uninstall
/gsd skill export clerk-auth-patterns   # export as shareable tarball
/gsd skill import ./clerk-auth.tar.gz   # import from tarball
```

#### 5.6 Scaffolding Templates

Pre-built templates for common component types:

```bash
/gsd skill new --template=language      # language-specific coding skill
/gsd skill new --template=framework     # framework patterns skill
/gsd skill new --template=review        # code review skill
/gsd skill new --template=security      # security-focused skill
/gsd agent new --template=specialist    # domain specialist agent
/gsd agent new --template=reviewer      # review-focused agent
/gsd agent new --template=researcher    # web research agent
```

Each template includes:
- Pre-structured `SKILL.md` / `AGENT.md` with section headers and guidance comments
- Appropriate default tool selections (for agents)
- Suggested tags and metadata
- Example reference doc structure

#### 5.7 Testing & Validation

```bash
/gsd skill test clerk-auth-patterns
# Runs:
# 1. Schema validation on component.yaml
# 2. Format validation on SKILL.md (frontmatter, sections, length)
# 3. Prompt quality checks:
#    - Too vague? (< 100 chars of instruction)
#    - Too long? (> 50K chars, may hurt performance)
#    - Missing key sections? (role, constraints, examples)
# 4. Dependency resolution check
# 5. Token estimation (how much context this skill consumes)
# 6. Dry-run invocation with test fixture (if provided)

/gsd skill test clerk-auth-patterns --live
# Runs the skill against a real task to verify it works as expected
# Uses a sandboxed agent session

/gsd pipeline test my-pipeline --dry-run
# Validates DAG, checks all referenced components exist, estimates cost
```

#### 5.8 Component Debugging & Introspection

```bash
/gsd skill debug security-audit
# Shows:
# - Resolution path (how it was found)
# - Effective config (after preference merging)
# - Health metrics (success rate, token trends, cost per use)
# - Recent invocation history with outcomes
# - Token footprint (how much context it adds)
# - Dependency tree
# - Conflict check (any name collisions?)

/gsd skill diff security-audit
# If installed from marketplace, shows diff between local and latest remote version
```

#### 5.9 Documentation Generation

```bash
/gsd components docs
# Generates a local component catalog:
# - Component list grouped by type (skills / agents / pipelines)
# - Dependency graph visualization
# - Usage statistics and health summary
# - Configuration reference
# - Outputs to .gsd/COMPONENTS.md
```

---

### Phase 6: Trust & Security

**Goal**: Protect users from malicious or broken components.

#### 6.1 Trust Levels

| Level | Source | Verification | Capabilities |
|-------|--------|-------------|--------------|
| **builtin** | Bundled with GSD | N/A | Full access |
| **verified** | Official marketplace | Signature + review | Full access |
| **trusted** | User-marked | Checksum | Full access |
| **community** | Community marketplace | Checksum only | Prompt-only (no bash/write) |
| **untrusted** | Unknown source | None | Read-only tools |

#### 6.2 Security Features

- **Checksum verification**: SHA-256 hash stored in registry, verified on load
- **Tool sandboxing**: Community/untrusted components restricted to safe tools
- **Prompt injection detection**: Scan component prompts for known injection patterns
- **Audit log**: Track all component installs, updates, and removals
- **Quarantine**: Auto-disable components with <50% success rate after 20+ uses

---

### Phase 7: Telemetry & Observability (Enhanced)

**Goal**: Extend skill-health patterns to all component types.

#### 7.1 Unified Metrics

```typescript
interface ComponentMetrics {
  componentId: string;
  type: 'skill' | 'agent' | 'pipeline' | 'extension';
  invocations: number;
  successRate: number;           // 0-1
  avgTokensInput: number;
  avgTokensOutput: number;
  avgCost: number;
  avgDuration: number;           // ms
  lastUsed: string;              // ISO date
  trendDirection: 'improving' | 'stable' | 'declining';

  // Pipeline-specific
  avgStepsCompleted?: number;
  avgStepsTotal?: number;
  bottleneckStep?: string;       // slowest step ID
}
```

#### 7.2 Health Dashboard

```bash
/gsd components health
# ┌─────────────────────┬────────┬─────────┬──────────┬────────┐
# │ Component           │ Type   │ Success │ Avg Cost │ Status │
# ├─────────────────────┼────────┼─────────┼──────────┼────────┤
# │ security-audit      │ skill  │  94%    │ $0.12    │ ✓      │
# │ scout               │ agent  │  98%    │ $0.03    │ ✓      │
# │ full-security-scan  │ pipe   │  87%    │ $0.45    │ ⚠      │
# │ deprecated-lint     │ skill  │  45%    │ $0.08    │ ✗      │
# └─────────────────────┴────────┴─────────┴──────────┴────────┘
```

---

## Implementation Roadmap

### Wave 1: Foundation (Component Model + Registry)
**Estimated Complexity**: Large

1. Define `component.yaml` JSON schema + TypeScript types
2. Build `ComponentLoader` that handles both old and new formats
3. Implement `LocalStore` (user + project scopes)
4. Migrate existing `NamespacedRegistry` → unified `ComponentRegistry`
5. Add backward-compatible shim for `SKILL.md` / agent `.md` loading
6. Wire new registry into skill-discovery and subagent systems
7. Add `/gsd components list|info|validate|migrate` commands
8. Tests for all new code paths + regression tests for existing behavior

### Wave 2: Marketplace v2
**Estimated Complexity**: Large

1. Define marketplace source config format
2. Implement `RemoteStore` with HTTP + Git + local backends
3. Build `DependencyResolver` for install DAG
4. Implement `VersionManager` with semver support
5. Add `/gsd components install|update|uninstall|search` commands
6. Implement checksum verification
7. Add marketplace source management commands
8. Tests for remote fetching, dependency resolution, version pinning

### Wave 3: Agent System Overhaul
**Estimated Complexity**: Large

**3a — Enhanced Agent Definition & Config**
1. Extend agent `component.yaml` spec (model, tools allow/deny, max_turns, timeout, isolation)
2. Build agent config validation + schema
3. Implement context injection (always_include references, project context, git status)
4. Add structured output contracts (output_schema)
5. Implement agent specialization inheritance (`extends:` field)
6. Migrate 5 bundled agents to enhanced format
7. Tests for config parsing, inheritance resolution, context injection

**3b — Agent Routing & Auto-Selection**
1. Build agent routing engine (rule matching, confidence scoring)
2. Implement routing modes: `off`, `suggest`, `auto`
3. Add routing rules to preferences system
4. Wire routing into subagent tool invocation
5. Add routing rule CRUD commands
6. Tests for rule matching, fallback behavior, confidence ordering

**3c — Agent Teams & Coordination**
1. Define `kind: agent-team` component spec
2. Build team orchestrator (member dispatch, parallel execution, dependency ordering)
3. Implement coordination config (max_parallel, timeout, budget, on_failure)
4. Wire into subagent parallel/chain execution modes
5. Add `/gsd agent team` commands (run, list, history)
6. Tests for team execution, failure handling, budget enforcement

**3d — Agent Lifecycle & Health**
1. Extend telemetry to track agent invocations (success, cost, turns, duration)
2. Build `/gsd agent health` dashboard
3. Add `/gsd agent history` invocation log
4. Implement `/gsd agent tune` — AI-assisted optimization suggestions
5. Add agent enable/disable without removal
6. Tests for metrics collection, health reporting

**3e — New Bundled Agents**
1. Build `reviewer` agent — multi-dimension code review
2. Build `debugger` agent — hypothesis-driven debugging
3. Build `planner` agent — task decomposition
4. Build `documenter` agent — code → documentation generation
5. Add routing rules for all new agents
6. Tests for each new agent's output contracts

### Wave 4: Composition Engine
**Estimated Complexity**: Medium

1. Define pipeline spec schema
2. Build pipeline parser + DAG validator
3. Implement pipeline runtime (sequential + parallel steps)
4. Wire into subagent execution system
5. Add `/gsd pipeline run|list|create` commands
6. Add variable interpolation between steps
7. Tests for DAG validation, execution ordering, error handling

### Wave 5: Authoring & Developer Experience
**Estimated Complexity**: Large

**5a — Interactive Creation (core)**
1. Build interactive wizard flow for `/gsd skill new` and `/gsd agent new`
2. Implement scope selection (project vs global) with directory creation
3. Build scaffolding templates (language, framework, review, security, specialist, researcher)
4. Implement reference doc fetching (URL → markdown conversion + save)
5. Add `/gsd skill list`, `/gsd agent list`, `/gsd skill info`, `/gsd skill remove`
6. Add `/gsd skill export` / `/gsd skill import` for sharing tarballs
7. Tests for wizard flow, template generation, reference fetching

**5b — AI-Assisted Authoring**
1. Implement `/gsd skill generate` — natural language → SKILL.md generation
2. Implement `/gsd agent generate` — natural language → AGENT.md generation
3. Build `/gsd skill edit --ai` / `/gsd agent edit --ai` — conversational editing
4. Implement `/gsd skill capture` — session analysis → skill extraction
5. Implement `/gsd agent capture` — session analysis → agent extraction (identifies delegation patterns)
6. Add prompt quality scoring (length, specificity, section coverage)
7. Tests for generation quality, capture accuracy

**5c — Testing & Debugging**
1. Build component test runner (`/gsd skill test`, `/gsd agent test`)
2. Add schema + format + prompt quality validation
3. Implement `--live` test mode (sandboxed agent invocation with sample task)
4. Add `/gsd skill debug` and `/gsd agent debug` introspection commands
5. Add `/gsd skill diff` / `/gsd agent diff` for marketplace version comparison
6. Build `/gsd components docs` catalog generator
7. Tests for validation, dry-run, debug output

### Wave 6: Trust & Security + Telemetry
**Estimated Complexity**: Medium

1. Implement trust level system
2. Add tool sandboxing per trust level
3. Extend telemetry to all component types
4. Build unified health dashboard
5. Add audit logging
6. Quarantine system for failing components
7. Tests for trust enforcement, sandboxing, metrics

---

## Migration Strategy

1. **No breaking changes** — old `SKILL.md` / agent `.md` formats continue to work indefinitely
2. **Gradual adoption** — new features only available with `component.yaml` format
3. **Auto-detection** — loader checks for `component.yaml` first, falls back to legacy
4. **Migration tool** — `/gsd components migrate` converts in-place with backup
5. **Bundled components** — ship both formats during transition, drop legacy in v3.0

---

## Open Questions

1. **Remote marketplace hosting** — self-hosted registry vs. GitHub-based vs. both?
2. **Component signing** — GPG keys, or simpler HMAC-based approach?
3. **Pipeline persistence** — should pipeline execution state survive crashes?
4. **Extension-as-component** — should TypeScript extensions also use `component.yaml`?
5. **Cross-component config** — how do pipeline steps pass structured data (not just text)?
6. **Community governance** — who reviews community marketplace submissions?
7. **Monetization** — paid components in marketplace? (probably not, but worth discussing)
8. **Claude Code alignment** — how closely should we track Claude Code's plugin format evolution?

---

## Files That Will Be Modified/Created

### New Files
- `src/resources/extensions/gsd/component-types.ts` — unified type definitions
- `src/resources/extensions/gsd/component-loader.ts` — multi-format loader
- `src/resources/extensions/gsd/component-registry.ts` — unified registry
- `src/resources/extensions/gsd/component-store.ts` — local/remote store
- `src/resources/extensions/gsd/component-resolver.ts` — enhanced resolution
- `src/resources/extensions/gsd/dependency-resolver.ts` — DAG resolution
- `src/resources/extensions/gsd/version-manager.ts` — semver operations
- `src/resources/extensions/gsd/trust-manager.ts` — trust levels + verification
- `src/resources/extensions/gsd/agent-router.ts` — agent routing engine (rule matching, confidence scoring)
- `src/resources/extensions/gsd/agent-team-runtime.ts` — agent team orchestrator
- `src/resources/extensions/gsd/agent-config.ts` — enhanced agent config parsing, inheritance resolution
- `src/resources/extensions/gsd/agent-commands.ts` — agent CLI command handlers (list, info, health, history, tune, enable/disable)
- `src/resources/extensions/gsd/agent-telemetry.ts` — agent-specific metrics collection
- `src/resources/extensions/gsd/pipeline-runtime.ts` — pipeline execution
- `src/resources/extensions/gsd/pipeline-parser.ts` — pipeline YAML → DAG
- `src/resources/extensions/gsd/component-scaffold.ts` — scaffolding templates
- `src/resources/extensions/gsd/component-commands.ts` — CLI command handlers (list, info, remove, export, import)
- `src/resources/extensions/gsd/skill-wizard.ts` — interactive skill creation wizard
- `src/resources/extensions/gsd/agent-wizard.ts` — interactive agent creation wizard
- `src/resources/extensions/gsd/component-generator.ts` — AI-assisted component generation
- `src/resources/extensions/gsd/session-capture.ts` — session → skill extraction
- `src/resources/extensions/gsd/component-tester.ts` — validation + test runner
- `src/resources/extensions/gsd/component-debug.ts` — introspection and diagnostics
- `src/resources/extensions/gsd/scaffold-templates/` — template directory
  - `skill-language.md` — language-specific skill template
  - `skill-framework.md` — framework patterns template
  - `skill-review.md` — code review skill template
  - `skill-security.md` — security skill template
  - `agent-specialist.md` — specialist agent template
  - `agent-reviewer.md` — reviewer agent template
  - `agent-researcher.md` — researcher agent template
- `src/resources/extensions/gsd/tests/component-*.test.ts` — test suites
- `src/resources/extensions/gsd/tests/skill-wizard.test.ts` — wizard tests
- `src/resources/extensions/gsd/tests/component-generator.test.ts` — generation tests
- `src/resources/extensions/gsd/tests/session-capture.test.ts` — capture tests
- `src/resources/extensions/gsd/tests/agent-router.test.ts` — routing engine tests
- `src/resources/extensions/gsd/tests/agent-team.test.ts` — team orchestration tests
- `src/resources/extensions/gsd/tests/agent-config.test.ts` — config + inheritance tests
- `src/resources/agents/reviewer.md` — new bundled reviewer agent
- `src/resources/agents/debugger.md` — new bundled debugger agent
- `src/resources/agents/planner.md` — new bundled planner agent
- `src/resources/agents/documenter.md` — new bundled documenter agent

### Modified Files
- `src/resources/extensions/gsd/index.ts` — register new commands
- `src/resources/extensions/gsd/skill-discovery.ts` — delegate to new registry
- `src/resources/extensions/gsd/marketplace-discovery.ts` — refactor as RemoteStore backend
- `src/resources/extensions/gsd/plugin-importer.ts` — refactor as registry operations
- `src/resources/extensions/gsd/namespaced-registry.ts` — integrate into ComponentRegistry
- `src/resources/extensions/gsd/namespaced-resolver.ts` — integrate into ComponentResolver
- `src/resources/extensions/gsd/skill-health.ts` — generalize to all component types
- `src/resources/extensions/gsd/skill-telemetry.ts` — generalize to all component types
- `src/resources/extensions/gsd/preferences-types.ts` — add component preferences
- `src/resources/extensions/gsd/auto-dispatch.ts` — pipeline dispatch support
- `packages/pi-coding-agent/src/core/skills.ts` — delegate to component loader
- `src/resources/extensions/subagent/agents.ts` — delegate to component loader, wire agent routing
- `src/resources/extensions/subagent/index.ts` — integrate routing, team dispatch, enhanced config
- `src/resources/agents/scout.md` — upgrade to enhanced format with output contract
- `src/resources/agents/researcher.md` — upgrade with source preferences, citation format
- `src/resources/agents/worker.md` — upgrade with task classification, auto-tool-selection
- `src/resources/agents/javascript-pro.md` — upgrade with framework detection
- `src/resources/agents/typescript-pro.md` — upgrade with strict mode awareness
