# Agent Knowledge Index

Use this file as a machine-operational routing table for pi docs and research references.

Rules:

- Read only the specific files relevant to the current task.
- Prefer the primary bundle first.
- Read files in parallel when the task clearly maps to multiple known references.
- Use absolute paths directly with `read`.
- Follow conditional references only when the primary bundle does not answer the question.

## Pi architecture

Use when:

- understanding how pi works end to end
- tracing subsystem relationships
- understanding sessions, compaction, models, tools, or prompt flow
- deciding how to embed pi in a branded app, custom CLI, desktop app, or web product

Read first:

- `/Users/lexchristopherson/.gsd/docs/what-is-pi/01-what-pi-is.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/04-the-architecture-how-everything-fits-together.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/05-the-agent-loop-how-pi-thinks.md`

Read together when relevant:

- `/Users/lexchristopherson/.gsd/docs/what-is-pi/06-tools-how-pi-acts-on-the-world.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/07-sessions-memory-that-branches.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/08-compaction-how-pi-manages-context-limits.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/09-the-customization-stack.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/10-providers-models-multi-model-by-default.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/13-context-files-project-instructions.md`

Follow-up if needed:

- `/Users/lexchristopherson/.gsd/docs/what-is-pi/03-the-four-modes-of-operation.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/11-the-interactive-tui.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/12-the-message-queue-talking-while-pi-thinks.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/14-the-sdk-rpc-embedding-pi.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/15-pi-packages-the-ecosystem.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/16-why-pi-matters-what-makes-it-different.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/17-file-reference-all-documentation.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/18-quick-reference-commands-shortcuts.md`
- `/Users/lexchristopherson/.gsd/docs/what-is-pi/19-building-branded-apps-on-top-of-pi.md`

## Context engineering, hooks, and context flow

Use when:

- understanding how user prompts flow through to the LLM
- working with before_agent_start, context, tool_call, tool_result, input hooks
- injecting, filtering, or transforming LLM context
- understanding message types and what the LLM actually sees
- coordinating multiple extensions
- building mode systems, presets, or context management extensions
- debugging why the LLM does or doesn't see certain information

Read first:

- `/Users/lexchristopherson/.gsd/docs/context-and-hooks/01-the-context-pipeline.md`
- `/Users/lexchristopherson/.gsd/docs/context-and-hooks/02-hook-reference.md`

Read together when relevant:

- `/Users/lexchristopherson/.gsd/docs/context-and-hooks/03-context-injection-patterns.md`
- `/Users/lexchristopherson/.gsd/docs/context-and-hooks/04-message-types-and-llm-visibility.md`
- `/Users/lexchristopherson/.gsd/docs/context-and-hooks/05-inter-extension-communication.md`
- `/Users/lexchristopherson/.gsd/docs/context-and-hooks/06-advanced-patterns-from-source.md`
- `/Users/lexchristopherson/.gsd/docs/context-and-hooks/07-the-system-prompt-anatomy.md`

## Extension development

Use when:

- building or modifying extensions
- adding tools, commands, hooks, renderers, state, or packaging

Read first:

- `/Users/lexchristopherson/.gsd/docs/extending-pi/01-what-are-extensions.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/02-architecture-mental-model.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/03-getting-started.md`

Read together when relevant:

- `/Users/lexchristopherson/.gsd/docs/extending-pi/06-the-extension-lifecycle.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/07-events-the-nervous-system.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/08-extensioncontext-what-you-can-access.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/09-extensionapi-what-you-can-do.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/10-custom-tools-giving-the-llm-new-abilities.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/11-custom-commands-user-facing-actions.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/14-custom-rendering-controlling-what-the-user-sees.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/25-slash-command-subcommand-patterns.md` # for subcommand-style slash command UX via getArgumentCompletions()
- `/Users/lexchristopherson/.gsd/docs/extending-pi/15-system-prompt-modification.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/22-key-rules-gotchas.md`

