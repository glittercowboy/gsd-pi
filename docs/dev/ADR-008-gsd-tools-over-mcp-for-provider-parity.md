# ADR-008: Expose GSD Workflow Tools Over MCP for Provider Parity

**Status:** Proposed
**Date:** 2026-04-09
**Deciders:** Jeremy McSpadden
**Related:** ADR-004 (capability-aware model routing), ADR-007 (model catalog split and provider API encapsulation), `src/resources/extensions/gsd/bootstrap/db-tools.ts`, `src/resources/extensions/claude-code-cli/stream-adapter.ts`, `packages/mcp-server/src/server.ts`

## Context

GSD currently has two different tool surfaces:

1. **In-process extension tools** registered directly into the runtime via `pi.registerTool(...)`.
2. **An external MCP server** that exposes session orchestration and read-only project inspection.

This split is now creating a real provider compatibility problem.

### What exists today

The core GSD workflow tools are internal extension tools. Examples include:

- `gsd_summary_save`
- `gsd_plan_milestone`
- `gsd_plan_slice`
- `gsd_plan_task`
- `gsd_task_complete` / `gsd_complete_task`
- `gsd_slice_complete`
- `gsd_complete_milestone`
- `gsd_validate_milestone`
- `gsd_replan_slice`
- `gsd_reassess_roadmap`

These are registered in `src/resources/extensions/gsd/bootstrap/db-tools.ts` and related bootstrap files. GSD prompts assume these tools are available during discuss, plan, and execute flows.

Separately, `packages/mcp-server/src/server.ts` exposes a different tool surface:

- session control: `gsd_execute`, `gsd_status`, `gsd_result`, `gsd_cancel`, `gsd_query`, `gsd_resolve_blocker`
- read-only inspection: `gsd_progress`, `gsd_roadmap`, `gsd_history`, `gsd_doctor`, `gsd_captures`, `gsd_knowledge`

That MCP server is useful, but it is **not** a transport for the internal workflow/mutation tools.

### The current failure mode

The Claude Code CLI provider uses the Anthropic Agent SDK through `src/resources/extensions/claude-code-cli/stream-adapter.ts`. That adapter starts a Claude SDK session, but it does not forward the internal GSD tool registry into the SDK session, nor does it attach a GSD MCP server for those tools.

As a result:

- prompts tell the model to call tools like `gsd_complete_task`
- the tools exist in GSD
- but Claude Code sessions do not actually receive those tools

This produces a contract mismatch: the model is required to use tools that are unavailable in that provider path.

### Why this matters

This is not a one-off Claude Code bug. It reveals a deeper architectural issue:

- GSD’s core workflow contract is transport-specific
- prompt authors assume “internal extension tool availability”
- provider integrations do not all share the same execution surface

If GSD wants provider parity, its workflow tools need a transport-neutral exposure model.

## Decision

**Expose the GSD workflow tool contract over MCP as a first-class transport, and make MCP the compatibility layer for providers that cannot directly access the in-process GSD tool registry.**

This means:

1. GSD will keep its existing in-process tool registration for native runtime use.
2. GSD will add an MCP execution surface for the same workflow tools.
3. Both surfaces must call the same underlying business logic.
4. Provider integrations such as Claude Code will use the MCP surface when they cannot access native in-process tools directly.

The decision is explicitly **not** to replace the native tool system with MCP everywhere. MCP is the parity and portability layer, not the only runtime path.

## Decision Details

### 1. One handler layer, multiple transports

GSD tool behavior must not be implemented twice.

The transport-neutral business logic for workflow tools should be shared by:

- native extension tool registration (`pi.registerTool(...)`)
- MCP server tool registration

The MCP server should wrap the same handlers used by `db-tools.ts`, `query-tools.ts`, and related modules. This avoids logic drift and keeps validation, DB writes, file rendering, and recovery behavior consistent.

### 2. Add a workflow-tool MCP surface

GSD will expose the workflow tools required for discuss, planning, execution, and completion over MCP.

Initial minimum set:

- `gsd_summary_save`
- `gsd_decision_save`
- `gsd_plan_milestone`
- `gsd_plan_slice`
- `gsd_plan_task`
- `gsd_task_complete`
- `gsd_slice_complete`
- `gsd_complete_milestone`
- `gsd_validate_milestone`
- `gsd_replan_slice`
- `gsd_reassess_roadmap`
- `gsd_save_gate_result`
- selected read/query tools such as `gsd_milestone_status`

Aliases should be treated conservatively. MCP should prefer canonical names unless compatibility requires exposing aliases.

### 3. Preserve safety semantics

The current GSD safety model includes write gates, discussion gates, queue-mode restrictions, and state integrity guarantees.

Those guarantees must continue to apply when tools are invoked over MCP. In particular:

