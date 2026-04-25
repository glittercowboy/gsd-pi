# GSD Documentation

Welcome to the GSD documentation. This covers everything from getting started to advanced configuration, auto-mode internals, and extending GSD with the Pi SDK.

## User Documentation

Guides for installing, configuring, and using GSD day-to-day. Located in [`user-docs/`](./user-docs/).

Simplified Chinese translation: [`zh-CN/`](./zh-CN/).

| Guide | Description |
|-------|-------------|
| [Getting Started](./user-docs/getting-started.md) | Installation, first run, and basic usage |
| [Auto Mode](./user-docs/auto-mode.md) | How autonomous execution works — the state machine, crash recovery, and steering |
| [Commands Reference](./user-docs/commands.md) | All commands, keyboard shortcuts, and CLI flags |
| [Remote Questions](./user-docs/remote-questions.md) | Discord and Slack integration for headless auto-mode |
| [Configuration](./user-docs/configuration.md) | Preferences, model selection, git settings, and token profiles |
| [Provider Setup](./user-docs/providers.md) | Step-by-step setup for OpenRouter, Ollama, LM Studio, vLLM, and all supported providers |
| [Custom Models](./user-docs/custom-models.md) | Advanced model configuration — models.json schema, compat flags, overrides |
| [Token Optimization](./user-docs/token-optimization.md) | Token profiles, context compression, complexity routing, and adaptive learning (v2.17) |
| [Dynamic Model Routing](./user-docs/dynamic-model-routing.md) | Complexity-based model selection, cost tables, escalation, and budget pressure (v2.19) |
| [Captures & Triage](./user-docs/captures-triage.md) | Fire-and-forget thought capture during auto-mode with automated triage (v2.19) |
| [Workflow Visualizer](./user-docs/visualizer.md) | Interactive TUI overlay for progress, dependencies, metrics, and timeline (v2.19) |
| [Cost Management](./user-docs/cost-management.md) | Budget ceilings, cost tracking, projections, and enforcement modes |
| [Git Strategy](./user-docs/git-strategy.md) | Worktree isolation, branching model, and merge behavior |
| [Parallel Orchestration](./user-docs/parallel-orchestration.md) | Run multiple milestones simultaneously with worker isolation and coordination |
| [Working in Teams](./user-docs/working-in-teams.md) | Unique milestone IDs, `.gitignore` setup, and shared planning artifacts |
| [Skills](./user-docs/skills.md) | Bundled skills, skill discovery, and custom skill authoring |
| [Migration from v1](./user-docs/migration.md) | Migrating `.planning` directories from the original GSD |
| [Troubleshooting](./user-docs/troubleshooting.md) | Common issues, `/gsd doctor` (real-time visibility v2.40), `/gsd forensics` (full debugger v2.40), and recovery procedures |
| [Web Interface](./user-docs/web-interface.md) | Browser-based project management with `gsd --web` (v2.41) |
| [VS Code Extension](../vscode-extension/README.md) | Chat participant, sidebar dashboard, and RPC integration for VS Code |

## Architecture & Internals

Design documents, ADRs, and internal references. Located in [`dev/`](./dev/).

| Guide | Description |
|-------|-------------|
| [Architecture Overview](./dev/architecture.md) | System design, extension model, state-on-disk, and dispatch pipeline |
| [Native Engine](../native/README.md) | Rust N-API modules for performance-critical operations |
| [ADR-001: Branchless Worktree Architecture](./dev/ADR-001-branchless-worktree-architecture.md) | Decision record for the v2.14 git architecture |
| [ADR-003: Pipeline Simplification](./dev/ADR-003-pipeline-simplification.md) | Research merged into planning, mechanical completion (v2.30) |
| [ADR-004: Capability-Aware Model Routing](./dev/ADR-004-capability-aware-model-routing.md) | Extend routing from tier/cost selection to task-capability matching |
| [ADR-007: Model Catalog Split](./dev/ADR-007-model-catalog-split.md) | Separate model metadata from routing logic for extensibility |
| [ADR-008: GSD Tools over MCP](./dev/ADR-008-gsd-tools-over-mcp-for-provider-parity.md) | Native tools over MCP for provider parity |
| [ADR-008: Implementation Plan](./dev/ADR-008-IMPLEMENTATION-PLAN.md) | Implementation plan for ADR-008 |
| [Context Optimization Opportunities](./dev/pi-context-optimization-opportunities.md) | Analysis of context window usage and optimization strategies |
| [File System Map](./dev/FILE-SYSTEM-MAP.md) | Complete file system reference |
| [CI/CD Pipeline](./dev/ci-cd-pipeline.md) | Continuous integration and deployment pipeline |
| [Frontier Techniques](./dev/FRONTIER-TECHNIQUES.md) | Advanced techniques and research |
| [PRD: Branchless Worktree](./dev/PRD-branchless-worktree-architecture.md) | Product requirements for branchless worktree architecture |
| [Agent Knowledge Index](./dev/agent-knowledge-index.md) | Index of agent knowledge resources |

## Pi SDK Documentation

Guides for the underlying Pi SDK that GSD is built on. Located in [`dev/`](./dev/).

| Guide | Description |
|-------|-------------|
| [What is Pi](./dev/what-is-pi/README.md) | Core concepts — modes, agent loop, sessions, tools, providers |
| [Extending Pi](./dev/extending-pi/README.md) | Building extensions — tools, commands, UI, events, state |
| [Context & Hooks](./dev/context-and-hooks/README.md) | Context pipeline, hook reference, inter-extension communication |
| [Pi UI / TUI](./dev/pi-ui-tui/README.md) | Terminal UI components, theming, keyboard input, rendering |

## Research

| Guide | Description |
|-------|-------------|
| [Building Coding Agents](./dev/building-coding-agents/README.md) | Research notes on agent design — decomposition, context engineering, cost/quality tradeoffs |
| [Proposals](./dev/proposals/) | Feature proposals and workflow definitions |
| [Superpowers](./dev/superpowers/) | Plans and specs for superpower features |
