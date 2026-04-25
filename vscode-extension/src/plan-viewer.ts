import * as vscode from "vscode";
import type { GsdClient, AgentEvent } from "./gsd-client.js";

interface PlanStep {
	id: number;
	tool: string;
	description: string;
	status: "pending" | "running" | "done" | "error";
	timestamp: number;
	duration?: number;
}

/**
 * TreeDataProvider that shows a plan-like view of agent tool executions.
 * Displays steps as they happen, showing what the agent is doing and
 * what it has completed — a live execution plan.
 */
export class GsdPlanViewerProvider implements vscode.TreeDataProvider<PlanStep>, vscode.Disposable {
	public static readonly viewId = "gsd-plan";

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private steps: PlanStep[] = [];
	private nextId = 0;
	private runningTools = new Map<string, number>(); // toolUseId -> step id
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly client: GsdClient) {
		this.disposables.push(
			this._onDidChangeTreeData,
			client.onEvent((evt) => this.handleEvent(evt)),
			client.onConnectionChange((connected) => {
				if (!connected) {
					this.steps = [];
					this.runningTools.clear();
					this._onDidChangeTreeData.fire();
				}
			}),
		);
	}

	getTreeItem(step: PlanStep): vscode.TreeItem {
		const icon = stepIcon(step.status);
		const item = new vscode.TreeItem(step.description, vscode.TreeItemCollapsibleState.None);
		item.iconPath = icon;
		item.description = step.duration !== undefined ? `${step.duration}ms` : step.status === "running" ? "running..." : "";

		const time = new Date(step.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
		item.tooltip = `${step.tool}: ${step.description}\nStatus: ${step.status}\nTime: ${time}`;

		return item;
	}

	getChildren(): PlanStep[] {
		return this.steps;
	}

	clear(): void {
		this.steps = [];
		this.runningTools.clear();
		this._onDidChangeTreeData.fire();
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private handleEvent(evt: AgentEvent): void {
		switch (evt.type) {
			case "agent_start": {
				// Don't clear — keep history visible. Add a separator.
				if (this.steps.length > 0) {
					this.steps.push({
						id: this.nextId++,
						tool: "separator",
						description: "--- New Turn ---",
						status: "done",
						timestamp: Date.now(),
					});
				}
				this.steps.push({
					id: this.nextId++,
					tool: "agent",
					description: "Agent started",
					status: "running",
					timestamp: Date.now(),
				});
				this._onDidChangeTreeData.fire();
				break;
			}

			case "agent_end": {
				// Mark the agent step as done
				const agentStep = [...this.steps].reverse().find((s) => s.tool === "agent" && s.status === "running");
				if (agentStep) {
					agentStep.status = "done";
					agentStep.duration = Date.now() - agentStep.timestamp;
					agentStep.description = "Agent finished";
				}
				this._onDidChangeTreeData.fire();
				break;
			}

			case "tool_execution_start": {
				const toolName = String(evt.toolName ?? "");
				const toolInput = (evt.toolInput ?? {}) as Record<string, unknown>;
				const toolUseId = String(evt.toolUseId ?? "");
				const description = describeStep(toolName, toolInput);

				const id = this.nextId++;
				this.steps.push({
					id,
					tool: toolName,
					description,
					status: "running",
					timestamp: Date.now(),
				});

				if (toolUseId) {
					this.runningTools.set(toolUseId, id);
				}

				// Cap at 200 steps
				while (this.steps.length > 200) {
					this.steps.shift();
				}

				this._onDidChangeTreeData.fire();
				break;
			}

			case "tool_execution_end": {
				const toolUseId = String(evt.toolUseId ?? "");
				const stepId = this.runningTools.get(toolUseId);
				if (stepId !== undefined) {
					this.runningTools.delete(toolUseId);
					const step = this.steps.find((s) => s.id === stepId);
					if (step) {
						const isError = evt.error === true || evt.isError === true;
						step.status = isError ? "error" : "done";
						step.duration = Date.now() - step.timestamp;
						this._onDidChangeTreeData.fire();
					}
				}
				break;
			}
		}
	}
}

function stepIcon(status: string): vscode.ThemeIcon {
	switch (status) {
		case "running":
			return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.yellow"));
		case "done":
			return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
		case "error":
			return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
		default:
			return new vscode.ThemeIcon("circle-outline");
	}
}

function describeStep(toolName: string, input: Record<string, unknown>): string {
	switch (toolName) {
		case "Read": {
			const p = String(input.file_path ?? input.path ?? "");
			return `Read ${p.split(/[\\/]/).pop() ?? p}`;
		}
		case "Write": {
			const p = String(input.file_path ?? "");
			return `Write ${p.split(/[\\/]/).pop() ?? p}`;
		}
		case "Edit": {
			const p = String(input.file_path ?? "");
			return `Edit ${p.split(/[\\/]/).pop() ?? p}`;
		}
		case "Bash":
			return `$ ${String(input.command ?? "").slice(0, 50)}`;
		case "Grep":
			return `Grep: ${String(input.pattern ?? "").slice(0, 40)}`;
		case "Glob":
			return `Glob: ${String(input.pattern ?? "").slice(0, 40)}`;
		default:
			return toolName;
	}
}
