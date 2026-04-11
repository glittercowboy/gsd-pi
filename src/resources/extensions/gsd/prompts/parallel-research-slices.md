# Parallel Slice Research

You are dispatching parallel research agents for **{{sliceCount}} slices** in milestone **{{mid}} — {{midTitle}}**.

## Slices to Research

{{sliceList}}

## Mission

Dispatch ALL slices simultaneously using the `subagent` tool in **parallel mode**. Each subagent will independently research its slice and write a RESEARCH file.

## Execution Protocol

1. Call `subagent` with `tasks: [...]` containing one entry per slice below
2. Wait for ALL subagents to complete
3. Verify each slice's RESEARCH file was written (check the `.gsd/{{mid}}/` directory)
4. If any subagent failed to write its RESEARCH file, re-run it individually
5. Report which slices completed research and which (if any) failed

## Subagent Prompts

{{subagentPrompts}}
