You are investigating a reported issue in a GSD debug session.

## Session

- **slug**: {{slug}}
- **mode**: {{mode}}
- **issue**: {{issue}}
- **workingDirectory**: `{{workingDirectory}}`

## Goal

`{{goal}}`

Goal semantics:
- `find_root_cause_only` — identify the root cause and document your findings; do **NOT** apply code changes, patches, or fixes. Your deliverable is a structured root cause analysis.
- `find_and_fix` — identify the root cause **and** apply a targeted, minimal fix. Verify the fix works after applying it.

## Instructions

1. Read `.gsd/debug/sessions/{{slug}}.json` for any prior session context.
2. Investigate the reported issue in `{{workingDirectory}}`.
3. Follow the goal constraint above strictly.
4. When complete, surface a clear summary: what failed, why, and what was done (or what a fix would require for root-cause-only mode).

{{skillActivation}}
