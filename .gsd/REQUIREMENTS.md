# Requirements

This file is the explicit capability and coverage contract for the project.

## Active

### R020 — Sharp-based screenshot resizing
- Class: core-capability
- Status: validated
- Description: constrainScreenshot uses the sharp Node library for image resizing instead of bouncing buffers through page canvas context. Faster, no page dependency.
- Why it matters: The current approach sends full screenshot buffer to the page as base64, creates an Image, draws to canvas, exports, then sends back. This is slow and fragile (depends on working canvas context).
- Source: user
- Primary owning slice: M002/S03
- Supporting slices: M002/S01
- Validation: constrainScreenshot uses sharp(buffer).metadata() and sharp(buffer).resize(). Zero page.evaluate calls in capture.ts. sharp added to root dependencies and extension peerDependencies. Build passes.
- Notes: sharp added as a dependency. API: sharp(buffer).resize(w, h, { fit: 'inside' }).jpeg({ quality }).toBuffer()

### R021 — Opt-in screenshots on navigate
- Class: core-capability
- Status: validated
- Description: browser_navigate does not capture or return a screenshot by default. An explicit parameter (e.g. screenshot: true) opts in to screenshot capture.
- Why it matters: The current always-inline screenshot is a large base64 payload in every navigation response. For many verifications the compact page summary + diff is sufficient. Significant token savings.
- Source: user
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: browser_navigate has screenshot: Type.Optional(Type.Boolean({ default: false })) parameter. Screenshot capture gated with if (params.screenshot). browser_reload unchanged. Build passes.
- Notes: Default is off. The agent can still use browser_screenshot explicitly when visual verification is needed.

### R022 — Form analysis tool (browser_analyze_form)
- Class: core-capability
- Status: validated
- Description: A browser_analyze_form tool that takes a form selector and returns field inventory including: field labels, names, types, required status, current values, validation state, and submit controls.
- Why it matters: A huge percentage of browser tasks are form tasks. Currently the agent needs 3-8 tool calls to analyze a form. This collapses that into one call.
- Source: user
- Primary owning slice: M002/S04
- Supporting slices: M002/S01
- Validation: browser_analyze_form registered (45 tools total), 7-level label resolution (aria-labelledby → aria-label → label[for] → wrapping label → placeholder → title → humanized name), form auto-detection, fieldset grouping, submit button discovery. Verified end-to-end against 12-field test form with diverse label associations. Build passes.
- Notes: Must handle label association via for/id, wrapping label, aria-label, aria-labelledby, and placeholder.

### R023 — Form fill tool (browser_fill_form)
- Class: core-capability
- Status: validated
- Description: A browser_fill_form tool that takes a form selector, a values object mapping field identifiers to values, and an optional submit flag. Maps labels/names/placeholders to inputs and fills them.
- Why it matters: Filling a login form currently takes 3-5 tool calls (find inputs, type email, type password, click submit). This collapses it to one call.
- Source: user
- Primary owning slice: M002/S04
- Supporting slices: M002/S01
- Validation: browser_fill_form registered (45 tools total), 5-strategy field resolution (label exact/loose → name → placeholder → aria-label), type-aware filling via Playwright APIs (fill/selectOption/setChecked), file/hidden skip, ambiguity detection, optional submit, post-fill validation. Verified end-to-end: 10 fields filled correctly, file input skipped, unmatched key reported. Build passes.
- Notes: Returns matched fields, unmatched values, fields skipped, and validation state after fill.

### R024 — Intent-ranked element retrieval (browser_find_best)
- Class: core-capability
- Status: validated
- Description: A browser_find_best tool that takes an intent string (e.g. "submit form", "close dialog", "primary CTA") and returns scored candidates with reasons, using deterministic heuristic ranking.
- Why it matters: The agent frequently needs "which button submits this form?" Currently it does browser_find → gets 15 candidates → reasons about which one. A heuristic ranker cuts a round trip and reduces reasoning tokens.
- Source: user
- Primary owning slice: M002/S05
- Supporting slices: M002/S01
- Validation: 8 intents implemented with 4-dimension scoring (submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation). Each returns up to 5 candidates sorted by score with CSS selectors and reason strings. Intent normalization accepts underscores/spaces/hyphens. Verified via Playwright tests against real HTML pages with differentiated rankings. Build passes, tool count = 47.
- Notes: Deterministic heuristics only. No hidden LLM calls.

