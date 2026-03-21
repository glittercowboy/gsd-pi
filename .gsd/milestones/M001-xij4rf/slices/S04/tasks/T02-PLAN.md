---
estimated_steps: 4
estimated_files: 9
skills_used: []
---

# T02: Update manifest, prompts, comments, and docs to use canonical names

**Slice:** S04 — Tool Naming Convention
**Milestone:** M001-xij4rf

## Description

Update all non-code references to use the canonical tool names. This covers the extension manifest, LLM prompt templates, source code comments, test comments, and user-facing documentation. The `CHANGELOG.md` is left as-is (historical). The `docs/troubleshooting.md` mentions both canonical and alias names so users with either version can find it.

## Steps

1. In `extension-manifest.json`, replace the 4 old names in `provides.tools` with canonical names: `gsd_decision_save`, `gsd_requirement_update`, `gsd_summary_save`, `gsd_milestone_generate_id`.
2. In prompt files (`prompts/discuss.md`, `prompts/discuss-headless.md`, `prompts/queue.md`), replace every occurrence of `gsd_generate_milestone_id` with `gsd_milestone_generate_id`. These are the only old-name references in prompts (verified by grep — no other old tool names appear in prompt files).
3. In source comments, update the old-name references:
   - `guided-flow.ts` line 58 comment: `gsd_generate_milestone_id` → `gsd_milestone_generate_id`
   - `guided-flow-queue.ts` line 173 comment: `gsd_generate_milestone_id` → `gsd_milestone_generate_id`
   - `milestone-ids.ts` line 78 comment: `gsd_generate_milestone_id` → `gsd_milestone_generate_id`
   - `tests/gsd-tools.test.ts` line 3 comment: update tool names to canonical forms
   - `tests/milestone-id-reservation.test.ts` line 2 comment: `gsd_generate_milestone_id` → `gsd_milestone_generate_id`
4. In `docs/troubleshooting.md`, update the tool name references to mention canonical names first, with old names noted as aliases: e.g. "`gsd_decision_save` (or its alias `gsd_save_decision`), `gsd_requirement_update`, or `gsd_summary_save`".

## Must-Haves

- [ ] `extension-manifest.json` lists 4 canonical names in `provides.tools`
- [ ] Prompt files use canonical names exclusively
- [ ] Source comments use canonical names
- [ ] `docs/troubleshooting.md` mentions both canonical and alias names
- [ ] `CHANGELOG.md` is NOT modified

## Verification

- `grep -c "gsd_decision_save\|gsd_requirement_update\|gsd_summary_save\|gsd_milestone_generate_id" src/resources/extensions/gsd/extension-manifest.json` returns `4`
- `grep -rn "gsd_save_decision\|gsd_update_requirement\|gsd_save_summary\|gsd_generate_milestone_id" src/resources/extensions/gsd/prompts/ src/resources/extensions/gsd/guided-flow.ts src/resources/extensions/gsd/guided-flow-queue.ts src/resources/extensions/gsd/milestone-ids.ts` returns 0 matches

## Inputs

- `src/resources/extensions/gsd/bootstrap/db-tools.ts` — T01 output with canonical and alias registrations
- `src/resources/extensions/gsd/extension-manifest.json` — current manifest with old tool names
- `src/resources/extensions/gsd/prompts/discuss.md` — prompt template referencing `gsd_generate_milestone_id`
- `src/resources/extensions/gsd/prompts/discuss-headless.md` — prompt template referencing `gsd_generate_milestone_id`
- `src/resources/extensions/gsd/prompts/queue.md` — prompt template referencing `gsd_generate_milestone_id`
- `src/resources/extensions/gsd/guided-flow.ts` — comment referencing old name
- `src/resources/extensions/gsd/guided-flow-queue.ts` — comment referencing old name
- `src/resources/extensions/gsd/milestone-ids.ts` — comment referencing old name
- `docs/troubleshooting.md` — user-facing docs referencing old names

## Expected Output

- `src/resources/extensions/gsd/extension-manifest.json` — updated with canonical names
- `src/resources/extensions/gsd/prompts/discuss.md` — canonical name references
- `src/resources/extensions/gsd/prompts/discuss-headless.md` — canonical name references
- `src/resources/extensions/gsd/prompts/queue.md` — canonical name references
- `src/resources/extensions/gsd/guided-flow.ts` — updated comment
- `src/resources/extensions/gsd/guided-flow-queue.ts` — updated comment
- `src/resources/extensions/gsd/milestone-ids.ts` — updated comment
- `src/resources/extensions/gsd/tests/gsd-tools.test.ts` — updated comment
- `docs/troubleshooting.md` — updated with canonical + alias names

## Observability Impact

- **Manifest alignment:** `extension-manifest.json` now lists canonical tool names, so any tooling that reads the manifest (e.g. extension loaders, CI validation) will see names consistent with the runtime registry.
- **LLM prompt consistency:** Prompt files reference canonical names exclusively, ensuring LLMs call tools by the preferred name and reducing ambiguity in agent logs.
- **Grep diagnostics:** After this task, `grep -rn "gsd_save_decision\|gsd_update_requirement\|gsd_save_summary\|gsd_generate_milestone_id"` across prompts/source returns 0 hits (excluding alias contexts), making old-name detection trivial.
- **Troubleshooting discoverability:** `docs/troubleshooting.md` mentions both canonical and alias forms, so users searching for either name find the relevant section.
