import type { Api, Model } from "@gsd/pi-ai";
import type { ScopedModel } from "../../../pi-coding-agent-compat.js";
import type { InteractiveModeStateHost } from "../interactive-mode-state.js";

export async function handleModelCommand(host: InteractiveModeStateHost, searchTerm?: string): Promise<void> {
	if (!searchTerm) {
		host.showModelSelector();
		return;
	}

	const model = await findExactModelMatch(host, searchTerm);
	if (model) {
		try {
			await host.session.setModel(model);
			host.footer.invalidate();
			host.updateEditorBorderColor();
			host.showStatus(`Model: ${model.id}`);
			host.checkDaxnutsEasterEgg(model);
		} catch (error) {
			host.showError(error instanceof Error ? error.message : String(error));
		}
		return;
	}

	host.showModelSelector(searchTerm);
}

export async function findExactModelMatch(host: InteractiveModeStateHost, searchTerm: string): Promise<Model<Api> | undefined> {
	const term = searchTerm.trim();
	if (!term) return undefined;

	let targetProvider: string | undefined;
	let targetModelId = "";

	if (term.includes("/")) {
		const parts = term.split("/", 2);
		targetProvider = parts[0]?.trim().toLowerCase();
		targetModelId = parts[1]?.trim().toLowerCase() ?? "";
	} else {
		targetModelId = term.toLowerCase();
	}

	if (!targetModelId) return undefined;

	const models = await getModelCandidates(host);
	const exactMatches = models.filter((item) => {
		const idMatch = item.id.toLowerCase() === targetModelId;
		const providerMatch = !targetProvider || item.provider.toLowerCase() === targetProvider;
		return idMatch && providerMatch;
	});

	return exactMatches.length === 1 ? exactMatches[0] : undefined;
}

export async function getModelCandidates(host: InteractiveModeStateHost): Promise<Model<Api>[]> {
	if (host.session.scopedModels.length > 0) {
		// Filter scoped models by provider auth readiness so callers like
		// findExactModelMatch can't resolve a scoped-but-unconfigured model.
		const registry = host.session.modelRegistry;
		return host.session.scopedModels
			.filter((scoped: ScopedModel) => registry.isProviderRequestReady(scoped.model.provider))
			.map((scoped: ScopedModel) => scoped.model);
	}

	host.session.modelRegistry.refresh();
	try {
		return await host.session.modelRegistry.getAvailable();
	} catch {
		return [];
	}
}

export async function updateAvailableProviderCount(host: InteractiveModeStateHost): Promise<void> {
	const models = await getModelCandidates(host);
	const uniqueProviders = new Set(models.map((m) => m.provider));
	host.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
}