### R025 — Semantic action tool (browser_act)
- Class: core-capability
- Status: validated
- Description: A browser_act tool that takes a semantic intent (e.g. "submit the current form", "close the active modal", "click the primary CTA") and executes the obvious action sequence internally.
- Why it matters: Each of these common micro-tasks currently takes 2-4 tool calls. browser_act collapses them into one.
- Source: user
- Primary owning slice: M002/S05
- Supporting slices: M002/S04
- Validation: Resolves top candidate via same scoring engine as browser_find_best. Executes via Playwright locator.click() with getByRole fallback (focus for search_field). Settles via settleAfterActionAdaptive, returns before/after diff. Zero-candidate returns isError:true without throwing. Verified via Playwright test scripts. Build passes, tool count = 47.
- Notes: Builds on browser_find_best for element selection. Bounded — does not loop or retry.

### R026 — Test coverage for new and refactored code
- Class: quality-attribute
- Status: validated
- Description: Test suite covers shared browser-side utilities, settle logic, screenshot resizing, form tools, and intent ranking. Tests verify correctness and guard against regressions.
- Why it matters: A 5000-line file with zero tests is fragile. The refactoring and new features need regression protection.
- Source: user
- Primary owning slice: M002/S06
- Supporting slices: all M002 slices
- Validation: 108 tests (63 unit + 45 integration) passing via `npm run test:browser-tools`. Unit tests cover pure functions, state accessors, EVALUATE_HELPERS_SOURCE validity, constrainScreenshot with sharp. Integration tests cover window.__pi utilities, intent scoring differentiation, and form label resolution — all via Playwright against real DOM.
- Notes: Test what's unit-testable without a running browser (heuristics, scoring, utility functions). Integration tests with Playwright for tools that need a page.

## Validated

### R017 — Consolidated state capture per action
- Class: core-capability
- Status: validated
- Description: The before-state capture, after-state capture, post-action summary, and recent-error check are consolidated into fewer page.evaluate calls per action. Target: ~50-100ms savings per action.
- Why it matters: Every action tool currently runs 3-4 separate page.evaluate calls for state capture. Consolidating them reduces latency on every single browser interaction.
- Source: user
- Primary owning slice: M002/S02
- Supporting slices: M002/S01
- Validation: postActionSummary eliminated from action tools (grep returns 0 in interaction.ts), countOpenDialogs removed from ToolDeps, high-signal tools use single captureCompactPageState + formatCompactStateSummary pattern. Build passes.
- Notes: captureCompactPageState and postActionSummary can likely be merged into a single evaluate.

### R018 — Conditional body text capture
- Class: core-capability
- Status: validated
- Description: Body text capture (includeBodyText: true) is skipped for low-signal actions (scroll, hover, Tab key press) and enabled for high-signal actions (navigate, click, type, submit).
- Why it matters: Capturing 4000 chars of body text on every scroll or hover is wasteful. Conditional capture reduces evaluate overhead for frequent low-signal actions.
- Source: user
- Primary owning slice: M002/S02
- Supporting slices: none
- Validation: grep shows explicit includeBodyText: true for 5 high-signal tools and includeBodyText: false for 4 low-signal tools in interaction.ts. Classification codified in D017. Build passes.
- Notes: Requires classifying each tool as high-signal or low-signal.

### R019 — Faster settle on zero mutations
- Class: core-capability
- Status: validated
- Description: settleAfterActionAdaptive short-circuits with a smaller quiet window when no mutation observer fires in the first 60ms. Target: ~40-80ms savings on zero-mutation actions.
- Why it matters: Many SPA interactions produce no DOM changes. The current settle logic always waits the full quiet window regardless. Short-circuiting saves time on the most common case.
- Source: user
- Primary owning slice: M002/S02
- Supporting slices: none
- Validation: zero_mutation_shortcut settle reason in state.ts type union and settle.ts return path. Combined readSettleState() poll evaluate. 60ms/30ms thresholds codified in D019. Build passes.
- Notes: Track whether any mutation fired at all; if zero after 60ms, use a shorter quiet window.

