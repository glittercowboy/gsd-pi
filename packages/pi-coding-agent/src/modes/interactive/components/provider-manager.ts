/**
 * TUI component for managing provider configurations.
 * Shows providers with auth status, discovery support, and model counts.
 */

import {
	Container,
	type Focusable,
	getEditorKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@gsd/pi-tui";
import type { AuthStorage } from "../../../core/auth-storage.js";
import { getDiscoverableProviders } from "../../../core/model-discovery.js";
import type { ModelRegistry } from "../../../core/model-registry.js";
import { theme } from "../theme/theme.js";
import { rawKeyHint } from "./keybinding-hints.js";

interface ProviderInfo {
	name: string;
	hasAuth: boolean;
	supportsDiscovery: boolean;
	modelCount: number;
}

export class ProviderManagerComponent extends Container implements Focusable {
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	private providers: ProviderInfo[] = [];
	private selectedIndex = 0;
	private listContainer: Container;
	private tui: TUI;
	private authStorage: AuthStorage;
	private modelRegistry: ModelRegistry;
	private onDone: () => void;
	private onDiscover: (provider: string) => void;

	constructor(
		tui: TUI,
		authStorage: AuthStorage,
		modelRegistry: ModelRegistry,
		onDone: () => void,
		onDiscover: (provider: string) => void,
	) {
		super();

		this.tui = tui;
		this.authStorage = authStorage;
		this.modelRegistry = modelRegistry;
		this.onDone = onDone;
		this.onDiscover = onDiscover;

		// Header
		this.addChild(new Text(theme.fg("accent", "Provider Manager"), 0, 0));
		this.addChild(new Spacer(1));

		// Hints
		const hints = [
			rawKeyHint("d", "discover"),
			rawKeyHint("r", "remove auth"),
			rawKeyHint("esc", "close"),
		].join("  ");
		this.addChild(new Text(hints, 0, 0));
		this.addChild(new Spacer(1));

		// List
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.loadProviders();
		this.updateList();
	}

	private loadProviders(): void {
		const discoverableSet = new Set(getDiscoverableProviders());
		const allModels = this.modelRegistry.getAll();

		// Group models by provider
		const providerModelCounts = new Map<string, number>();
		for (const model of allModels) {
			providerModelCounts.set(model.provider, (providerModelCounts.get(model.provider) ?? 0) + 1);
		}

		// Build provider list from all known providers
		const providerNames = new Set([
			...providerModelCounts.keys(),
			...discoverableSet,
		]);

		this.providers = Array.from(providerNames)
			.sort()
			.map((name) => ({
				name,
				hasAuth: this.authStorage.hasAuth(name),
				supportsDiscovery: discoverableSet.has(name),
				modelCount: providerModelCounts.get(name) ?? 0,
			}));
	}

	private updateList(): void {
		this.listContainer.clear();

		for (let i = 0; i < this.providers.length; i++) {
			const p = this.providers[i];
			const isSelected = i === this.selectedIndex;

			const authBadge = p.hasAuth ? theme.fg("success", "[auth]") : theme.fg("muted", "[no auth]");
			const discoveryBadge = p.supportsDiscovery ? theme.fg("accent", "[discovery]") : "";
			const countBadge = theme.fg("muted", `(${p.modelCount} models)`);

			const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
			const nameText = isSelected ? theme.fg("accent", p.name) : p.name;

			const parts = [prefix, nameText, " ", authBadge];
			if (discoveryBadge) parts.push(" ", discoveryBadge);
			parts.push(" ", countBadge);

			this.listContainer.addChild(new Text(parts.join(""), 0, 0));
		}

		if (this.providers.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No providers configured"), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(keyData, "selectUp")) {
			if (this.providers.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.providers.length - 1 : this.selectedIndex - 1;
			this.updateList();
			this.tui.requestRender();
		} else if (kb.matches(keyData, "selectDown")) {
			if (this.providers.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.providers.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			this.tui.requestRender();
		} else if (kb.matches(keyData, "selectCancel")) {
			this.onDone();
		} else if (keyData === "d" || keyData === "D") {
			const provider = this.providers[this.selectedIndex];
			if (provider?.supportsDiscovery) {
				this.onDiscover(provider.name);
			}
		} else if (keyData === "r" || keyData === "R") {
			const provider = this.providers[this.selectedIndex];
			if (provider?.hasAuth) {
				this.authStorage.remove(provider.name);
				this.loadProviders();
				this.updateList();
				this.tui.requestRender();
			}
		}
	}
}
