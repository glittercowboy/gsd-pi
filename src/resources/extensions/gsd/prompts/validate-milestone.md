You are executing GSD auto-mode.

## UNIT: Validate Milestone {{milestoneId}} ("{{milestoneTitle}}")

## Working Directory

Your working directory is `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

## Your Role in the Pipeline

All slices are done. Before the milestone can be completed, you must validate that the planned work was delivered as specified. Compare the roadmap's success criteria and slice definitions against the actual slice summaries and UAT results. This is a reconciliation gate — catch gaps, regressions, or missing deliverables before the milestone is sealed.

This is remediation round {{remediationRound}}. If this is round 0, this is the first validation pass. If > 0, prior validation found issues and remediation slices were added and executed — verify those remediation slices resolved the issues.

All relevant context has been preloaded below — the roadmap, all slice summaries, UAT results, requirements, decisions, and project context are inlined. Start working immediately without re-reading these files.

{{inlinedContext}}

{{skillActivation}}

## Validation Steps

1. For each **success criterion** in `{{roadmapPath}}`, check whether slice summaries and UAT results provide evidence that it was met. Record pass/fail per criterion.
2. For each **slice** in the roadmap, verify its demo/deliverable claim against its summary. Flag any slice whose summary does not substantiate its claimed output.
3. Check **cross-slice integration points** — do boundary map entries (produces/consumes) align with what was actually built?
4. Check **requirement coverage** — are all active requirements addressed by at least one slice?
5. Determine a verdict:
   - `pass` — all criteria met, all slices delivered, no gaps
   - `needs-attention` — minor gaps that do not block completion (document them)
   - `needs-remediation` — material gaps found; remediation slices must be added to the roadmap

## Persist Validation

**Persist validation results through `gsd_validate_milestone`.** Call it with: `milestoneId`, `verdict`, `remediationRound`, `successCriteriaChecklist`, `sliceDeliveryAudit`, `crossSliceIntegration`, `requirementCoverage`, `verdictRationale`, and `remediationPlan` (if verdict is `needs-remediation`). The tool writes the validation to the DB and renders VALIDATION.md to disk.

If verdict is `needs-remediation`:
- After calling `gsd_validate_milestone`, use `gsd_reassess_roadmap` to add remediation slices. Pass `milestoneId`, a synthetic `completedSliceId` (e.g. "VALIDATION"), `verdict: "roadmap-adjusted"`, `assessment` text, and `sliceChanges` with the new slices in the `added` array. The tool persists the changes to the DB and re-renders ROADMAP.md.
- These remediation slices will be planned and executed before validation re-runs.

**File system safety:** When scanning milestone directories for evidence, use `ls` or `find` to list directory contents first — never pass a directory path (e.g. `tasks/`, `slices/`) directly to the `read` tool. The `read` tool only accepts file paths, not directories.

When done, say: "Milestone {{milestoneId}} validation complete — verdict: <verdict>."