### R015 — Module decomposition of browser-tools
- Class: quality-attribute
- Status: validated
- Description: The monolithic browser-tools index.ts (~5000 lines) is split into focused modules: shared infrastructure, tool groups, and browser-side utilities. All 43 existing tools continue to work identically.
- Why it matters: A 5000-line file is unmaintainable and makes targeted changes risky. Module boundaries enable safe refactoring and new tool development.
- Source: user
- Primary owning slice: M002/S01
- Supporting slices: none
- Validation: Extension loads via jiti, 43 tools register, browser navigate/snapshot/click work against real page, index.ts is 47-line orchestrator with zero registerTool calls, 9 tool files under tools/.
- Notes: core.js already exists with ~1000 lines of shared utilities. The split extends this pattern.

### R016 — Shared browser-side evaluate utilities
- Class: quality-attribute
- Status: validated
- Description: Common functions duplicated across page.evaluate boundaries (cssPath, simpleHash, isVisible, isEnabled, inferRole, accessibleName) are injected once and referenced from all evaluate callbacks.
- Why it matters: Currently buildRefSnapshot and resolveRefTarget each redeclare ~100 lines of identical utility code. Deduplication reduces payload size, improves maintainability, and ensures consistency.
- Source: user
- Primary owning slice: M002/S01
- Supporting slices: none
- Validation: window.__pi contains all 9 functions, survives navigation, refs.ts has zero inline redeclarations, close/reopen re-injects via addInitScript correctly.
- Notes: Uses context.addInitScript under window.__pi namespace.

### R001 — Secret forecasting during milestone planning
- Class: core-capability
- Status: validated
- Description: When a milestone is planned, the LLM analyzes slices for external service dependencies and writes a secrets manifest listing every predicted API key with setup guidance.
- Why it matters: Without forecasting, auto-mode discovers missing keys mid-execution and blocks for hours waiting for user input.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: plan-milestone.md Secret Forecasting section (line 62) instructs LLM to write manifest. Parser round-trip tested in parsers.test.ts.
- Notes: The plan-milestone prompt has forecasting instructions. The manifest format and parser are implemented and tested.

### R002 — Secrets manifest persisted in .gsd/
- Class: continuity
- Status: validated
- Description: The secrets manifest is a durable markdown file at `.gsd/milestones/M00x/M00x-SECRETS.md` that survives session boundaries and can be re-read by any future unit.
- Why it matters: Collection may happen in a different session than planning. The manifest must persist on disk.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: parseSecretsManifest/formatSecretsManifest round-trip tested (parsers.test.ts), resolveMilestoneFile(base, mid, "SECRETS") resolves path.
- Notes: Parser/formatter implemented in files.ts. Template exists at templates/secrets-manifest.md.

### R003 — Step-by-step guidance per key
- Class: primary-user-loop
- Status: validated
- Description: Each secret in the manifest includes numbered steps for obtaining the key (navigate to dashboard → create project → generate key → copy), a dashboard URL, and a format hint.
- Why it matters: Users shouldn't have to figure out where to find each key. The guidance makes collection self-service.
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: M001/S01
- Validation: collectOneSecret renders numbered dim-styled guidance steps with wrapping (collect-from-manifest.test.ts tests 6-8).
- Notes: Guidance quality is LLM-dependent and best-effort.

### R004 — Summary screen before collection
- Class: primary-user-loop
- Status: validated
- Description: Before collecting secrets one-by-one, show a read-only summary screen listing all needed keys with their status (pending / already set / skipped). Auto-skip keys that already exist in the environment.
- Why it matters: The user needs to see the full picture before entering keys. Already-set keys should not require re-entry.
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: showSecretsSummary() renders read-only ctx.ui.custom screen with status indicators via makeUI().progressItem() (collect-from-manifest.test.ts tests 4-5).
- Notes: Read-only with auto-skip — no interactive deselection.

### R005 — Existing key detection and silent skip
- Class: primary-user-loop
- Status: validated
- Description: Before prompting for a key, check `.env` and `process.env`. If the key already exists, mark it as "already set" in the summary and skip collection.
- Why it matters: Users shouldn't re-enter keys they've already configured. Prevents frustration and errors.
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: getManifestStatus cross-references checkExistingEnvKeys, categorizes env-present keys as existing (manifest-status.test.ts tests 4,7). collectSecretsFromManifest skips them (collect-from-manifest.test.ts tests 1-2).
- Notes: `checkExistingEnvKeys()` implemented in get-secrets-from-user.ts.

