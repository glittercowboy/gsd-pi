# ADR-008 Implementation Plan

**Related ADR:** [ADR-008-gsd-tools-over-mcp-for-provider-parity.md](/Users/jeremymcspadden/Github/gsd-2/docs/ADR-008-gsd-tools-over-mcp-for-provider-parity.md)
**Status:** Draft
**Date:** 2026-04-09

## Objective

Implement the ADR-008 decision by exposing the core GSD workflow tool contract over MCP, then wiring MCP-backed access into provider paths that cannot use the native in-process GSD tool registry directly.

The first usable outcome is:

- a Claude Code-backed execution session can complete a task using canonical GSD tools
- no manual summary-writing fallback is needed
- native provider behavior remains unchanged

## Non-Goals

- Replacing native in-process GSD tools with MCP
- Exporting every historical alias in the first rollout
- Reworking the entire session-oriented MCP server before proving the workflow-tool surface
- Supporting every provider path before Claude Code is working end-to-end

## Constraints

- Native and MCP tool paths must share business logic
- MCP must not bypass write-gate or discussion-gate protections
- Canonical GSD state transitions must remain DB-backed
- Provider capability mismatches must fail early, not degrade silently

## Workstreams

### 1. Shared Handler Extraction

Goal: separate business logic from transport registration.

Targets:

- `src/resources/extensions/gsd/bootstrap/db-tools.ts`
- `src/resources/extensions/gsd/bootstrap/query-tools.ts`
- `src/resources/extensions/gsd/tools/complete-task.ts`
- sibling modules used by planning/summary/validation tools

Deliverables:

- transport-neutral handler entrypoints for the minimum workflow tool set
- thin native registration wrappers that call those handlers
- thin MCP registration wrappers that call those handlers

Exit criteria:

- native tool behavior is unchanged
- no workflow tool logic is duplicated in MCP server code

### 2. Workflow-Tool MCP Surface

Goal: add an MCP server surface for real GSD workflow tools, distinct from the current session/read API.

Preferred first-cut tool set:

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
- `gsd_milestone_status`

Likely files:

- `packages/mcp-server/src/server.ts` or a new sibling server package
- `packages/mcp-server/src/...` supporting modules
- shared tool-definition metadata if needed

Decisions to make during implementation:

- extend existing MCP package vs create `packages/mcp-gsd-tools-server`
- canonical names only vs selected alias export
- single combined server vs separate “session” and “workflow” server modes

Exit criteria:

- MCP tool discovery shows the minimum tool set
- each MCP tool invokes the shared handlers successfully in isolation

### 3. Safety and Policy Parity

Goal: ensure MCP mutations enforce the same rules as native tool calls.

Targets:

- `src/resources/extensions/gsd/bootstrap/write-gate.ts`
- any current tool-call gating hooks tied to native runtime only
- MCP wrapper layer before shared handler invocation

Required protections:

- discussion gate blocking
- queue-mode restrictions
- write-path restrictions
- canonical DB/file rendering order

Exit criteria:

- MCP cannot be used to bypass native write restrictions
- blocked native scenarios remain blocked over MCP

### 4. Claude Code Provider Integration

Goal: attach the GSD workflow-tool MCP surface to Claude Code sessions.

Targets:

- `src/resources/extensions/claude-code-cli/stream-adapter.ts`
- `src/resources/extensions/claude-code-cli/index.ts`

Expected work:

- build a GSD-managed `mcpServers` config for the Claude SDK session
- attach the workflow MCP server only when the session requires GSD tools
- keep current Claude Code streaming behavior intact

Exit criteria:

- Claude Code session can discover the GSD workflow MCP tools
- task execution path can call `gsd_task_complete` successfully

### 5. Capability Detection and Failure Path

Goal: refuse to start tool-dependent workflows when required capabilities are unavailable.

Targets:

- GSD dispatch / auto-mode preflight
- provider selection and routing checks
- user-facing compatibility errors

Required behavior:

- if native GSD tools are available, proceed
- else if GSD workflow MCP tools are available, proceed
- else fail fast with a precise message

Exit criteria:

- no execution prompt is sent that requires unavailable tools
- users with only unsupported capability combinations get a hard error, not a fake fallback

### 6. Prompt and Documentation Alignment

Goal: keep the workflow contract strict while removing transport assumptions from docs and runtime messaging.

Targets:

- `src/resources/extensions/gsd/prompts/execute-task.md`
- related planning/discuss prompts that reference tool availability
- provider and MCP docs

