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
4. If a subagent failed to write its RESEARCH file, retry it **once** individually
5. If it fails a second time, write a partial RESEARCH file for that slice with a `## BLOCKER` section explaining the failure — do NOT retry again
6. Report which slices completed research and which (if any) needed a blocker note

**Important**: Each failed slice gets exactly one retry. After that, write the blocker and move on. Never retry the same slice more than once.

## Subagent Prompts

{{subagentPrompts}}