### R006 — Smart destination detection
- Class: integration
- Status: validated
- Description: Automatically detect whether secrets should go to .env, Vercel, or Convex based on project file presence (vercel.json → Vercel, convex/ dir → Convex, default → .env).
- Why it matters: Users shouldn't have to specify the destination manually. The system should do the right thing.
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: collectSecretsFromManifest calls detectDestination() for destination inference. applySecrets() routes to dotenv/vercel/convex accordingly.
- Notes: `detectDestination()` implemented in get-secrets-from-user.ts.

### R007 — Auto-mode collection at entry point
- Class: core-capability
- Status: validated
- Description: When the user runs `/gsd auto`, check for a secrets manifest with pending keys. If found, collect them before dispatching the first slice. Collection happens once at the entry point, not as a dispatch unit.
- Why it matters: This is the primary integration point — auto-mode must not start execution with uncollected secrets.
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: M001/S01, M001/S02
- Validation: startAuto() secrets gate at auto.ts:479. auto-secrets-gate.test.ts — 3/3 pass covering null manifest, pending keys, and no-pending-keys paths.
- Notes: Collection at entry point (startAuto), not as a separate unit type in dispatchNextUnit. D001 satisfied.

### R008 — Guided /gsd wizard integration
- Class: core-capability
- Status: validated
- Description: After milestone planning in the guided `/gsd` flow, trigger secret collection if a manifest exists with pending keys.
- Why it matters: Users who plan via the wizard should also get prompted for secrets before auto-mode begins.
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: M001/S01, M001/S02
- Validation: guided-flow.ts calls startAuto() directly (lines 52, 486, 647, 794) — all guided flow paths that start auto-mode inherit the secrets gate.
- Notes: The guided flow dispatches to startAuto after planning. Collection is inherited via the gate.

### R009 — Planning prompts instruct LLM to forecast secrets
- Class: integration
- Status: validated
- Description: The plan-milestone prompt template includes instructions for the LLM to analyze slices for external service dependencies and write the secrets manifest.
- Why it matters: Without prompt instructions, the LLM won't know to forecast secrets.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: plan-milestone.md has Secret Forecasting section at line 62 with instructions to write {{secretsOutputPath}} with H3 sections per key.
- Notes: Implemented in plan-milestone.md.

### R010 — secure_env_collect enhanced with guidance display
- Class: primary-user-loop
- Status: validated
- Description: The secure_env_collect TUI renders multi-line guidance steps above the masked input field on the same page, so the user sees setup instructions while entering the key.
- Why it matters: Without visible guidance, the user has to find keys on their own despite the LLM having generated instructions.
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: collectOneSecret accepts guidance parameter, renders numbered dim-styled lines with wrapTextWithAnsi above masked input (collect-from-manifest.test.ts tests 6-8).
- Notes: The guidance field is rendered in collectOneSecret().

## Deferred

### R011 — Multi-milestone secret forecasting
- Class: core-capability
- Status: deferred
- Description: Forecast secrets across all planned milestones, not just the active one.
- Why it matters: Would provide a complete picture of all secrets needed for the project.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Deferred — single-milestone forecasting is sufficient for now.

### R012 — Secret rotation reminders
- Class: operability
- Status: deferred
- Description: Track secret age and remind users when keys may need rotation.
- Why it matters: Security best practice, but not essential for the core workflow.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Deferred — out of scope for initial release.

### R027 — Browser reuse across sessions
- Class: core-capability
- Status: deferred
- Description: Keep a warm browser instance across rapid successive agent contexts (e.g. GSD auto-mode cycling through tasks) to avoid ~2-3s Chrome cold-start per session.
- Why it matters: Would eliminate Chrome launch latency in auto-mode. But requires inter-process coordination and is architecturally different from within-session optimizations.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Deferred — skip completely per user direction.

## Out of Scope

### R013 — Curated service knowledge base
- Class: anti-feature
- Status: out-of-scope
- Description: A static database of known services with pre-written guidance for each API key.
- Why it matters: Prevents scope creep. LLM-generated guidance is sufficient and stays current without maintenance.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: LLM generates guidance dynamically. A static KB would become stale.

