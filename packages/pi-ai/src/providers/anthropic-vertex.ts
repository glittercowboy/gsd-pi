// Lazy-loaded: Anthropic Vertex SDK is imported on first use, not at startup.
// This avoids penalizing users who don't use Anthropic Vertex models.
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { getEnvApiKey } from "../env-api-keys.js";
import type {
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.js";
import {
	type AnthropicOptions,
	mapThinkingLevelToEffort,
	processAnthropicStream,
	supportsAdaptiveThinking,
} from "./anthropic-shared.js";

let _AnthropicVertexClass: typeof AnthropicVertex | undefined;
let _AnthropicSdkClass: typeof Anthropic | undefined;

async function getAnthropicVertexClass(): Promise<typeof AnthropicVertex> {
	if (!_AnthropicVertexClass) {
		const mod = await import("@anthropic-ai/vertex-sdk");
		_AnthropicVertexClass = mod.AnthropicVertex;
	}
	return _AnthropicVertexClass;
}

async function getAnthropicSdkClass(): Promise<typeof Anthropic> {
	if (!_AnthropicSdkClass) {
		const mod = await import("@anthropic-ai/sdk");
		_AnthropicSdkClass = mod.default;
	}
	return _AnthropicSdkClass;
}

function resolveProjectId(): string {
	const projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID
		|| process.env.GOOGLE_CLOUD_PROJECT
		|| process.env.GCLOUD_PROJECT;
	if (!projectId) {
		throw new Error(
			"Anthropic Vertex requires a project ID. Set ANTHROPIC_VERTEX_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or GCLOUD_PROJECT.",
		);
	}
	return projectId;
}

function resolveRegion(): string {
	return process.env.CLOUD_ML_REGION
		|| process.env.GOOGLE_CLOUD_LOCATION
		|| "us-central1";
}

async function createVertexClient(): Promise<AnthropicVertex> {
	const AnthropicVertexClass = await getAnthropicVertexClass();
	const projectId = resolveProjectId();
	const region = resolveRegion();

	return new AnthropicVertexClass({
		projectId,
		region,
	});
}

export const streamAnthropicVertex: StreamFunction<"anthropic-vertex", AnthropicOptions> = (
	model: Model<"anthropic-vertex">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const client = await createVertexClient();
		const AnthropicSdk = await getAnthropicSdkClass();

		processAnthropicStream(stream, {
			// AnthropicVertex extends Anthropic, so this cast is safe
			client: client as unknown as Anthropic,
			model,
			context,
			isOAuthToken: false,
			options,
			AnthropicSdkClass: AnthropicSdk,
		});
	})();

	return stream;
};

export const streamSimpleAnthropicVertex: StreamFunction<"anthropic-vertex", SimpleStreamOptions> = (
	model: Model<"anthropic-vertex">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key found for provider: ${model.provider}. Set ANTHROPIC_VERTEX_PROJECT_ID to use Claude on Vertex AI.`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return streamAnthropicVertex(model, context, { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
	}

	if (supportsAdaptiveThinking(model.id)) {
		const effort = mapThinkingLevelToEffort(options.reasoning, model.id);
		return streamAnthropicVertex(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens || 0,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropicVertex(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	} satisfies AnthropicOptions);
};
