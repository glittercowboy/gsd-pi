import * as vscode from "vscode";
import type { GsdClient, AgentEvent } from "./gsd-client.js";

interface ActivityItem {
	id: number;
	type: "tool" | "agent";
	label: string;
	detail: string;
	icon: vscode.ThemeIcon;
	timestamp: number;
	duration?: number;
	filePath?: string;
	status: "running" | "success" | "error";
}

const TOOL_ICONS: Record<string, string> = {
	Read: "file",
	Write: "new-file",
	Edit: "edit",
	Bash: "terminal",
	Grep: "search",
	Glob: "file-directory",
	Agent: "organization",
};

function toolSummary(toolName: string, toolInput: Record<string, unknown>): { label: string; filePath?: string } {
	const name = toolName ?? "Unknown";
	switch (name) {
		case "Read": {
			const p = String(toolInput?.file_path ?? toolInput?.path ?? "");
			const short = p.split(/[\\/]/).pop() ?? p;
			return { label: `Read ${short}`, filePath: p || undefined };
		}
		case "Write": {
			const p = String(toolInput?.file_path ?? "");
			const short = p.split(/[\\/]/).pop() ?? p;
			return { label: `Write ${short}`, filePath: p || undefined };
		}
		case "Edit": {
			const p = String(toolInput?.file_path ?? "");
			const short = p.split(/[\\/]/).pop() ?? p;
			return { label: `Edit ${short}`, filePath: p || undefined };
		}
		case "Bash": {
			const cmd = String(toolInput?.command ?? "").slice(0, 60);
			return { label: `Bash: ${cmd}` };
		}
		case "Grep": {
			const pat = String(toolInput?.pattern ?? "").slice(0, 40);
			return { label: `Grep: ${pat}` };
		}
		case "Glob": {
			const pat = String(toolInput?.pattern ?? "").slice(0, 40);
			return { label: `Glob: ${pat}` };
		}
		default:
			return { label: name };
	}
}

/**
 * TreeDataProvider that shows real-time tool executions from the GSD agent.
 * Listens to tool_execution_start/end and agent_start/end events.
 */
export class GsdActivityFeedProvider implements vscode.TreeDataProvider<ActivityItem>, vscode.Disposable {
	public static readonly viewId = "gsd-activity";

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private items: ActivityItem[] = [];
	private nextId = 0;
	private runningTools = new Map<string, number>(); // toolUseId -> item id
	private maxItems: number;
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly client: GsdClient) {
		this.maxItems = vscode.workspace.getConfiguration("gsd").get<number>("activityFeedMaxItems", 100);

		this.disposables.push(
			this._onDidChangeTreeData,
			client.onEvent((evt) => this.handleEvent(evt)),
			client.onConnectionChange((connected) => {
				if (!connected) {
					this.runningTools.clear();
				}
				this._onDidChangeTreeData.fire();
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("gsd.activityFeedMaxItems")) {
					this.maxItems = vscode.workspace.getConfiguration("gsd").get<number>("activityFeedMaxItems", 100);
				}
			}),
		);
	}

	getTreeItem(element: ActivityItem): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		item.iconPath = element.icon;
		item.description = element.duration !== undefined
			? `${element.duration}ms`
			: element.status === "running"
				? "running..."
				: "";
		item.tooltip = `${element.detail}\n${new Date(element.timestamp).toLocaleTimeString()}`;

		if (element.filePath) {
			item.command = {
				command: "vscode.open",
				title: "Open File",
				arguments: [vscode.Uri.file(element.filePath)],
			};
		}

		return item;
	}

	getChildren(): ActivityItem[] {
		// Show newest first
		return [...this.items].reverse();
	}

	clear(): void {
		this.items = [];
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
				this.addItem({
					type: "agent",
					label: "Agent started",
					detail: "Agent began processing",
					icon: new vscode.ThemeIcon("play", new vscode.ThemeColor("testing.iconPassed")),
					status: "running",
				});
				break;
			}
			case "agent_end": {
				this.addItem({
					type: "agent",
					label: "Agent finished",
					detail: "Agent completed processing",
					icon: new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed")),
					status: "success",
				});
				break;
			}
			case "tool_execution_start": {
				const toolName = String(evt.toolName ?? "");
				const toolInput = (evt.toolInput ?? {}) as Record<string, unknown>;
				const toolUseId = String(evt.toolUseId ?? "");
				const { label, filePath } = toolSummary(toolName, toolInput);
				const iconName = TOOL_ICONS[toolName] ?? "tools";

				const id = this.addItem({
					type: "tool",
					label,
					detail: `Tool: ${toolName}`,
					icon: new vscode.ThemeIcon(iconName, new vscode.ThemeColor("charts.yellow")),
					status: "running",
					filePath,
				});

				if (toolUseId) {
					this.runningTools.set(toolUseId, id);
				}
				break;
			}
			case "tool_execution_end": {
				const toolUseId = String(evt.toolUseId ?? "");
				const itemId = this.runningTools.get(toolUseId);
				if (itemId !== undefined) {
					this.runningTools.delete(toolUseId);
					const item = this.items.find((i) => i.id === itemId);
					if (item) {
						const isError = evt.error === true || evt.isError === true;
						item.status = isError ? "error" : "success";
						item.duration = Date.now() - item.timestamp;
						item.icon = new vscode.ThemeIcon(
							isError ? "error" : "check",
							new vscode.ThemeColor(isError ? "testing.iconFailed" : "testing.iconPassed"),
						);
						this._onDidChangeTreeData.fire();
					}
				}
				break;
			}
		}
	}

	private addItem(partial: Omit<ActivityItem, "id" | "timestamp">): number {
		const id = this.nextId++;
		this.items.push({ ...partial, id, timestamp: Date.now() });

		// Evict old items
		while (this.items.length > this.maxItems) {
			this.items.shift();
		}

		this._onDidChangeTreeData.fire();
		return id;
	}
}
