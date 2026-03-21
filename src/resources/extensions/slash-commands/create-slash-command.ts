import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { showInterviewRound, type Question, type RoundResult } from "../shared/tui.js";

export default function createSlashCommand(pi: ExtensionAPI) {
	pi.registerCommand("create-slash-command", {
		description: "Generate a new slash command extension from a plain-English description",
		async handler(args, ctx) {
			const inlineDescription = (typeof args === "string" ? args : "").trim();

			// ── Interview — always run, no free-text step first ───────────────────
			//
			// If the user already typed a description as args, we skip the "what
			// should it do?" question and go straight to the behaviour questions.
			// Otherwise it's the first question in the round.

			const questions: Question[] = [
				...(!inlineDescription
					? [
							{
								id: "purpose",
								header: "Purpose",
								question: "What should this slash command do?",
								options: [
									{
										label: "Automate git workflow",
										description: "Commit, branch, diff, stash — anything git-related.",
									},
									{
										label: "Send a crafted prompt",
										description: "Build a rich context prompt and hand it to the LLM.",
									},
									{
										label: "Run a shell task",
										description: "Execute CLI tools (npm, docker, etc.) and show the output.",
									},
									{
										label: "Something else",
										description: "Describe it in the notes field below.",
									},
								],
							} satisfies Question,
						]
					: []),
				{
					id: "trigger",
					header: "Trigger",
					question: "How does this command kick off its work?",
					options: [
						{
							label: "Sends to agent",
							description: "Builds a prompt and hands off to the LLM to do the heavy lifting.",
						},
						{
							label: "Runs shell commands",
							description: "Executes CLI commands directly (git, npm, etc.) without an LLM turn.",
						},
						{
							label: "Shows a UI prompt",
							description: "Pops up a select/input dialog to gather more info, then acts.",
						},
						{
							label: "Mixed — UI then agent",
							description: "Collects some info via a dialog, then sends a crafted prompt to the LLM.",
						},
					],
				},
				{
					id: "output",
					header: "Output",
					question: "How should the command communicate results to the user?",
					options: [
						{
							label: "Agent response",
							description: "The LLM writes the response — the command just triggers the turn.",
						},
						{
							label: "Notification",
							description: "A brief inline notification (success/error/info) — no agent turn.",
						},
						{
							label: "Command output",
							description: "Shows raw shell output or a formatted summary in the chat.",
						},
					],
				},
				{
					id: "args",
					header: "Arguments",
					question: "Does the command take arguments when invoked?",
					options: [
						{
							label: "No args needed",
							description: "Called as just /command-name — gathers everything it needs at runtime.",
						},
						{
							label: "Optional freeform arg",
							description: "User can type /command-name <something>, but it works without it too.",
						},
						{
							label: "Required arg",
							description: "Needs a specific value typed after the name; shows usage if missing.",
						},
					],
				},
				{
					id: "complexity",
					header: "Complexity",
					question: "How complex does the implementation need to be?",
					options: [
						{
							label: "Simple — one action",
							description: "Does one thing in a handful of lines. Easy to follow.",
						},
						{
							label: "Moderate — a few steps",
							description: "Some branching, maybe a shell call or two, a conditional prompt.",
						},
						{
							label: "Complex — multi-step",
							description: "Multiple async steps, error handling, state, or UI interactions.",
						},
					],
				},
			];

			const result: RoundResult = await showInterviewRound(
				questions,
				{
					progress: "New slash command · Context",
					reviewHeadline: "Review your choices",
					exitHeadline: "Cancel command creation?",
					exitLabel: "cancel",
				},
				ctx,
			);

			// User hit Esc with nothing answered — bail silently
			if (!result.answers || Object.keys(result.answers).length === 0) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			// ── Resolve description ───────────────────────────────────────────────

			let description = inlineDescription;
			if (!description) {
				const purpose = result.answers["purpose"];
				if (purpose) {
					const selected = Array.isArray(purpose.selected) ? purpose.selected[0] : purpose.selected;
					description = purpose.notes
						? purpose.notes // prefer their own words from the notes field
						: selected;
				}
			}

			if (!description) {
				ctx.ui.notify("No description captured — add details in the notes field next time.", "warning");
				return;
			}

			// ── Build and send the enriched prompt ────────────────────────────────

			sendPrompt(description, result, pi);
		},
	});
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function formatAnswers(result: RoundResult): string {
	const lines: string[] = [];

	const purpose = result.answers["purpose"];
	if (purpose?.notes) {
		lines.push(`- **Command goal (user's words)**: ${purpose.notes}`);
	}

	const trigger = result.answers["trigger"];
	if (trigger) {
		const selected = Array.isArray(trigger.selected) ? trigger.selected[0] : trigger.selected;
		lines.push(`- **Trigger pattern**: ${selected}${trigger.notes ? ` — ${trigger.notes}` : ""}`);
	}

	const output = result.answers["output"];
	if (output) {
		const selected = Array.isArray(output.selected) ? output.selected[0] : output.selected;
		lines.push(`- **Output style**: ${selected}${output.notes ? ` — ${output.notes}` : ""}`);
	}

	const argsAnswer = result.answers["args"];
	if (argsAnswer) {
		const selected = Array.isArray(argsAnswer.selected) ? argsAnswer.selected[0] : argsAnswer.selected;
		lines.push(`- **Arguments**: ${selected}${argsAnswer.notes ? ` — ${argsAnswer.notes}` : ""}`);
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

	const prompt = `Create a new pi slash command extension based on this description:

"${description}"
${contextSection}
Write the complete file contents for two files:

1. \`~/.gsd/agent/extensions/slash-commands/<name>.ts\` — the command implementation
2. Update \`~/.gsd/agent/extensions/slash-commands/index.ts\` — import and register the new command alongside existing ones

Rules you must follow exactly:
- Command registration: \`pi.registerCommand("name", { description, handler })\`
- Handler signature: \`async handler(args: string, ctx: ExtensionCommandContext)\`
- \`args\` is the raw string typed after the command name (may be empty)
- To send a message to the agent: \`pi.sendUserMessage("...")\` — this triggers an agent turn
- To show a quick notification without triggering a turn: \`ctx.ui.notify("...", "info" | "success" | "error")\`
- To run a shell command: \`await pi.exec("cmd", ["arg1", "arg2"])\` — returns \`{ stdout, stderr, exitCode }\`
- To show a select dialog: \`await ctx.ui.select("prompt", ["Option A", "Option B"])\` — returns the chosen string
- To show a text input dialog: \`await ctx.ui.input("prompt", "placeholder")\` — returns the string or null
- \`pi\` is captured in closure from the outer \`export default function(pi: ExtensionAPI)\` — use it freely inside the handler
- No \`ctx.session\`, no \`ctx.sendMessage\`, no \`args[]\` array — these do not exist
- Import type: \`import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";\`
- Export default: \`export default function <camelCaseName>(pi: ExtensionAPI) { ... }\`

After writing the files, run \`/reload\` to load the new command.`;

	pi.sendUserMessage(prompt);
}
