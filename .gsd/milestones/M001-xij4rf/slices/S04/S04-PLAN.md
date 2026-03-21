# S04: Tool Naming Convention

**Goal:** All 4 GSD database tools follow `gsd_concept_action` naming with backward-compatible aliases for old names.
**Demo:** `registerDbTools()` registers 8 tools (4 canonical + 4 aliases); calling either name for any tool invokes the same execute function; all existing tests pass; prompt files reference canonical names.

## Must-Haves

- The 4 tools are registered under canonical names: `gsd_decision_save`, `gsd_requirement_update`, `gsd_summary_save`, `gsd_milestone_generate_id`
- The 4 old names (`gsd_save_decision`, `gsd_update_requirement`, `gsd_save_summary`, `gsd_generate_milestone_id`) are registered as aliases pointing to the same execute function
- Alias tool descriptions include "(alias for gsd_concept_action)" so the LLM prefers canonical names
- `extension-manifest.json` lists canonical names in `provides.tools`
- Prompt `.md` files reference canonical names
- All existing tests pass unchanged

## Verification

- `npx tsx src/resources/extensions/gsd/tests/tool-naming.test.ts` — new test asserts both canonical and alias names register with identical execute functions
- `npx tsx src/resources/extensions/gsd/tests/gsd-tools.test.ts` — existing DB tool tests still pass
- `grep -c "gsd_decision_save\|gsd_requirement_update\|gsd_summary_save\|gsd_milestone_generate_id" src/resources/extensions/gsd/extension-manifest.json` returns 4
- `grep -rn "gsd_save_decision\|gsd_update_requirement\|gsd_save_summary\|gsd_generate_milestone_id" src/resources/extensions/gsd/prompts/ src/resources/extensions/gsd/guided-flow.ts src/resources/extensions/gsd/guided-flow-queue.ts src/resources/extensions/gsd/milestone-ids.ts docs/troubleshooting.md | grep -v alias | grep -v CHANGELOG` returns only the `docs/troubleshooting.md` mention (which documents both names)

## Tasks

- [x] **T01: Rename tools to canonical names and register backward-compatible aliases** `est:30m`
  - Why: Core change — implements R013 (canonical naming) and R014 (alias continuity) in the tool registration code
  - Files: `src/resources/extensions/gsd/bootstrap/db-tools.ts`, `src/resources/extensions/gsd/tests/tool-naming.test.ts`
  - Do: Extract each tool definition into a const, change `name` to canonical form, update `promptGuidelines` to use new names, add alias registrations with old names and "(alias for ...)" descriptions, write test verifying both names register with same execute function
  - Verify: `npx tsx src/resources/extensions/gsd/tests/tool-naming.test.ts && npx tsx src/resources/extensions/gsd/tests/gsd-tools.test.ts`
  - Done when: 8 tools registered (4 canonical + 4 aliases), both old and new names resolve, existing tests pass

- [x] **T02: Update manifest, prompts, comments, and docs to use canonical names** `est:20m`
  - Why: References across the codebase still use old names — updating them ensures LLM system prompts and developer-facing docs prefer canonical names
  - Files: `src/resources/extensions/gsd/extension-manifest.json`, `src/resources/extensions/gsd/prompts/discuss.md`, `src/resources/extensions/gsd/prompts/discuss-headless.md`, `src/resources/extensions/gsd/prompts/queue.md`, `src/resources/extensions/gsd/guided-flow.ts`, `src/resources/extensions/gsd/guided-flow-queue.ts`, `src/resources/extensions/gsd/milestone-ids.ts`, `src/resources/extensions/gsd/tests/gsd-tools.test.ts`, `docs/troubleshooting.md`
  - Do: Replace old tool names with canonical names in manifest `provides.tools`, prompt `.md` files, source code comments, and test file comments. In `docs/troubleshooting.md`, mention both canonical and alias names. Do NOT change `CHANGELOG.md` (historical).
  - Verify: `grep -c "gsd_decision_save\|gsd_requirement_update\|gsd_summary_save\|gsd_milestone_generate_id" src/resources/extensions/gsd/extension-manifest.json` returns 4 and `grep -rn "gsd_save_decision\|gsd_update_requirement\|gsd_save_summary\|gsd_generate_milestone_id" src/resources/extensions/gsd/prompts/ src/resources/extensions/gsd/guided-flow.ts src/resources/extensions/gsd/guided-flow-queue.ts src/resources/extensions/gsd/milestone-ids.ts` returns 0 matches
  - Done when: All non-historical, non-alias references use canonical names; manifest lists canonical names; grep for old names in prompt/comment files returns zero hits

## Observability / Diagnostics

- **Runtime signals:** `process.stderr.write` lines in each tool's error path now use canonical names (`gsd_decision_save`, `gsd_requirement_update`, `gsd_summary_save`), making log grep patterns consistent with the tool registry.
- **Inspection surface:** `registerDbTools` registers 8 tools. An agent or developer can verify by calling the mock-PI pattern from `tool-naming.test.ts` and checking `pi.tools.length === 8`.
- **Failure visibility:** If alias registration fails (e.g. `registerTool` throws on duplicate names), the error surfaces immediately at extension load time — no silent degradation.
- **Redaction:** No secrets or PII involved in tool naming; no redaction constraints apply.

## Files Likely Touched

- `src/resources/extensions/gsd/bootstrap/db-tools.ts`
- `src/resources/extensions/gsd/tests/tool-naming.test.ts` (new)
- `src/resources/extensions/gsd/extension-manifest.json`
- `src/resources/extensions/gsd/prompts/discuss.md`
- `src/resources/extensions/gsd/prompts/discuss-headless.md`
- `src/resources/extensions/gsd/prompts/queue.md`
- `src/resources/extensions/gsd/guided-flow.ts`
- `src/resources/extensions/gsd/guided-flow-queue.ts`
- `src/resources/extensions/gsd/milestone-ids.ts`
- `src/resources/extensions/gsd/tests/gsd-tools.test.ts`
- `docs/troubleshooting.md`