### R014 — Just-in-time collection enhancement
- Class: anti-feature
- Status: out-of-scope
- Description: Detect missing secrets during task execution and collect them inline.
- Why it matters: Prevents scope confusion. The whole point of M001 is proactive collection, not reactive.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Existing secure_env_collect already handles reactive collection. This milestone is about proactive.

### R028 — LLM-powered intent resolution
- Class: anti-feature
- Status: out-of-scope
- Description: Using hidden LLM calls inside browser_find_best or browser_act for intent resolution.
- Why it matters: Prevents unpredictable latency and cost. Intent resolution must be deterministic heuristics only.
- Source: inferred
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: browser_find_best and browser_act use scoring heuristics, not LLM inference.

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | core-capability | validated | M001/S01 | none | plan-milestone.md Secret Forecasting section, parser round-trip tests |
| R002 | continuity | validated | M001/S01 | none | parseSecretsManifest/formatSecretsManifest round-trip tested |
| R003 | primary-user-loop | validated | M001/S02 | M001/S01 | collect-from-manifest.test.ts tests 6-8 |
| R004 | primary-user-loop | validated | M001/S02 | none | collect-from-manifest.test.ts tests 4-5 |
| R005 | primary-user-loop | validated | M001/S02 | none | manifest-status.test.ts tests 4,7; collect-from-manifest.test.ts tests 1-2 |
| R006 | integration | validated | M001/S02 | none | collectSecretsFromManifest calls detectDestination() |
| R007 | core-capability | validated | M001/S03 | M001/S01, M001/S02 | auto-secrets-gate.test.ts 3/3 pass |
| R008 | core-capability | validated | M001/S03 | M001/S01, M001/S02 | guided-flow.ts calls startAuto() at lines 52, 486, 647, 794 |
| R009 | integration | validated | M001/S01 | none | plan-milestone.md Secret Forecasting section line 62 |
| R010 | primary-user-loop | validated | M001/S02 | none | collect-from-manifest.test.ts tests 6-8 |
| R011 | core-capability | deferred | none | none | unmapped |
| R012 | operability | deferred | none | none | unmapped |
| R013 | anti-feature | out-of-scope | none | none | n/a |
| R014 | anti-feature | out-of-scope | none | none | n/a |
| R015 | quality-attribute | validated | M002/S01 | none | jiti load, 43 tools register, slim index, browser spot-check |
| R016 | quality-attribute | validated | M002/S01 | none | window.__pi injection, zero inline redeclarations, survives navigation |
| R017 | core-capability | validated | M002/S02 | M002/S01 | postActionSummary eliminated, countOpenDialogs removed from ToolDeps, consolidated capture pattern |
| R018 | core-capability | validated | M002/S02 | none | explicit includeBodyText true/false per tool signal level, classification in D017 |
| R019 | core-capability | validated | M002/S02 | none | zero_mutation_shortcut settle reason, combined readSettleState poll, 60ms/30ms thresholds in D019 |
| R020 | core-capability | validated | M002/S03 | M002/S01 | sharp-based constrainScreenshot, zero page.evaluate in capture.ts, build passes |
| R021 | core-capability | validated | M002/S03 | none | screenshot param default false, capture gated, browser_reload unchanged, build passes |
| R022 | core-capability | validated | M002/S04 | M002/S01 | 7-level label resolution, form auto-detection, verified against 12-field test form |
| R023 | core-capability | validated | M002/S04 | M002/S01 | 5-strategy field resolution, type-aware fill, verified end-to-end with 10 fields |
| R024 | core-capability | validated | M002/S05 | M002/S01 | 8-intent scoring, Playwright tests, differentiated rankings, build passes |
| R025 | core-capability | validated | M002/S05 | M002/S04 | top candidate execution via Playwright locator, settle + diff, graceful error, build passes |
| R026 | quality-attribute | validated | M002/S06 | all M002 | 108 tests passing via npm run test:browser-tools |
| R027 | core-capability | deferred | none | none | unmapped |
| R028 | anti-feature | out-of-scope | none | none | n/a |

## Coverage Summary

- Active requirements: 0
- Validated requirements: 22
- Deferred requirements: 3
- Out of scope: 3
- Unmapped active requirements: 0