- MCP must not create a path that bypasses write gating
- MCP mutations must preserve the same DB/file/state invariants as native tools
- provider-specific fallback behavior must not allow manual summary writing in place of canonical completion tools

### 4. Make provider capability checks explicit

Before dispatching a workflow that requires GSD workflow tools, GSD should check whether the selected provider/session can access the required tool surface.

If a provider cannot access either:

- native in-process GSD tools, or
- the GSD MCP workflow tool surface

then GSD must fail early with a clear compatibility error rather than allowing execution to continue in a degraded, state-breaking mode.

### 5. Keep the existing session/read MCP server

The existing MCP server in `packages/mcp-server` remains valid. It serves a different purpose:

- remote session orchestration
- status/result polling
- filesystem-backed project inspection

The new workflow-tool MCP surface is complementary, not a replacement.

## Alternatives Considered

### Alternative A: Reroute away from Claude Code whenever tool-backed execution is needed

This would fix the immediate failure for multi-provider users, but it does not solve provider parity. It also fails completely for users who only have Claude Code configured.

**Rejected** because it treats the symptom, not the architectural gap.

### Alternative B: Hard-fail Claude Code and require another provider

This is a valid short-term guardrail and may still be used before MCP support is complete.

**Rejected as the long-term architecture** because it permanently excludes a supported provider from first-class GSD execution.

### Alternative C: Inject the internal GSD tool registry directly into the Claude Agent SDK without MCP

This would tightly couple GSD’s internal extension runtime to a provider-specific integration path. It would not generalize well to other providers or external tool clients.

**Rejected** because it creates a provider-specific bridge instead of a transport-neutral contract.

### Alternative D: Replace native GSD tools entirely with MCP

This would simplify the conceptual model, but it would force all runtimes through an external protocol boundary even when the native in-process path is faster and already works well.

**Rejected** because MCP is needed for portability, not because the native tool system is flawed.

## Consequences

### Positive

1. **Provider parity improves.** Providers that can consume MCP tools can participate in full GSD workflow execution.
2. **The workflow contract becomes transport-neutral.** Prompts can rely on capabilities rather than a specific runtime implementation detail.
3. **One compatibility story for external clients.** Claude Code, Cursor, and other MCP-capable clients can use the same workflow tool surface.
4. **Better long-term architecture.** Internal tools and external transports converge on shared handlers instead of diverging implementations.

### Negative

1. **Larger surface area to secure and test.** Mutation tools over MCP are higher risk than read-only inspection tools.
2. **Migration complexity.** Tool registration, gating, and handler extraction must be refactored carefully.
3. **Two transport paths must remain aligned.** Native and MCP invocation semantics must stay behaviorally identical.

### Neutral / Tradeoff

The system will now support:

- native in-process tool execution when available
- MCP-backed tool execution when native access is unavailable

That is more complex than a single-path system, but it is the cost of provider portability without sacrificing native runtime quality.

## Migration Plan

### Phase 1: Extract shared handlers

Refactor workflow tools so MCP and native registration can call the same transport-neutral functions.

Priority targets:

- `gsd_summary_save`
- `gsd_task_complete`
- `gsd_plan_milestone`
- `gsd_plan_slice`
- `gsd_plan_task`

### Phase 2: Stand up the workflow-tool MCP server

Add a new MCP surface for workflow tool execution. This may extend the existing MCP package or live as a sibling package, but it must be clearly separated from the current session/read API.

### Phase 3: Port safety enforcement

Move or centralize write gates and related policy checks so MCP mutations cannot bypass the existing safety model.

### Phase 4: Attach MCP workflow tools to Claude Code sessions

Update the Claude Code provider integration to pass a GSD-managed `mcpServers` configuration into the Claude Agent SDK session when required.

### Phase 5: Add provider capability gating

Before tool-dependent flows begin, verify that the active provider can access the required GSD workflow tools via either native registration or MCP.

### Phase 6: Update prompts and docs

Prompt contracts should remain strict about using canonical GSD completion/planning tools, but documentation and runtime messaging must no longer assume that only native in-process tool registration satisfies that contract.

## Validation

Success is defined by all of the following:

1. A Claude Code-backed execution session can complete a task using canonical GSD workflow tools without manual summary writing.
2. Native provider behavior remains unchanged.
3. MCP-invoked workflow tools produce the same DB updates, rendered artifacts, and state transitions as native tool calls.
4. Write-gate and discussion-gate protections still hold under MCP invocation.
5. When required capabilities are unavailable, GSD fails early with a precise compatibility error.

## Scope Notes

This ADR establishes the architectural direction. It does **not** require full MCP exposure of every historical alias or every auxiliary tool in the first implementation.

The first implementation should prioritize the minimum workflow tool set needed to make discuss/plan/execute/complete flows work safely for MCP-capable providers.