Follow-up if needed:

- `/Users/lexchristopherson/.gsd/docs/extending-pi/04-extension-locations-discovery.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/05-extension-structure-styles.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/12-custom-ui-visual-components.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/13-state-management-persistence.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/16-compaction-session-control.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/17-model-provider-management.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/18-remote-execution-tool-overrides.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/19-packaging-distribution.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/20-mode-behavior.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/21-error-handling.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/23-file-reference-documentation.md`
- `/Users/lexchristopherson/.gsd/docs/extending-pi/24-file-reference-example-extensions.md`

## Pi UI and TUI

Use when:

- building dialogs, widgets, overlays, custom editors, or UI renderers
- working on TUI layout or display behavior

Read first:

- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/01-the-ui-architecture.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/03-entry-points-how-ui-gets-on-screen.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/22-quick-reference-all-ui-apis.md`

Read together when relevant:

- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/04-built-in-dialog-methods.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/05-persistent-ui-elements.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/06-ctx-ui-custom-full-custom-components.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/07-built-in-components-the-building-blocks.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/12-overlays-floating-modals-and-panels.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/13-custom-editors-replacing-the-input.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/14-tool-rendering-custom-tool-display.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/15-message-rendering-custom-message-display.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/21-common-mistakes-and-how-to-avoid-them.md`

Follow-up if needed:

- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/02-the-component-interface-foundation-of-everything.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/08-high-level-components-from-pi-coding-agent.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/09-keyboard-input-how-to-handle-keys.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/10-line-width-the-cardinal-rule.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/11-theming-colors-and-styles.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/16-performance-caching-and-invalidation.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/17-theme-changes-and-invalidation.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/18-ime-support-the-focusable-interface.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/19-building-a-complete-component-step-by-step.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/20-real-world-patterns-from-examples.md`
- `/Users/lexchristopherson/.gsd/docs/pi-ui-tui/23-file-reference-example-extensions-with-ui.md`

## Building coding agents

Use when:

- designing agent behavior
- improving autonomy, speed, context handling, or decomposition
- solving hard ambiguity, safety, or verification problems

Read first:

- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/01-work-decomposition.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/06-maximizing-agent-autonomy-superpowers.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/11-god-tier-context-engineering.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/12-handling-ambiguity-contradiction.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/26-cross-cutting-themes-where-all-4-models-converge.md`

Read together when relevant:

- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/03-state-machine-context-management.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/04-optimal-storage-for-project-context.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/05-parallelization-strategy.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/07-system-prompt-llm-vs-deterministic-split.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/08-speed-optimization.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/10-top-10-pitfalls-to-avoid.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/17-irreversible-operations-safety-architecture.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/20-error-taxonomy-routing.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/24-security-trust-boundaries.md`

Follow-up if needed:

- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/02-what-to-keep-discard-from-human-engineering.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/09-top-10-tips-for-a-world-class-agent.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/13-long-running-memory-fidelity.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/14-multi-agent-semantic-conflict-resolution.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/15-legacy-code-brownfield-onboarding.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/16-encoding-taste-aesthetics.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/18-the-handoff-problem-agent-human-maintainability.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/19-when-to-scrap-and-start-over.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/21-cost-quality-tradeoff-model-routing.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/22-cross-project-learning-reusable-intelligence.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/23-evolution-across-project-scale.md`
- `/Users/lexchristopherson/.gsd/docs/building-coding-agents/25-designing-for-non-technical-users-vibe-coders.md`

## Pi product docs

Use when:

- the user asks about pi itself, its SDK, extensions, themes, skills, packages, TUI, prompt templates, keybindings, or custom providers

Read first:

- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/README.md`

Read together when relevant:

- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/themes.md`
- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/skills.md`
- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/prompt-templates.md`
- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/tui.md`
- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/keybindings.md`
- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md`
- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/models.md`
- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`

Follow-up if needed:

- `/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/examples`
