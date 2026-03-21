import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { showInterviewRound, type Question, type RoundResult } from "../shared/tui.js";

export default function createExtension(pi: ExtensionAPI) {
	pi.registerCommand("create-extension", {
		description: "Scaffold a new pi extension with interview-driven context gathering",
		async handler(args, ctx) {
			const inlineName = (typeof args === "string" ? args : "").trim();

			// ── Interview — always runs first ─────────────────────────────────────

			const questions: Question[] = [
				...(!inlineName
					? [
							{
								id: "purpose",
								header: "Purpose",
								question: "What should this extension do?",
								options: [
									{
										label: "Add a custom tool",
										description: "Register a new tool the LLM can call (like gsd_plan, plan_clarify).",
									},
									{
										label: "Add a slash command",
										description: "A /command the user types — runs logic, optionally triggers an agent turn.",
									},
									{
										label: "React to agent events",
										description: "Hook into turn_end, agent_end, tool_call, etc. to observe or intercept.",
									},
									{
										label: "Custom TUI component",
										description: "Render a widget, overlay, dialog, or custom editor in the terminal UI.",
									},
								],
							} satisfies Question,
						]
					: []),
				{
					id: "ui",
					header: "UI",
					question: "Does this extension need any custom UI?",
					options: [
						{
							label: "No UI",
							description: "Pure logic — no dialogs, widgets, or custom rendering needed.",
						},
						{
							label: "Dialogs only",
							description: "Uses built-in ctx.ui.select / ctx.ui.input / ctx.ui.confirm dialogs.",
						},
						{
							label: "Status / widget",
							description: "Shows a persistent status indicator or footer widget.",
						},
						{
							label: "Full custom component",
							description: "Uses ctx.ui.custom() to render a fully bespoke TUI component.",
						},
					],
				},
				{
					id: "events",
					header: "Events",
					question: "Does it need to hook into the agent lifecycle?",
					options: [
						{
							label: "No — standalone",
							description: "Runs only when explicitly invoked — no event listeners needed.",
						},
						{
							label: "Yes — tool_call",
							description: "Intercepts or observes tool calls before or after they run.",
						},
						{
							label: "Yes — turn / session",
							description: "Reacts to turn_end, agent_end, session_start, or similar lifecycle events.",
						},
						{
							label: "Yes — context / prompt",
							description: "Modifies the system prompt or filters messages via context / before_agent_start.",
						},
					],
				},
				{
					id: "persistence",
					header: "State",
					question: "Does this extension need to persist state across sessions?",
					options: [
						{
							label: "No state needed",
							description: "Stateless — each invocation is independent.",
						},
						{
							label: "In-memory only",
							description: "Keeps state while the session is running but doesn't survive restarts.",
						},
						{
							label: "Persisted to session",
							description: "Uses pi.appendEntry() to write state into the session JSONL for resume.",
						},
					],
				},
				{
					id: "complexity",
					header: "Complexity",
					question: "How complex is the implementation?",
					options: [
						{
							label: "Simple — one concern",
							description: "A single tool or command, minimal branching, easy to follow.",
						},
						{
							label: "Moderate — a few parts",
							description: "A command plus an event hook, or a tool with custom rendering.",
						},
						{
							label: "Complex — full extension",
							description: "Multiple tools, commands, events, UI, and state working together.",
						},
					],
				},
			];

			const result: RoundResult = await showInterviewRound(
				questions,
				{
					progress: "New pi extension · Context",
					reviewHeadline: "Review your choices",
					exitHeadline: "Cancel extension creation?",
					exitLabel: "cancel",
				},
				ctx,
			);

			// User hit Esc — bail silently
			if (!result.answers || Object.keys(result.answers).length === 0) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			// ── Resolve name / description ────────────────────────────────────────

			let extensionDescription = inlineName;
			if (!extensionDescription) {
				const purpose = result.answers["purpose"];
				if (purpose) {
					extensionDescription = purpose.notes?.trim()
						? purpose.notes.trim()
						: Array.isArray(purpose.selected) ? purpose.selected[0] : purpose.selected;
				}
			}

			if (!extensionDescription) {
				ctx.ui.notify("No description captured — add details in the notes field next time.", "warning");
				return;
			}

			// ── Build and send the enriched prompt ────────────────────────────────

			sendPrompt(extensionDescription, result, pi);
		},
	});
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function formatAnswers(result: RoundResult): string {
	const lines: string[] = [];

	const purpose = result.answers["purpose"];
	if (purpose?.notes) {
		lines.push(`- **Extension goal (user's words)**: ${purpose.notes}`);
	}

	const ui = result.answers["ui"];
	if (ui) {
		const selected = Array.isArray(ui.selected) ? ui.selected[0] : ui.selected;
		lines.push(`- **UI needs**: ${selected}${ui.notes ? ` — ${ui.notes}` : ""}`);
	}

	const events = result.answers["events"];
	if (events) {
		const selected = Array.isArray(events.selected) ? events.selected[0] : events.selected;
		lines.push(`- **Event hooks**: ${selected}${events.notes ? ` — ${events.notes}` : ""}`);
	}

	const persistence = result.answers["persistence"];
	if (persistence) {
		const selected = Array.isArray(persistence.selected) ? persistence.selected[0] : persistence.selected;
		lines.push(`- **State persistence**: ${selected}${persistence.notes ? ` — ${persistence.notes}` : ""}`);
	}

	const complexity = result.answers["complexity"];
	if (complexity) {
		const selected = Array.isArray(complexity.selected) ? complexity.selected[0] : complexity.selected;
		lines.push(`- **Complexity**: ${selected}${complexity.notes ? ` — ${complexity.notes}` : ""}`);
	}

	return lines.join("\n");
}

function sendPrompt(description: string, result: RoundResult, pi: ExtensionAPI): void {
	const contextSection = `\n## Context gathered from user\n${formatAnswers(result)}\n`;

	// Determine which doc sections to highlight based on answers
	const uiAnswer = result.answers["ui"];
	const uiSelected = uiAnswer
		? (Array.isArray(uiAnswer.selected) ? uiAnswer.selected[0] : uiAnswer.selected)
		: "";

	const eventsAnswer = result.answers["events"];
	const eventsSelected = eventsAnswer
		? (Array.isArray(eventsAnswer.selected) ? eventsAnswer.selected[0] : eventsAnswer.selected)
		: "";

	const persistenceAnswer = result.answers["persistence"];
	const persistenceSelected = persistenceAnswer
		? (Array.isArray(persistenceAnswer.selected) ? persistenceAnswer.selected[0] : persistenceAnswer.selected)
		: "";

	const docHints: string[] = [
		"- `~/.gsd/agent/docs/extending-pi/01-what-are-extensions.md` — capabilities overview",
		"- `~/.gsd/agent/docs/extending-pi/03-getting-started.md` — minimal extension, hot reload",
		"- `~/.gsd/agent/docs/extending-pi/08-extensioncontext-what-you-can-access.md` — ExtensionContext API",
		"- `~/.gsd/agent/docs/extending-pi/09-extensionapi-what-you-can-do.md` — ExtensionAPI: registration, messaging",
		"- `~/.gsd/agent/docs/extending-pi/22-key-rules-gotchas.md` — must-read rules before shipping",
	];

	if (uiSelected.includes("custom component")) {
		docHints.push("- `~/.gsd/agent/docs/extending-pi/12-custom-ui-visual-components.md` — dialogs, widgets, overlays");
		docHints.push("- `~/.gsd/agent/docs/pi-ui-tui/06-ctx-ui-custom-full-custom-components.md` — ctx.ui.custom() API");
		docHints.push("- `~/.gsd/agent/docs/pi-ui-tui/07-built-in-components-the-building-blocks.md` — Text, Box, SelectList");
		docHints.push("- `~/.gsd/agent/docs/pi-ui-tui/09-keyboard-input-how-to-handle-keys.md` — Key, matchesKey");
		docHints.push("- `~/.gsd/agent/docs/pi-ui-tui/10-line-width-the-cardinal-rule.md` — truncation, width rules");
		docHints.push("- `~/.gsd/agent/docs/pi-ui-tui/19-building-a-complete-component-step-by-step.md` — step-by-step guide");
		docHints.push("- `~/.gsd/agent/docs/pi-ui-tui/21-common-mistakes-and-how-to-avoid-them.md` — pitfalls");
	} else if (uiSelected.includes("Dialogs")) {
		docHints.push("- `~/.gsd/agent/docs/pi-ui-tui/04-built-in-dialog-methods.md` — select, confirm, input, editor");
	} else if (uiSelected.includes("Status")) {
		docHints.push("- `~/.gsd/agent/docs/pi-ui-tui/05-persistent-ui-elements.md` — status, widgets, footer, header");
	}

	if (uiSelected.includes("tool") || result.answers["purpose"]) {
		docHints.push("- `~/.gsd/agent/docs/extending-pi/14-custom-rendering-controlling-what-the-user-sees.md` — renderCall / renderResult");
	}

	if (eventsSelected && !eventsSelected.includes("standalone")) {
		docHints.push("- `~/.gsd/agent/docs/extending-pi/07-events-the-nervous-system.md` — all events reference");
	}

	if (eventsSelected.includes("context / prompt")) {
		docHints.push("- `~/.gsd/agent/docs/extending-pi/15-system-prompt-modification.md` — system prompt hooks");
	}

	if (persistenceSelected.includes("session")) {
		docHints.push("- `~/.gsd/agent/docs/extending-pi/13-state-management-persistence.md` — pi.appendEntry, session state");
	}

	const prompt = `Create a new pi extension based on this description:

"${description}"
${contextSection}
## Reference documentation

Before writing any code, read the relevant docs below. They contain the exact APIs, rules, and patterns for building pi extensions — do not guess or rely on general TypeScript knowledge alone.

${docHints.join("\n")}

## Output

Write the complete implementation as a single self-contained extension file:

\`~/.gsd/agent/extensions/<kebab-case-name>.ts\`

Then register it in the main extensions index:

\`~/.gsd/agent/extensions/index.ts\` — import and call the new extension's default export alongside existing ones

## Rules you must follow exactly

- Extension entry point: \`export default function <camelCaseName>(pi: ExtensionAPI): void { ... }\`
- Import type: \`import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@gsd/pi-coding-agent";\`
- \`pi\` is the registration surface — call \`pi.registerCommand\`, \`pi.registerTool\`, \`pi.on\`, \`pi.registerShortcut\` inside the default export
- \`ctx\` (ExtensionCommandContext or ExtensionContext) is passed to handlers and event callbacks — never stored, never assumed available globally
- To send a message to the agent: \`pi.sendUserMessage("...")\` or \`pi.sendMessage({ content, display }, { triggerTurn })\`
- To show UI: \`ctx.ui.notify\`, \`ctx.ui.select\`, \`ctx.ui.input\`, \`ctx.ui.confirm\`, \`ctx.ui.custom\`
- To run shell commands: \`await pi.exec("cmd", ["arg1"])\` — returns \`{ stdout, stderr, exitCode }\`
- Events use \`pi.on("event_name", async (event, ctx) => { ... })\`
- No direct file I/O without \`node:fs\` — import it explicitly if needed
- Read the gotchas file before finalising: \`22-key-rules-gotchas.md\`

After writing the files, run \`/reload\` to load the new extension.`;

	pi.sendUserMessage(prompt);
}
