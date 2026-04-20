# Full Project Workflow

<template_meta>
name: full-project
version: 1
mode: auto-milestone
requires_project: true
artifact_dir: .gsd/
</template_meta>

<purpose>
The complete GSD workflow with full ceremony: roadmap, milestones, slices, tasks,
research, planning, execution, and verification. Use for greenfield projects or
major features that need the full planning apparatus.

This template wraps the existing GSD workflow for registry completeness.
When selected, it routes to the standard /gsd init → /gsd auto pipeline.
</purpose>

<phases>
1. init    — Initialize project, detect stack, create .gsd/
2. discuss — Define requirements, decisions, and architecture
3. plan    — Create roadmap with milestones and slices
4. execute — Execute slices: research → plan → implement → verify per slice
5. verify  — Milestone-level verification and completion
</phases>

<process>

## Routing to Standard GSD

This template is a convenience entry point. When selected via `/gsd start full-project`,
it should route to the standard GSD workflow:

1. If `.gsd/` doesn't exist: Run `/gsd init` to bootstrap the project
2. If `.gsd/` exists but no milestones: Start the discuss phase via `/gsd discuss`
3. If milestones exist: Resume via `/gsd auto` or `/gsd next`

The full GSD workflow protocol is defined in `GSD-WORKFLOW.md` and handles all
phases, state tracking, and agent orchestration.

</process>
