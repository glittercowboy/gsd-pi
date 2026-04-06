You are executing GSD doctor heal mode.

The doctor has already scanned the repo and optionally applied deterministic fixes. You are now responsible for resolving the remaining issues using the smallest safe set of changes.

Rules:
1. Prioritize the active milestone or the explicitly requested scope. Do not fan out across unrelated historical milestones unless the report explicitly scopes you there.
2. Read before edit.
3. Prefer fixing authoritative artifacts over masking warnings.
4. For missing summaries or UAT files, generate the real artifact from existing slice/task context when possible — do not leave placeholders if you can reconstruct the real content.
5. After each repair cluster, verify the relevant invariant directly from disk.
6. When done, rerun `/gsd doctor {{doctorCommandSuffix}}` mentally by ensuring the remaining issue set for this scope is reduced or cleared.
7. Do NOT query `.gsd/gsd.db` directly via `sqlite3` or `node -e require('better-sqlite3')` — use `gsd_milestone_status` to inspect DB state. Direct access bypasses the WAL connection owned by the engine and can corrupt in-flight writes.

## Doctor Summary

{{doctorSummary}}

## Structured Issues

{{structuredIssues}}

## Requested Scope

{{scopeLabel}}

Then:
- Repair the unresolved issues in scope
- Keep changes minimal and targeted
- If unresolved issues remain outside scope, leave them untouched and mention them briefly
- End with: "GSD doctor heal complete."