Rules:

- prompts should keep requiring canonical GSD completion/planning tools
- prompts should not imply “native in-process tool only”
- docs should explain native vs MCP-backed fulfillment paths

Exit criteria:

- prompt contract matches runtime reality
- no provider is told to use a tool surface it cannot access

## Phase Plan

## Phase 1: Spike and Handler Extraction

Scope:

- extract shared logic for `gsd_summary_save`, `gsd_task_complete`, and `gsd_milestone_status`
- prove native wrappers still work

Why first:

- these tools are enough to test end-to-end completion semantics without migrating the full catalog

Verification:

- existing native tests still pass
- new unit tests cover shared handler entrypoints directly

## Phase 2: Minimal Workflow MCP Server

Scope:

- expose the three extracted tools over MCP
- ensure discovery schemas are clean and canonical

Verification:

- MCP discovery returns all three tools
- direct MCP calls succeed against a fixture project

## Phase 3: Claude Code End-to-End Proof

Scope:

- wire the minimal workflow MCP server into the Claude SDK session
- run a single execution path that ends with task completion

Verification:

- Claude Code can call `gsd_task_complete`
- summary file, DB state, and plan checkbox update correctly

## Phase 4: Expand to Full Minimum Workflow Set

Scope:

- add planning, slice completion, milestone completion, roadmap reassessment, and gate result tools

Verification:

- discuss/plan/execute/complete lifecycle works over MCP for the supported flow set

## Phase 5: Capability Gating and UX Hardening

Scope:

- add preflight capability checks
- add clear error messaging for unsupported setups

Verification:

- unsupported provider/session combinations fail before execution starts

## Phase 6: Prompt and Doc Cleanup

Scope:

- align prompts and docs with the new transport-neutral contract

Verification:

- prompt references are accurate
- docs describe the supported architecture and limitations

## File-Level Starting Map

High-probability files for the first implementation:

- `src/resources/extensions/gsd/bootstrap/db-tools.ts`
- `src/resources/extensions/gsd/bootstrap/query-tools.ts`
- `src/resources/extensions/gsd/bootstrap/write-gate.ts`
- `src/resources/extensions/gsd/tools/complete-task.ts`
- `src/resources/extensions/claude-code-cli/stream-adapter.ts`
- `src/resources/extensions/claude-code-cli/index.ts`
- `packages/mcp-server/src/server.ts`
- `packages/mcp-server/src/session-manager.ts`
- `packages/mcp-server/README.md`
- `src/resources/extensions/gsd/prompts/execute-task.md`

## Testing Strategy

### Unit

- shared handlers
- MCP wrapper adapters
- gating / capability-check helpers

### Integration

- direct MCP tool invocation against fixture projects
- native tool invocation regression coverage
- Claude Code provider path with MCP attached

### End-to-End

- plan or execute a small fixture task and complete it through canonical GSD tools
- confirm DB row, rendered summary, and plan state stay in sync

## Risks

### Risk 1: Logic Drift

If native and MCP wrappers each evolve their own behavior, parity will collapse quickly.

Mitigation:

- shared handler extraction before broad MCP exposure

### Risk 2: Safety Regression

If MCP becomes a side door around native gating, the architecture is worse than before.

Mitigation:

- centralize or reuse gating checks before shared handler invocation

### Risk 3: Overly Broad First Rollout

Exporting every tool and alias immediately increases scope and test burden.

Mitigation:

- ship a minimal workflow tool set first

### Risk 4: Claude SDK Session Wiring Complexity

Attaching MCP servers dynamically may expose edge cases around cwd, permissions, or subprocess lifecycle.

Mitigation:

- prove a narrow spike with 2-3 tools before expanding

## Exit Criteria for ADR-008

ADR-008 is considered implemented when:

1. Claude Code-backed execution can use canonical GSD workflow tools over MCP.
2. Native provider behavior remains intact.
3. Shared handlers back both native and MCP invocation.
4. Gating and state integrity protections apply equally to MCP mutations.
5. Capability checks prevent prompts from requiring unavailable tools.

## Recommended Next Task

Start with a narrow spike:

1. Extract shared handlers for `gsd_summary_save`, `gsd_task_complete`, and `gsd_milestone_status`.
2. Expose those tools through a minimal workflow MCP server.
3. Attach that MCP server to Claude Code sessions.
4. Prove end-to-end task completion on a fixture project.
