# Quality Gate Evaluation — Parallel Dispatch

**Working directory:** `{{workingDirectory}}`
**Milestone:** {{milestoneId}} — {{milestoneTitle}}
**Slice:** {{sliceId}} — {{sliceTitle}}

## Mission

You are evaluating **quality gates in parallel** for this slice. Each gate is an independent question that must be answered before task execution begins. Use the `subagent` tool to dispatch all gate evaluations simultaneously.

## Slice Plan Context

{{slicePlanContent}}

## Gates to Evaluate

{{gateCount}} gates require evaluation:

{{gateList}}

## Execution Protocol

1. **Dispatch all gates** using `subagent` in parallel mode. Each subagent prompt is provided below.
2. **Wait for all subagents** to complete.
3. **Verify each gate wrote its result** by checking that `gsd_save_gate_result` was called for each gate ID.
4. **Report the batch outcome** — which gates passed, which flagged concerns, and which were omitted as not applicable.

Gate agents may return `verdict: "omitted"` if the gate question is not applicable to this slice (e.g., no auth surface for Q3, no existing requirements touched for Q4). This is expected for simple slices.

## Subagent Prompts

{{subagentPrompts}}
