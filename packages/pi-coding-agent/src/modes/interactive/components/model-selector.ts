import { type Model, modelsAreEqual } from "@gsd/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getEditorKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@gsd/pi-tui";
import type { ModelRegistry } from "../../../core/model-registry.js";
import type { SettingsManager } from "../../../core/settings-manager.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

/** Display names for providers in the model selector UI. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	anthropic: "anthropic-api",
};

export function providerDisplayName(provider: string): string {
	return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

/**
 * A navigable row — either a provider group header or a selectable model entry.
 */
type ListRow =
	| { kind: "header"; provider: string; count: number }
	| { kind: "model"; item: ModelItem };

type ModelScope = "all" | "scoped";

/**
 * Component that renders a grouped model selector with search.
 *
 * Browsing (no search): models are grouped under provider headers.
 *   - Current model's provider is shown first; remaining providers sorted alphabetically.
 *   - Arrow keys navigate all rows; headers are skipped during selection.
 * Searching: reverts to a flat fuzzy-filtered list (same as before), with [provider] badges.
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];

	// Grouped (browse) state
	private groupedRows: ListRow[] = [];
	private modelRowIndices: number[] = []; // indices into groupedRows that are "model" kind
	private selectedGroupIndex: number = 0; // index into groupedRows (can be model or header)

	// Search (flat) state
	private filteredModels: ModelItem[] = [];
	private selectedFlatIndex: number = 0;

	private isSearching: boolean = false;
	private currentModel?: Model<any>;
	private settingsManager: SettingsManager;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		settingsManager: SettingsManager,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRegistry = modelRegistry;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			const hintText = "Only showing models with configured API keys (see README for details)";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			if (this.isSearching) {
				if (this.filteredModels[this.selectedFlatIndex]) {
					this.handleSelect(this.filteredModels[this.selectedFlatIndex].model);
				}
			} else {
				const model = this.getSelectedModel();
				if (model) this.handleSelect(model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.loadModels().then(() => {
			if (initialSearchInput) {
				this.isSearching = true;
				this.filterModels(initialSearchInput);
			} else {
				this.buildGroupedRows();
				this.jumpToCurrentModel();
				this.updateList();
			}
			// Request re-render after models are loaded
			this.tui.requestRender();
		});
	}

	private async loadModels(): Promise<void> {
		let models: ModelItem[];

		// Refresh to pick up any changes to models.json
		this.modelRegistry.refresh();

		// Check for models.json errors
		const loadError = this.modelRegistry.getError();
		if (loadError) {
			this.errorMessage = loadError;
		}

		// Load available models (built-in models still work even if models.json failed)
		try {
			const availableModels = this.modelRegistry.getAvailable();
			models = availableModels.map((model: Model<any>) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
		} catch (error) {
			this.allModels = [];
			this.scopedModelItems = [];
			this.activeModels = [];
			this.filteredModels = [];
			this.groupedRows = [];
			this.modelRowIndices = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
			return;
		}

		this.allModels = this.sortModelsWithinProvider(models);
		this.scopedModelItems = this.sortModelsWithinProvider(
			this.scopedModels.map((scoped) => ({
				provider: scoped.model.provider,
				id: scoped.model.id,
				model: scoped.model,
			})),
		);
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
	}

	/**
	 * Sort models within each provider: current model first, then by name desc.
	 * Provider ordering is handled separately in buildGroupedRows().
	 */
	private sortModelsWithinProvider(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			// Within provider: newest/largest model name first
			const nameCmp = b.model.name.localeCompare(a.model.name);
			if (nameCmp !== 0) return nameCmp;
			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	/**
	 * Build the grouped rows array for browse mode.
	 * Current model's provider comes first; remaining providers sorted alphabetically.
	 */
	private buildGroupedRows(): void {
		// Group models by provider
		const byProvider = new Map<string, ModelItem[]>();
		for (const item of this.activeModels) {
			let group = byProvider.get(item.provider);
			if (!group) {
				group = [];
				byProvider.set(item.provider, group);
			}
			group.push(item);
		}

		// Determine provider order: current model's provider first, rest alphabetically
		const currentProvider = this.currentModel?.provider;
		const providers = Array.from(byProvider.keys()).sort((a, b) => {
			if (a === currentProvider) return -1;
			if (b === currentProvider) return 1;
			return a.localeCompare(b);
		});

		const rows: ListRow[] = [];
		const modelIndices: number[] = [];

		for (const provider of providers) {
			const items = byProvider.get(provider)!;
			rows.push({ kind: "header", provider, count: items.length });
			for (const item of items) {
				modelIndices.push(rows.length);
				rows.push({ kind: "model", item });
			}
		}

		this.groupedRows = rows;
		this.modelRowIndices = modelIndices;
	}

	/**
	 * Move selectedGroupIndex to point at the current model (or first model).
	 */
	private jumpToCurrentModel(): void {
		if (this.groupedRows.length === 0) {
			this.selectedGroupIndex = 0;
			return;
		}
		// Find the current model in grouped rows
		for (let i = 0; i < this.groupedRows.length; i++) {
			const row = this.groupedRows[i];
			if (row.kind === "model" && modelsAreEqual(this.currentModel, row.item.model)) {
				this.selectedGroupIndex = i;
				return;
			}
		}
		// Fall back to first model row
		if (this.modelRowIndices.length > 0) {
			this.selectedGroupIndex = this.modelRowIndices[0];
		}
	}

	/**
	 * Get the currently selected model from grouped or flat state.
	 */
	private getSelectedModel(): Model<any> | undefined {
		if (this.isSearching) {
			return this.filteredModels[this.selectedFlatIndex]?.model;
		}
		const row = this.groupedRows[this.selectedGroupIndex];
		return row?.kind === "model" ? row.item.model : undefined;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("tab", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;

		if (this.isSearching) {
			this.selectedFlatIndex = 0;
			this.filterModels(this.searchInput.getValue());
		} else {
			this.buildGroupedRows();
			this.jumpToCurrentModel();
			this.updateList();
		}

		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(this.activeModels, query, ({ id, provider }) => `${id} ${provider}`)
			: this.activeModels;
		this.selectedFlatIndex = Math.min(this.selectedFlatIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.errorMessage) {
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
			return;
		}

		if (this.isSearching) {
			this.renderFlatList();
		} else {
			this.renderGroupedList();
		}
	}

	/** Flat fuzzy-search results, same as original behaviour */
	private renderFlatList(): void {
		const maxVisible = 10;

		if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			return;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedFlatIndex - Math.floor(maxVisible / 2),
				this.filteredModels.length - maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedFlatIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);

			const ctx = formatTokenCount(item.model.contextWindow);
			const ctxBadge = theme.fg("muted", `${ctx}`);
			const providerBadge = theme.fg("muted", `[${providerDisplayName(item.provider)}]`);
			const checkmark = isCurrent ? theme.fg("success", " ✓") : "";

			let line: string;
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				line = `${prefix}${theme.fg("accent", item.id)} ${ctxBadge} ${providerBadge}${checkmark}`;
			} else {
				line = `  ${item.id} ${ctxBadge} ${providerBadge}${checkmark}`;
			}

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedFlatIndex + 1}/${this.filteredModels.length})`), 0, 0),
			);
		}

		// Detail line for selected model
		const selected = this.filteredModels[this.selectedFlatIndex];
		if (selected) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", `  ${this.modelDetailLine(selected.model)}`), 0, 0));
		}
	}

	/**
	 * Grouped browse view: provider headers + model rows, windowed around selection.
	 * Shows enough rows to fill ~10 visible lines; headers count as one line each.
	 */
	private renderGroupedList(): void {
		const maxVisible = 12;

		if (this.groupedRows.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No models available"), 0, 0));
			return;
		}

		// Window around selectedGroupIndex
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedGroupIndex - Math.floor(maxVisible / 2),
				this.groupedRows.length - maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.groupedRows.length);

		for (let i = startIndex; i < endIndex; i++) {
			const row = this.groupedRows[i];
			if (!row) continue;

			if (row.kind === "header") {
				// Provider group header — always unselectable
				const providerLabel = theme.fg("borderAccent", providerDisplayName(row.provider));
				const count = theme.fg("muted", ` (${row.count})`);
				// Add blank line before header if not the very first visible row
				if (i > startIndex) {
					this.listContainer.addChild(new Text("", 0, 0));
				}
				this.listContainer.addChild(new Text(`  ${providerLabel}${count}`, 0, 0));
			} else {
				// Model row
				const isSelected = i === this.selectedGroupIndex;
				const isCurrent = modelsAreEqual(this.currentModel, row.item.model);

				const ctx = formatTokenCount(row.item.model.contextWindow);
				const ctxBadge = theme.fg("muted", ` ${ctx}`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";

				let line: string;
				if (isSelected) {
					line = `  ${theme.fg("accent", "→")} ${theme.fg("accent", row.item.id)}${ctxBadge}${checkmark}`;
				} else {
					line = `    ${row.item.id}${ctxBadge}${checkmark}`;
				}

				this.listContainer.addChild(new Text(line, 0, 0));
			}
		}

		// Scroll indicator
		if (startIndex > 0 || endIndex < this.groupedRows.length) {
			const modelPos = this.modelRowIndices.indexOf(this.selectedGroupIndex) + 1;
			const totalModels = this.modelRowIndices.length;
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${modelPos}/${totalModels})`), 0, 0),
			);
		}

		// Detail line for selected model
		const selectedModel = this.getSelectedModel();
		if (selectedModel) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  ${this.modelDetailLine(selectedModel)}`), 0, 0),
			);
		}
	}

	private modelDetailLine(m: Model<any>): string {
		return [
			m.name,
			`ctx: ${formatTokenCount(m.contextWindow)}`,
			`out: ${formatTokenCount(m.maxTokens)}`,
			m.reasoning ? "thinking" : "",
			m.input.includes("image") ? "vision" : "",
		]
			.filter(Boolean)
			.join(" · ");
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		// Tab: scope toggle
		if (kb.matches(keyData, "tab")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			return;
		}

		// Navigation keys
		if (kb.matches(keyData, "selectUp")) {
			this.moveUp();
			return;
		}
		if (kb.matches(keyData, "selectDown")) {
			this.moveDown();
			return;
		}

		// Confirm
		if (kb.matches(keyData, "selectConfirm")) {
			const model = this.getSelectedModel();
			if (model) this.handleSelect(model);
			return;
		}

		// Cancel
		if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
			return;
		}

		// Everything else: feed to search input
		const prevQuery = this.searchInput.getValue();
		this.searchInput.handleInput(keyData);
		const newQuery = this.searchInput.getValue();

		if (newQuery !== prevQuery) {
			const entering = !prevQuery && !!newQuery;
			const leaving = !!prevQuery && !newQuery;

			if (entering) {
				// Entering search mode: remember current model position
				this.isSearching = true;
				this.selectedFlatIndex = 0;
			} else if (leaving) {
				// Leaving search mode: return to grouped view, restore position
				this.isSearching = false;
				this.buildGroupedRows();
				this.jumpToCurrentModel();
			}
			if (this.isSearching) {
				this.filterModels(newQuery);
			} else {
				this.updateList();
			}
		}
	}

	/** Move selection up, skipping headers in grouped mode */
	private moveUp(): void {
		if (this.isSearching) {
			if (this.filteredModels.length === 0) return;
			this.selectedFlatIndex =
				this.selectedFlatIndex === 0
					? this.filteredModels.length - 1
					: this.selectedFlatIndex - 1;
			this.updateList();
			return;
		}

		if (this.groupedRows.length === 0) return;
		let next = this.selectedGroupIndex - 1;
		// Wrap
		if (next < 0) next = this.groupedRows.length - 1;
		// Skip headers
		while (next > 0 && this.groupedRows[next]?.kind === "header") {
			next--;
		}
		// If landed on header at 0, wrap to bottom
		if (this.groupedRows[next]?.kind === "header") {
			next = this.groupedRows.length - 1;
		}
		this.selectedGroupIndex = next;
		this.updateList();
	}

	/** Move selection down, skipping headers in grouped mode */
	private moveDown(): void {
		if (this.isSearching) {
			if (this.filteredModels.length === 0) return;
			this.selectedFlatIndex =
				this.selectedFlatIndex === this.filteredModels.length - 1
					? 0
					: this.selectedFlatIndex + 1;
			this.updateList();
			return;
		}

		if (this.groupedRows.length === 0) return;
		let next = this.selectedGroupIndex + 1;
		// Wrap
		if (next >= this.groupedRows.length) next = 0;
		// Skip headers
		while (next < this.groupedRows.length - 1 && this.groupedRows[next]?.kind === "header") {
			next++;
		}
		// If landed on header at end, wrap to first model
		if (this.groupedRows[next]?.kind === "header") {
			next = this.modelRowIndices[0] ?? 0;
		}
		this.selectedGroupIndex = next;
		this.updateList();
	}

	private handleSelect(model: Model<any>): void {
		// Save as new default
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
